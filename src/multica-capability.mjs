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
  assignee: '负责人',
  assigneeId: '负责人 ID',
  project: '项目',
  parent: '父 Issue',
  dueDate: '截止日期',
  startDate: '开始日期',
};

function statusLabel(value) {
  return STATUS_LABELS[value] || value || '未设置';
}

function priorityLabel(value) {
  return PRIORITY_LABELS[value] || value || '未设置';
}

function previewValue(key, value) {
  if (key === 'status') return statusLabel(value);
  if (key === 'priority') return priorityLabel(value);
  if (key === 'description') return String(value || '').slice(0, 800) || '（空）';
  return String(value || '（空）');
}

function requireContext(context) {
  if (!context?.chatId) throw new Error('IM chat context is required');
  const configuredChannel = String(context.metadata?.channel || '').trim().toLowerCase();
  const prefixedChannel = String(context.chatId).match(/^(dingtalk|wecom|wechat):/)?.[1];
  return {
    chatId: String(context.chatId),
    senderId: String(context.senderId || ''),
    chatType: String(context.chatType || ''),
    channel: configuredChannel || prefixedChannel || 'feishu',
  };
}

function issueLines(issue, { includeDescription = true, appUrl } = {}) {
  const link = multicaIssueUrl(issue, appUrl);
  const lines = [
    `${issue.identifier} · ${issue.title || '未命名 Issue'}`,
    `空间：${issue.workspace_name || issue.workspace_id}`,
    `状态：${statusLabel(issue.status)} · 优先级：${priorityLabel(issue.priority)}`,
  ];
  if (issue.due_date) lines.push(`截止：${issue.due_date}`);
  if (issue.assignee_name) lines.push(`负责人：${issue.assignee_name}`);
  if (link) lines.push(`查看：${link}`);
  if (includeDescription && issue.description) {
    lines.push('', String(issue.description).slice(0, 1600));
  }
  return lines;
}

function issueListText(issues, emptyText, appUrl) {
  if (!issues.length) return emptyText;
  const visible = issues.slice(0, 10);
  const lines = visible.map((issue, index) => {
    const link = multicaIssueUrl(issue, appUrl);
    return `${index + 1}. ${issue.identifier} · ${issue.title || '未命名'}`
      + `（${statusLabel(issue.status)}，${issue.workspace_name || issue.workspace_id}）`
      + (link ? `\n   查看：${link}` : '');
  });
  if (issues.length > visible.length) lines.push(`还有 ${issues.length - visible.length} 条未展开。`);
  return lines.join('\n');
}

export class MulticaCapability {
  constructor({
    client,
    state,
    appUrl,
    authorizeWrite = () => false,
    authorizeApproval = () => false,
  }) {
    this.client = client;
    this.state = state;
    this.appUrl = appUrl;
    this.authorizeWrite = authorizeWrite;
    this.authorizeApproval = authorizeApproval;
  }

  assertWriteAuthorized(context) {
    if (this.authorizeWrite(context) === true) return;
    const error = new Error('Verified Owner authorization is required for Multica writes');
    error.code = 'MULTICA_OWNER_REQUIRED';
    throw error;
  }

  assertApprovalAuthorized(context) {
    if (this.authorizeApproval(context) === true) return;
    const error = new Error('Verified DingTalk Owner approval is required for this Multica write');
    error.code = 'MULTICA_APPROVER_REQUIRED';
    throw error;
  }

  follow(issue, context) {
    this.state.subscribeMulticaIssue(issue.id, context.chatId, context.senderId, {
      chatType: context.chatType,
      channel: context.channel,
    });
    this.state.bindConversationIssue?.(context.chatId, context.senderId, issue);
  }

  cacheAndFollow(issue, context, { bindOrigin = false } = {}) {
    this.state.upsertMulticaIssue(issue);
    if (bindOrigin) {
      this.state.bindMulticaIssueOrigin(issue.id, {
        chatId: context.chatId,
        senderId: context.senderId,
        chatType: context.chatType,
        channel: context.channel,
      });
    }
    this.follow(issue, context);
  }

  async execute(plan, rawContext) {
    const context = requireContext(rawContext);
    if (plan.confirmationLevel !== 'none') {
      throw new Error('Mutating Multica actions must be prepared and confirmed');
    }
    if (plan.action === 'answer') {
      return { kind: 'reply', text: plan.answer || '请告诉我具体要查询或处理哪个 Issue。' };
    }
    if (plan.action === 'list') {
      let workspaces;
      if (plan.workspaceId) {
        const all = await this.client.listWorkspaces();
        workspaces = all.filter(item => item.id === plan.workspaceId);
      }
      const issues = await this.client.listAllIssues({
        workspaces,
        status: plan.filters?.status || '',
        project: plan.filters?.project || '',
      });
      return {
        kind: 'reply',
        text: issueListText(issues, '没有查到符合条件的 Multica Issue。', this.appUrl),
      };
    }
    if (plan.action === 'search') {
      let workspaces;
      if (plan.workspaceId) {
        const all = await this.client.listWorkspaces();
        workspaces = all.filter(item => item.id === plan.workspaceId);
      }
      const issues = await this.client.searchIssues(plan.query, { workspaces });
      return {
        kind: 'reply',
        text: issueListText(
          issues,
          `没有找到与“${plan.query}”匹配的 Issue。`,
          this.appUrl,
        ),
      };
    }
    if (plan.action === 'get') {
      const issue = await this.client.getIssue(plan.issue);
      this.cacheAndFollow(issue, context);
      return {
        kind: 'reply',
        text: issueLines(issue, { appUrl: this.appUrl, includeDescription: false }).join('\n'),
        issue,
      };
    }
    if (plan.action === 'follow') {
      const issue = await this.client.getIssue(plan.issue);
      this.cacheAndFollow(issue, context);
      return {
        kind: 'reply',
        text: `已经开始跟进 ${issue.identifier}。后续状态或关键信息变化会同步到当前会话。`
          + `${multicaIssueUrl(issue, this.appUrl) ? `\n查看：${multicaIssueUrl(issue, this.appUrl)}` : ''}`,
        issue,
      };
    }
    if (plan.action === 'unfollow') {
      const issue = await this.client.getIssue(plan.issue);
      this.state.unsubscribeMulticaIssue(issue.id, context.chatId, context.senderId);
      return {
        kind: 'reply',
        text: `已停止在当前会话跟进 ${issue.identifier}。`,
        issue,
      };
    }
    if (plan.action === 'sync_here') {
      this.state.subscribeMulticaGlobal(context.chatId, context.senderId, {
        chatType: context.chatType,
        channel: context.channel,
      });
      return {
        kind: 'reply',
        text: '已经开启 Multica 全空间同步。新 Issue 和已有 Issue 的关键变化会同步到当前会话。',
      };
    }
    if (plan.action === 'stop_sync') {
      this.state.unsubscribeMulticaGlobal(context.chatId, context.senderId);
      return {
        kind: 'reply',
        text: '已停止向当前会话同步 Multica 全空间变化；单独跟进的 Issue 不受影响。',
      };
    }
    throw new Error(`Unsupported read-only Multica action: ${plan.action}`);
  }

  async prepareMutation(plan, rawContext) {
    this.assertWriteAuthorized(rawContext);
    const context = requireContext(rawContext);
    return this.prepareMutationPreview(plan, context);
  }

  async prepareMutationApproval(plan, rawContext) {
    const context = requireContext(rawContext);
    if (context.channel !== 'dingtalk' || context.chatType !== 'group') {
      const error = new Error('DingTalk group context is required for quoted approval');
      error.code = 'MULTICA_APPROVAL_CONTEXT_REQUIRED';
      throw error;
    }
    return this.prepareMutationPreview(plan, context);
  }

  async prepareMutationPreview(plan, context) {
    if (!['create', 'update', 'comment'].includes(plan.action)
      || !['single', 'double'].includes(plan.confirmationLevel)) {
      throw new Error('This Multica action does not require mutation confirmation');
    }
    const pending = {
      plan: structuredClone(plan),
      chatId: context.chatId,
      senderId: context.senderId,
      chatType: context.chatType,
      channel: context.channel,
      expectedUpdatedAt: '',
      resolvedIssueId: '',
      resolvedWorkspaceId: '',
      resolvedWorkspaceName: '',
      resolvedWorkspaceSlug: '',
    };
    const lines = [`准备执行：${plan.summary}`];
    if (plan.action === 'create') {
      const workspaces = await this.client.listWorkspaces();
      const workspace = workspaces.find(item => item.id === plan.workspaceId);
      if (!workspace) throw new Error('The target Multica workspace is no longer available');
      pending.resolvedWorkspaceId = workspace.id;
      pending.resolvedWorkspaceName = workspace.name;
      pending.resolvedWorkspaceSlug = workspace.slug;
      lines.push(`空间：${workspace.name}`);
      for (const [key, value] of Object.entries(plan.fields)) {
        lines.push(`${FIELD_LABELS[key] || key}：${previewValue(key, value)}`);
      }
    } else {
      const issue = await this.client.getIssue(plan.issue);
      pending.expectedUpdatedAt = String(issue.updated_at || '');
      pending.resolvedIssueId = issue.id;
      pending.resolvedWorkspaceId = issue.workspace_id;
      pending.resolvedWorkspaceName = issue.workspace_name || '';
      pending.resolvedWorkspaceSlug = issue.workspace_slug || '';
      lines.push(`Issue：${issue.identifier} · ${issue.title}`);
      if (plan.action === 'comment') {
        lines.push(`评论：${plan.content}`);
      } else {
        for (const [key, value] of Object.entries(plan.fields)) {
          lines.push(`${FIELD_LABELS[key] || key}：${previewValue(key, value)}`);
        }
      }
    }
    return {
      kind: 'confirmation',
      text: lines.join('\n'),
      pending,
    };
  }

  async applyMutation(pending, rawContext) {
    this.assertWriteAuthorized(rawContext);
    const context = requireContext(rawContext);
    if (pending.chatId !== context.chatId || pending.senderId !== context.senderId) {
      throw new Error('Multica confirmation context does not match the original request');
    }
    return this.applyPreparedMutation(pending, context);
  }

  async applyApprovedMutation(pending, rawApprovalContext) {
    this.assertApprovalAuthorized(rawApprovalContext);
    const approvalContext = requireContext(rawApprovalContext);
    if (pending.chatId !== approvalContext.chatId) {
      throw new Error('Multica approval context does not match the original request');
    }
    const originContext = requireContext({
      chatId: pending.chatId,
      senderId: pending.senderId,
      chatType: pending.chatType,
      metadata: { channel: pending.channel || approvalContext.channel },
    });
    return this.applyPreparedMutation(pending, originContext);
  }

  async applyPreparedMutation(pending, context) {
    const plan = pending.plan;
    if (plan.action === 'create') {
      const issue = await this.client.createIssue({
        workspaceId: plan.workspaceId,
        ...plan.fields,
      });
      const decoratedIssue = {
        ...issue,
        workspace_name: pending.resolvedWorkspaceName,
        workspace_slug: pending.resolvedWorkspaceSlug,
      };
      this.cacheAndFollow(decoratedIssue, context, { bindOrigin: true });
      return {
        kind: 'reply',
        text: `Issue 已创建：\n${issueLines(decoratedIssue, {
          includeDescription: false,
          appUrl: this.appUrl,
        }).join('\n')}`,
        issue: decoratedIssue,
      };
    }
    const current = await this.client.getIssue(
      pending.resolvedIssueId || plan.issue,
      pending.resolvedWorkspaceId,
    );
    if (plan.action === 'update') {
      if (String(current.updated_at || '') !== pending.expectedUpdatedAt) {
        throw new Error('Multica issue changed after the preview; please generate a fresh plan');
      }
      const issue = await this.client.updateIssue(current.id, {
        workspaceId: current.workspace_id,
        ...plan.fields,
      });
      const decoratedIssue = {
        ...issue,
        ...(pending.resolvedWorkspaceName
          ? { workspace_name: pending.resolvedWorkspaceName } : {}),
        ...(pending.resolvedWorkspaceSlug
          ? { workspace_slug: pending.resolvedWorkspaceSlug } : {}),
      };
      this.follow(decoratedIssue, context);
      return {
        kind: 'reply',
        text: `Issue 已更新：\n${issueLines(decoratedIssue, {
          includeDescription: false,
          appUrl: this.appUrl,
        }).join('\n')}`,
        issue: decoratedIssue,
      };
    }
    if (plan.action === 'comment') {
      const result = await this.client.addComment(
        current.id,
        plan.content,
        current.workspace_id,
      );
      const decoratedIssue = {
        ...result.issue,
        ...(pending.resolvedWorkspaceName
          ? { workspace_name: pending.resolvedWorkspaceName } : {}),
        ...(pending.resolvedWorkspaceSlug
          ? { workspace_slug: pending.resolvedWorkspaceSlug } : {}),
      };
      this.cacheAndFollow(decoratedIssue, context);
      const link = multicaIssueUrl(decoratedIssue, this.appUrl);
      return {
        kind: 'reply',
        text: `已在 ${current.identifier} 添加跟进评论：\n${plan.content}`
          + (link ? `\n查看：${link}` : ''),
        issue: decoratedIssue,
      };
    }
    throw new Error(`Unsupported Multica mutation: ${plan.action}`);
  }
}
