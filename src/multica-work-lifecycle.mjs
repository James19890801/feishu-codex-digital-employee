const TERMINAL_STATUSES = new Set(['done', 'cancelled']);
const WORK_REQUEST = /^(?:请)?\s*(?:处理|执行|完成|解决|交付)\s+([A-Za-z][A-Za-z0-9]{0,15}-\d+)\s*[：:，,]\s*(.+)$/i;

export function parseMulticaWorkRequest(value) {
  const match = String(value || '').trim().match(WORK_REQUEST);
  if (!match) return null;
  const task = match[2].trim();
  if (!task) return null;
  return { issue: match[1].toUpperCase(), task };
}

function contextValue(context) {
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

export class MulticaWorkLifecycle {
  constructor({ client, state, authorizeWrite = () => false }) {
    this.client = client;
    this.state = state;
    this.authorizeWrite = authorizeWrite;
  }

  async begin(reference, rawContext) {
    if (this.authorizeWrite(rawContext) !== true) {
      const error = new Error('Verified Owner authorization is required to execute Multica work');
      error.code = 'MULTICA_OWNER_REQUIRED';
      throw error;
    }
    const context = contextValue(rawContext);
    let issue = await this.client.getIssue(reference);
    const workspaceName = issue.workspace_name;
    const workspaceSlug = issue.workspace_slug;
    if (TERMINAL_STATUSES.has(issue.status)) {
      throw new Error(`Multica work cannot begin from terminal status: ${issue.status}`);
    }
    this.state.subscribeMulticaIssue(issue.id, context.chatId, context.senderId, {
      chatType: context.chatType,
      channel: context.channel,
    });
    if (issue.status !== 'in_progress') {
      issue = await this.client.updateIssue(issue.id, {
        workspaceId: issue.workspace_id,
        status: 'in_progress',
      });
      issue = {
        ...issue,
        ...(workspaceName ? { workspace_name: workspaceName } : {}),
        ...(workspaceSlug ? { workspace_slug: workspaceSlug } : {}),
      };
    }
    return { issue, context };
  }

  async complete(binding) {
    const current = await this.client.getIssue(
      binding.issue.id,
      binding.issue.workspace_id,
    );
    if (current.status === 'done') return current;
    if (current.status !== 'in_progress') {
      throw new Error(`Multica work status changed during execution: ${current.status}`);
    }
    const issue = await this.client.updateIssue(current.id, {
      workspaceId: current.workspace_id,
      status: 'done',
    });
    return {
      ...issue,
      ...(binding.issue.workspace_name ? { workspace_name: binding.issue.workspace_name } : {}),
      ...(binding.issue.workspace_slug ? { workspace_slug: binding.issue.workspace_slug } : {}),
    };
  }

  async block(binding) {
    const current = await this.client.getIssue(
      binding.issue.id,
      binding.issue.workspace_id,
    );
    if (current.status !== 'in_progress') return {
      ...current,
      ...(binding.issue.workspace_name ? { workspace_name: binding.issue.workspace_name } : {}),
      ...(binding.issue.workspace_slug ? { workspace_slug: binding.issue.workspace_slug } : {}),
    };
    const issue = await this.client.updateIssue(current.id, {
      workspaceId: current.workspace_id,
      status: 'blocked',
    });
    return {
      ...issue,
      ...(binding.issue.workspace_name ? { workspace_name: binding.issue.workspace_name } : {}),
      ...(binding.issue.workspace_slug ? { workspace_slug: binding.issue.workspace_slug } : {}),
    };
  }

  async run({
    reference,
    context,
    execute,
    deliver,
    onStarted = async () => {},
  }) {
    const binding = await this.begin(reference, context);
    try {
      await onStarted(binding.issue);
      const answer = String(await execute() || '').trim();
      if (!answer) throw new Error('AI runtime returned an empty work result');
      await deliver(answer);
      const issue = await this.complete(binding);
      return { outcome: 'completed', answer, issue };
    } catch (error) {
      const issue = await this.block(binding);
      return { outcome: 'blocked', error, issue };
    }
  }
}
