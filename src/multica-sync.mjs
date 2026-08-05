import { createHash } from 'node:crypto';
import { multicaIssueUrl } from './multica-links.mjs';

const STATUS_LABELS = {
  backlog: '需求池',
  todo: '待处理',
  in_progress: '进行中',
  in_review: '评审中',
  done: '已完成',
  blocked: '受阻',
  cancelled: '已取消',
};
const PRIORITY_LABELS = {
  none: '无',
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
};
const FIELD_LABELS = {
  title: '标题',
  description: '描述',
  status: '状态',
  priority: '优先级',
  assignee_id: '负责人',
  assignee_type: '负责人类型',
  project_id: '项目',
  parent_issue_id: '父 Issue',
  start_date: '开始日期',
  due_date: '截止日期',
};

function fieldValue(field, value) {
  if (field === 'status') return STATUS_LABELS[value] || value || '未设置';
  if (field === 'priority') return PRIORITY_LABELS[value] || value || '未设置';
  if (field === 'description') return value ? '已更新' : '已清空';
  return String(value || '未设置');
}

function truncate(value, maxLength = 1800) {
  const text = String(value || '').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function firstStructuredValue(description, labels) {
  const lines = String(description || '').split(/\r?\n/);
  for (const line of lines) {
    const normalized = line.trim().replace(/^[-*]\s*/, '');
    for (const label of labels) {
      const prefix = `${label}：`;
      const asciiPrefix = `${label}:`;
      if (normalized.startsWith(prefix)) return normalized.slice(prefix.length).trim();
      if (normalized.startsWith(asciiPrefix)) return normalized.slice(asciiPrefix.length).trim();
    }
  }
  return '';
}

function firstDescriptionParagraph(description) {
  return String(description || '')
    .split(/\n\s*\n/)
    .map(item => item.replace(/^#+\s*/, '').trim())
    .find(Boolean) || '';
}

function issueProvenance(issue) {
  const description = String(issue.description || '');
  const metadata = issue.metadata && typeof issue.metadata === 'object'
    ? issue.metadata
    : {};
  const purpose = issue.purpose
    || metadata.purpose
    || firstStructuredValue(description, ['原始需求', '用户需求', '目标', '目的', '需求'])
    || firstDescriptionParagraph(description)
    || 'Multica 未记录具体内容';
  const reason = issue.reason
    || metadata.reason
    || firstStructuredValue(description, ['补充说明', '提出原因', '原因', '背景'])
    || 'Multica 未单独记录提出原因';
  const proposer = issue.requester_name
    || issue.reporter_name
    || issue.creator_name
    || metadata.requester_name
    || metadata.reporter_name
    || firstStructuredValue(description, ['来源发送者', '提出人', '发起人', '反馈人'])
    || (issue.creator_id
      ? `${issue.creator_type === 'agent' ? 'Multica Agent' : 'Multica 成员'}（${issue.creator_id}）`
      : 'Multica 未记录提出人');
  const source = issue.source_channel
    || metadata.source_channel
    || metadata.channel
    || firstStructuredValue(description, ['来源渠道', '来源平台'])
    || `Multica${issue.creator_type ? `（${issue.creator_type} 创建）` : ''}`;
  return {
    purpose: truncate(purpose, 700),
    reason: truncate(reason, 700),
    proposer: truncate(proposer, 300),
    source: truncate(source, 200),
    description: truncate(description, 1800),
  };
}

function uniqueRecipients(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.chatId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizedChannel(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return '';
  if (['feishu', 'lark', '飞书'].includes(text)) return 'feishu';
  if (['dingtalk', 'ding', '钉钉'].includes(text)) return 'dingtalk';
  if (['wecom', 'work-wechat', '企业微信'].includes(text)) return 'wecom';
  if (['wechat', '微信'].includes(text)) return 'wechat';
  return '';
}

function recipientChannel(recipient) {
  const explicit = normalizedChannel(recipient?.channel);
  if (explicit) return explicit;
  for (const value of [recipient?.chatId, recipient?.senderId]) {
    const match = String(value || '').match(/^(dingtalk|wecom|wechat):/i);
    if (match) return match[1].toLowerCase();
  }
  return recipient?.chatId ? 'feishu' : '';
}

function declaredIssueChannel(issue) {
  const metadata = issue?.metadata && typeof issue.metadata === 'object'
    ? issue.metadata
    : {};
  for (const value of [
    issue?.source_channel,
    metadata.source_channel,
    metadata.channel,
    firstStructuredValue(issue?.description, ['来源渠道', '来源平台']),
  ]) {
    const channel = normalizedChannel(value);
    if (channel) return channel;
  }
  return '';
}

function channelBoundRecipients({
  issue,
  origin,
  issueSubscribers,
  globalSubscribers,
  ownerRecipient,
}) {
  const normalizedOrigin = origin?.chatId ? {
    ...origin,
    channel: recipientChannel(origin),
  } : null;
  const normalizedIssueSubscribers = issueSubscribers.map(item => ({
    ...item,
    channel: recipientChannel(item),
  }));
  const normalizedGlobalSubscribers = globalSubscribers.map(item => ({
    ...item,
    channel: recipientChannel(item),
  }));
  const normalizedOwner = ownerRecipient ? {
    ...ownerRecipient,
    channel: recipientChannel(ownerRecipient),
  } : null;
  const channel = normalizedOrigin?.channel
    || declaredIssueChannel(issue)
    || normalizedIssueSubscribers.find(item => item.channel)?.channel
    || normalizedOwner?.channel
    || normalizedGlobalSubscribers.find(item => item.channel)?.channel
    || '';
  return {
    channel,
    recipients: uniqueRecipients([
      ...(normalizedOrigin ? [normalizedOrigin] : []),
      ...normalizedIssueSubscribers,
      ...normalizedGlobalSubscribers,
      ...(normalizedOwner ? [normalizedOwner] : []),
    ].filter(item => !channel || item.channel === channel)),
  };
}

function notificationKey(issue, chatId) {
  const digest = createHash('sha256')
    .update(`${issue.id}\0${issue.updated_at || ''}\0${chatId}`)
    .digest('hex')
    .slice(0, 18);
  return `multica-sync-${digest}`;
}

export function formatMulticaChange(change, { appUrl, detailed = false } = {}) {
  const issue = change.after;
  const link = multicaIssueUrl(issue, appUrl);
  const workspace = issue.workspace_name ? ` · ${issue.workspace_name}` : '';
  const provenance = detailed ? issueProvenance(issue) : null;
  if (change.isNew) {
    return [
      `Multica 新 Issue：${issue.identifier}${workspace}`,
      ...(detailed ? [
        `标题：${issue.title || '未命名 Issue'}`,
        `做什么：${provenance.purpose}`,
        `为什么：${provenance.reason}`,
        `谁提出：${provenance.proposer}`,
        `来源：${provenance.source}`,
      ] : [issue.title || '未命名 Issue']),
      `状态：${STATUS_LABELS[issue.status] || issue.status || '未设置'}`,
      `优先级：${PRIORITY_LABELS[issue.priority] || issue.priority || '未设置'}`,
      ...(detailed && issue.created_at ? [`创建时间：${issue.created_at}`] : []),
      ...(detailed && provenance.description
        ? [`完整说明：\n${provenance.description}`]
        : []),
      ...(link ? [`查看：${link}`] : []),
    ].join('\n');
  }
  const lines = change.changedFields.map(field => {
    const label = FIELD_LABELS[field] || field;
    const before = fieldValue(field, change.before?.[field]);
    const after = fieldValue(field, issue[field]);
    return `${label}：${before} → ${after}`;
  });
  return [
    `Multica Issue 更新：${issue.identifier}${workspace}`,
    ...(detailed ? [
      `标题：${issue.title || change.before?.title || '未命名 Issue'}`,
      `做什么：${provenance.purpose}`,
      `为什么：${provenance.reason}`,
      `谁提出：${provenance.proposer}`,
      `来源：${provenance.source}`,
    ] : [issue.title || change.before?.title || '未命名 Issue']),
    ...lines,
    ...(detailed && provenance.description
      ? [`完整说明：\n${provenance.description}`]
      : []),
    ...(link ? [`查看：${link}`] : []),
  ].join('\n');
}

export class MulticaSynchronizer {
  constructor({
    client,
    state,
    notify,
    audit = () => {},
    maxNotificationAttempts = 10,
    appUrl,
    ownerRecipient,
  }) {
    this.client = client;
    this.state = state;
    this.notify = notify;
    this.audit = audit;
    this.maxNotificationAttempts = Math.max(
      1,
      Math.min(50, Number(maxNotificationAttempts) || 10),
    );
    this.appUrl = appUrl;
    this.ownerRecipient = ownerRecipient?.chatId ? {
      chatId: String(ownerRecipient.chatId),
      senderId: String(ownerRecipient.senderId || ''),
      chatType: String(ownerRecipient.chatType || 'p2p'),
      channel: recipientChannel(ownerRecipient),
      isOwner: true,
    } : null;
  }

  async deliverNotifications(now = new Date()) {
    let notified = 0;
    let failed = 0;
    let dead = 0;
    const due = this.state.listDueMulticaNotifications(now.toISOString(), 200);
    for (const item of due) {
      try {
        const result = await this.notify(item.chatId, item.content, item.notificationKey, {
          senderId: item.senderId,
          chatType: item.chatType,
        });
        if (result?.suppressed === true) {
          throw new Error(`notification suppressed: ${result.reason || 'unknown reason'}`);
        }
        this.state.completeMulticaNotification(item.notificationKey);
        notified += 1;
      } catch (error) {
        failed += 1;
        const delayMs = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(item.attempts, 8)));
        const failure = this.state.failMulticaNotification(
          item.notificationKey,
          error?.message || error,
          new Date(now.getTime() + delayMs).toISOString(),
          this.maxNotificationAttempts,
        );
        if (failure.deadLettered) dead += 1;
        this.audit(failure.deadLettered
          ? 'multica_sync_notification_dead_lettered'
          : 'multica_sync_notification_failed', {
          issueId: item.issueId,
          chatId: item.chatId,
          attempts: failure.attempts,
          delayMs,
          error: String(error?.message || error).slice(0, 500),
        });
      }
    }
    return {
      notified,
      failed,
      dead,
      pending: this.state.multicaNotificationCount(),
    };
  }

  async cycle({ now = new Date() } = {}) {
    const issues = await this.client.listAllIssues();
    const baseline = this.state.get('multica_sync', 'baseline_complete', false) !== true;
    const changes = [];
    for (const issue of issues) {
      const change = this.state.upsertMulticaIssue(issue);
      if (!baseline && (change.isNew || change.changedFields.length)) changes.push(change);
    }
    if (baseline) {
      this.state.set('multica_sync', 'baseline_complete', true);
      this.state.set('multica_sync', 'last_success_at', now.toISOString());
      this.state.unset('multica_sync', 'last_error');
      return { baseline: true, scanned: issues.length, notified: 0, changes: 0 };
    }

    const globalSubscribers = this.state.multicaGlobalSubscribers();
    for (const change of changes) {
      const origin = this.state.multicaIssueOrigin(change.after.id);
      const issueSubscribers = change.isNew && !origin
        ? []
        : this.state.multicaIssueSubscribers(change.after.id);
      const routed = channelBoundRecipients({
        issue: change.after,
        origin,
        issueSubscribers,
        globalSubscribers,
        ownerRecipient: this.ownerRecipient,
      });
      const recipients = routed.recipients;
      for (const recipient of recipients) {
        const message = formatMulticaChange(change, {
          appUrl: this.appUrl,
          detailed: recipient.isOwner === true,
        });
        this.state.enqueueMulticaNotification({
          notificationKey: notificationKey(change.after, recipient.chatId),
          issueId: change.after.id,
          chatId: recipient.chatId,
          senderId: recipient.senderId,
          chatType: recipient.chatType,
          content: message,
          availableAt: now.toISOString(),
        });
      }
      this.audit('multica_sync_change', {
        issueId: change.after.id,
        identifier: change.after.identifier,
        workspaceId: change.after.workspace_id,
        isNew: change.isNew,
        changedFields: change.changedFields,
        sourceChannel: routed.channel,
        recipients: recipients.length,
        ownerNotified: recipients.some(item => item.isOwner === true),
      });
    }
    const delivery = await this.deliverNotifications(now);
    this.state.set('multica_sync', 'last_success_at', now.toISOString());
    this.state.set('multica_sync', 'last_scanned', issues.length);
    this.state.set('multica_sync', 'last_change_count', changes.length);
    this.state.unset('multica_sync', 'last_error');
    return {
      baseline: false,
      scanned: issues.length,
      ...delivery,
      changes: changes.length,
    };
  }
}
