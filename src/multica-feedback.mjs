import { createHash } from 'node:crypto';
import { multicaIssueUrl } from './multica-links.mjs';

const FEEDBACK_OBJECT = /(?:AIPRO|AI\s*PRO|数字人|数字员工|助手)/i;
const FEEDBACK_INTENT = /(?:bug|故障|异常|问题|整改|改进|意见|建议|功能需求|新功能|反馈)/i;
const DIRECT_FEEDBACK = /(?:反馈|报个|提个).{0,16}(?:bug|故障|异常|问题|整改|意见|建议|需求|功能)/i;

function requiredText(value, name, max = 10_000) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized.slice(0, max);
}

function sourceChannel(context) {
  const configured = String(context?.metadata?.channel || '').trim();
  if (configured) return configured;
  const match = String(context?.chatId || '').match(/^(dingtalk|wecom|wechat):/);
  return match?.[1] || 'feishu';
}

function registrationKey(pending) {
  return createHash('sha256').update([
    sourceChannel(pending.context),
    pending.context.chatId,
    pending.sourceMessageId,
  ].join('\0')).digest('hex').slice(0, 32);
}

function feedbackKind(text) {
  if (/bug|故障|异常|问题/i.test(text)) return 'Bug';
  if (/整改|改进|意见|建议/i.test(text)) return '整改意见';
  return '功能需求';
}

function feedbackTitle(text) {
  const clean = String(text || '')
    .replace(/^(?:给|向)?\s*(?:AIPRO|AI\s*PRO|数字人|数字员工|助手)\s*/i, '')
    .replace(/^(?:反馈|提个|报个|有个|的)?\s*(?:bug|问题|需求)?\s*[:：-]?\s*/i, '')
    .trim();
  return `[AIPRO ${feedbackKind(text)}] ${(clean || text).slice(0, 120)}`;
}

function feedbackDescription(pending, clarification, key) {
  const channel = sourceChannel(pending.context);
  return [
    '由 AIPRO IM 受控反馈登记流程创建。',
    '',
    `来源渠道：${channel}`,
    `原会话：${pending.context.chatId}`,
    `来源发送者：${pending.context.senderId}`,
    `来源消息：${pending.sourceMessageId}`,
    `反馈人权限：${pending.ownerAuthorized ? 'Owner' : '非 Owner'}`,
    `AIPRO-FEEDBACK-ID: ${key}`,
    '',
    `原始需求：${pending.originalRequest}`,
    `补充说明：${clarification}`,
    `验收标准：${clarification}`,
    '',
    pending.ownerAuthorized
      ? '执行策略：Owner 反馈；创建后由安全派发 outbox 指派 Squad。'
      : '执行策略：仅登记为未指派 backlog；禁止自动派发或执行。',
  ].join('\n');
}

function sameContext(expected, actual) {
  return String(expected?.chatId || '') === String(actual?.chatId || '')
    && String(expected?.senderId || '') === String(actual?.senderId || '');
}

function decorateIssue(issue, workspace) {
  return {
    ...issue,
    workspace_id: issue.workspace_id || workspace.id,
    workspace_name: issue.workspace_name || workspace.name,
    workspace_slug: issue.workspace_slug || workspace.slug,
  };
}

export function looksLikeMulticaFeedback(value) {
  const text = String(value || '').trim();
  return Boolean(text && ((FEEDBACK_OBJECT.test(text) && FEEDBACK_INTENT.test(text))
    || DIRECT_FEEDBACK.test(text)));
}

export function feedbackClarificationQuestion() {
  return '为了准确登记，这个问题处理完成后，你希望看到什么结果或如何判断已经解决？回复验收标准即可；不想继续可回复“取消”。';
}

export function isFeedbackCancellation(value) {
  return /^(?:取消|不用了|不登记了|不用登记了|放弃)[。！! ]*$/.test(String(value || '').trim());
}

export class MulticaFeedbackWorkflow {
  constructor({
    client,
    state,
    workspaceId,
    ownerSquad,
    appUrl,
    audit = () => {},
    maxDispatchAttempts = 10,
  }) {
    this.client = client;
    this.state = state;
    this.workspaceId = String(workspaceId || '').trim();
    this.ownerSquad = String(ownerSquad || '').trim();
    this.appUrl = appUrl;
    this.audit = audit;
    this.maxDispatchAttempts = Math.max(1, Math.min(50, Number(maxDispatchAttempts) || 10));
  }

  begin({ text, sourceMessageId, context, ownerAuthorized = false }) {
    const originalRequest = requiredText(text, 'Original feedback', 10_000);
    const messageId = requiredText(sourceMessageId, 'Source message ID', 500);
    if (!context?.chatId || !context?.senderId) {
      throw new Error('Feedback IM context is required');
    }
    const pending = {
      originalRequest,
      sourceMessageId: messageId,
      ownerAuthorized: ownerAuthorized === true,
      context: {
        chatId: String(context.chatId),
        senderId: String(context.senderId),
        chatType: String(context.chatType || ''),
        metadata: structuredClone(context.metadata || {}),
      },
    };
    this.audit('multica_feedback_clarification_requested', {
      sourceMessageId: messageId,
      chatId: pending.context.chatId,
      ownerAuthorized: pending.ownerAuthorized,
    });
    return { kind: 'clarification', text: feedbackClarificationQuestion(), pending };
  }

  async workspace() {
    if (!this.workspaceId) throw new Error('Multica feedback workspace is not configured');
    const workspaces = await this.client.listWorkspaces();
    const workspace = workspaces.find(item => item.id === this.workspaceId);
    if (!workspace) throw new Error('Multica feedback workspace is unavailable');
    return workspace;
  }

  cacheAndFollow(issue, context) {
    this.state.upsertMulticaIssue(issue);
    this.state.subscribeMulticaIssue(issue.id, context.chatId, context.senderId, {
      chatType: context.chatType,
    });
  }

  async findOrCreate(pending, clarification, workspace, key) {
    const stored = this.state.getMulticaFeedbackRegistration(key);
    if (stored?.issue) return { issue: stored.issue, replayed: true };

    const marker = `AIPRO-FEEDBACK-ID: ${key}`;
    const matches = await this.client.searchIssues(marker, { workspaces: [workspace] });
    let issue = matches.find(item => String(item.description || '').includes(marker));
    let replayed = Boolean(issue);
    if (!issue) {
      issue = await this.client.createIssue({
        workspaceId: workspace.id,
        title: feedbackTitle(pending.originalRequest),
        description: feedbackDescription(pending, clarification, key),
        status: 'backlog',
        priority: 'none',
      });
      replayed = false;
    }
    const decorated = decorateIssue(issue, workspace);
    this.state.bindMulticaFeedbackRegistration({ registrationKey: key, issue: decorated });
    return { issue: decorated, replayed };
  }

  async register(pending, clarificationValue, {
    context,
    now = new Date(),
  } = {}) {
    if (!sameContext(pending?.context, context)) {
      throw new Error('Feedback confirmation context does not match the original request');
    }
    const clarification = requiredText(clarificationValue, 'Feedback clarification', 10_000);
    const workspace = await this.workspace();
    const key = registrationKey(pending);
    const { issue, replayed } = await this.findOrCreate(
      pending,
      clarification,
      workspace,
      key,
    );
    this.cacheAndFollow(issue, pending.context);
    this.audit(replayed ? 'multica_feedback_registration_replayed' : 'multica_feedback_registered', {
      registrationKey: key,
      issueId: issue.id,
      identifier: issue.identifier,
      ownerAuthorized: pending.ownerAuthorized,
    });

    let ownerDispatched = false;
    let dispatchPending = false;
    if (pending.ownerAuthorized) {
      if (!this.ownerSquad) throw new Error('Multica Owner Squad is not configured');
      this.state.enqueueMulticaDispatch({
        issueId: issue.id,
        workspaceId: issue.workspace_id,
        assignee: this.ownerSquad,
        availableAt: now.toISOString(),
      });
      const delivery = await this.deliverDispatches(now);
      ownerDispatched = delivery.dispatched > 0;
      dispatchPending = !ownerDispatched;
    }

    const link = multicaIssueUrl(issue, this.appUrl);
    const text = pending.ownerAuthorized
      ? ownerDispatched
        ? `反馈已登记并派发：${issue.identifier}\n负责人：${this.ownerSquad}`
        : `反馈已登记：${issue.identifier}\nIssue 保持未指派 backlog；派发待重试，不会提前执行。`
      : `反馈已登记：${issue.identifier}\n状态：backlog（未指派，不会自动执行）`;
    return {
      issue,
      replayed,
      ownerDispatched,
      dispatchPending,
      text: text + (link ? `\n查看：${link}` : ''),
    };
  }

  async deliverDispatches(now = new Date()) {
    let dispatched = 0;
    let failed = 0;
    let dead = 0;
    for (const item of this.state.listDueMulticaDispatches(now.toISOString(), 100)) {
      try {
        const issue = await this.client.updateIssue(item.issueId, {
          workspaceId: item.workspaceId,
          assignee: item.assignee,
          status: 'todo',
        });
        this.state.completeMulticaDispatch(item.issueId);
        dispatched += 1;
        this.audit('multica_feedback_dispatched', {
          issueId: item.issueId,
          identifier: issue.identifier || '',
          assignee: item.assignee,
          attempts: item.attempts,
        });
      } catch (error) {
        failed += 1;
        const delayMs = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(item.attempts, 8)));
        const failure = this.state.failMulticaDispatch(
          item.issueId,
          error?.message || error,
          new Date(now.getTime() + delayMs).toISOString(),
          this.maxDispatchAttempts,
        );
        if (failure.deadLettered) dead += 1;
        this.audit(failure.deadLettered
          ? 'multica_feedback_dispatch_dead_lettered'
          : 'multica_feedback_dispatch_failed', {
          issueId: item.issueId,
          assignee: item.assignee,
          attempts: failure.attempts,
          error: String(error?.message || error).slice(0, 500),
        });
      }
    }
    return {
      dispatched,
      failed,
      dead,
      pending: this.state.multicaDispatchPendingCount(),
    };
  }
}
