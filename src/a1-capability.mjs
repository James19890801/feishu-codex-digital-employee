const FIELD_LABELS = {
  category: '类别',
  type: '工作项类型',
  title: '标题',
  body: '正文',
  assignee: '负责人',
  status: '状态',
  sprint: '迭代',
  module: '模块',
  version: '版本',
  tag: '标签',
  priority: '优先级',
  severity: '严重程度',
  tracker: '跟踪人',
  participant: '参与人',
  verifier: '验证人',
  relatedSpace: '关联项目',
};

function requireContext(context) {
  if (!context?.chatId) throw new Error('Chat context is required');
  if (!context?.senderId) throw new Error('Chat sender context is required');
  return {
    chatId: String(context.chatId),
    senderId: String(context.senderId),
  };
}

function workitemLines(workitem, { includeDescription = true } = {}) {
  const lines = [
    `${workitem.id} · ${workitem.title || '未命名工作项'}`,
    `项目：${workitem.projectName || workitem.projectId || '未确认'}`,
    `状态：${workitem.status || '未设置'} · 类型：${workitem.type || workitem.category || '未设置'}`,
  ];
  if (workitem.assignee) lines.push(`负责人：${workitem.assignee}`);
  if (workitem.updatedAt) lines.push(`更新时间：${workitem.updatedAt}`);
  if (includeDescription && workitem.description) {
    lines.push('', String(workitem.description).slice(0, 1_600));
  }
  if (workitem.url) lines.push('', workitem.url);
  return lines;
}

function workitemListText(workitems) {
  if (!workitems.length) return '没有查到符合条件的 A1 工作项。';
  const visible = workitems.slice(0, 10);
  const lines = visible.map((item, index) => (
    `${index + 1}. ${item.id} · ${item.title || '未命名'}`
      + `（${item.status || '未设置'}，${item.projectName || item.projectId || '未知项目'}）`
  ));
  if (workitems.length > visible.length) lines.push(`还有 ${workitems.length - visible.length} 条未展开。`);
  return lines.join('\n');
}

function activityText(activity) {
  if (!activity.length) return '这个 A1 工作项暂时没有可读取的变更记录。';
  return activity.slice(0, 10).map((item, index) => {
    const id = item.id ?? item.identifier ?? `#${index + 1}`;
    const action = item.action ?? item.field ?? item.type ?? '变更';
    const operator = item.operator?.displayName ?? item.operator ?? item.creator?.displayName ?? '';
    const time = item.updatedAt ?? item.gmtCreate ?? item.createdAt ?? '';
    return `${index + 1}. ${id} · ${action}${operator ? ` · ${operator}` : ''}${time ? ` · ${time}` : ''}`;
  }).join('\n');
}

function previewValue(key, value) {
  if (key === 'body') return String(value || '').slice(0, 1_600) || '（空）';
  return String(value || '（空）');
}

export class A1Capability {
  constructor({ client, state, defaultProjectId = '' }) {
    this.client = client;
    this.state = state;
    this.defaultProjectId = String(defaultProjectId || '');
  }

  cacheAndFollow(workitem, context) {
    this.state.upsertA1Workitem(workitem);
    this.state.subscribeA1Workitem(workitem.id, context.chatId, context.senderId);
  }

  async execute(plan, rawContext) {
    const context = requireContext(rawContext);
    if (plan.confirmationLevel !== 'none') {
      throw new Error('Mutating A1 actions must be prepared and confirmed');
    }
    if (plan.action === 'answer') {
      return { kind: 'reply', text: plan.answer || '请告诉我要查询或处理哪个 A1 工作项。' };
    }
    if (plan.action === 'list') {
      const workitems = await this.client.listWorkitems({
        projectId: plan.projectId || '',
        scope: plan.filters?.scope || (plan.projectId ? 'project' : 'personal'),
        category: plan.filters?.category || 'req,bug,task',
        status: plan.filters?.status || '',
        assignee: plan.filters?.assignee || '',
        title: plan.filters?.title || '',
        modified: plan.filters?.modified || '',
      });
      return { kind: 'reply', text: workitemListText(workitems), workitems };
    }
    if (plan.action === 'get') {
      const workitem = await this.client.getWorkitem(plan.workitemId);
      this.cacheAndFollow(workitem, context);
      return { kind: 'reply', text: workitemLines(workitem).join('\n'), workitem };
    }
    if (plan.action === 'activity') {
      const activity = await this.client.getActivity(plan.workitemId, 20);
      return { kind: 'reply', text: activityText(activity), activity };
    }
    if (plan.action === 'follow') {
      const workitem = await this.client.getWorkitem(plan.workitemId);
      this.cacheAndFollow(workitem, context);
      return {
        kind: 'reply',
        text: `已经开始跟进 A1 工作项 ${workitem.id}。后续关键变化会同步到当前钉钉会话。`,
        workitem,
      };
    }
    if (plan.action === 'unfollow') {
      const workitem = await this.client.getWorkitem(plan.workitemId);
      this.state.unsubscribeA1Workitem(workitem.id, context.chatId, context.senderId);
      return {
        kind: 'reply',
        text: `已停止在当前钉钉会话跟进 A1 工作项 ${workitem.id}。`,
        workitem,
      };
    }
    if (plan.action === 'sync_here') {
      const projectId = String(plan.projectId || this.defaultProjectId || '');
      if (!projectId) throw new Error('A1 project is required for project synchronization');
      this.state.subscribeA1Project(projectId, context.chatId, context.senderId);
      return {
        kind: 'reply',
        text: `已经开启 A1 项目 ${projectId} 的变化同步。新建和关键变更会发送到当前钉钉会话。`,
      };
    }
    if (plan.action === 'stop_sync') {
      const projectId = String(plan.projectId || this.defaultProjectId || '');
      if (!projectId) throw new Error('A1 project is required to stop project synchronization');
      this.state.unsubscribeA1Project(projectId, context.chatId, context.senderId);
      return {
        kind: 'reply',
        text: `已停止向当前钉钉会话同步 A1 项目 ${projectId}；单独跟进的工作项不受影响。`,
      };
    }
    throw new Error(`Unsupported read-only A1 action: ${plan.action}`);
  }

  async prepareMutation(plan, rawContext) {
    const context = requireContext(rawContext);
    if (!['create', 'update', 'comment'].includes(plan.action)
      || !['single', 'double'].includes(plan.confirmationLevel)) {
      throw new Error('This A1 action does not require mutation confirmation');
    }
    const pending = {
      plan: structuredClone(plan),
      chatId: context.chatId,
      senderId: context.senderId,
      expectedUpdatedAt: '',
      resolvedWorkitemId: '',
      resolvedProjectId: '',
    };
    const lines = [`准备执行：${plan.summary}`];
    if (plan.action === 'create') {
      const projects = await this.client.listProjects();
      const project = projects.find(item => item.id === plan.projectId);
      if (!project) throw new Error('The target A1 project is no longer available');
      pending.resolvedProjectId = project.id;
      lines.push(`项目：${project.name}（${project.id}）`);
      for (const [key, value] of Object.entries(plan.fields)) {
        lines.push(`${FIELD_LABELS[key] || key}：${previewValue(key, value)}`);
      }
    } else {
      const workitem = await this.client.getWorkitem(plan.workitemId);
      pending.expectedUpdatedAt = String(workitem.updatedAt || '');
      pending.resolvedWorkitemId = workitem.id;
      pending.resolvedProjectId = workitem.projectId;
      lines.push(`工作项：${workitem.id} · ${workitem.title}`);
      lines.push(`当前更新时间：${workitem.updatedAt || '未确认'}`);
      if (plan.action === 'comment') {
        lines.push(`评论：${plan.content}`);
      } else {
        for (const [key, value] of Object.entries(plan.fields)) {
          lines.push(`${FIELD_LABELS[key] || key}：${previewValue(key, value)}`);
        }
      }
    }
    return { kind: 'confirmation', text: lines.join('\n'), pending };
  }

  async applyMutation(pending, rawContext) {
    const context = requireContext(rawContext);
    if (pending.chatId !== context.chatId || pending.senderId !== context.senderId) {
      throw new Error('A1 confirmation context does not match the original request');
    }
    const plan = pending.plan;
    if (plan.action === 'create') {
      const workitem = await this.client.createWorkitem({
        projectId: pending.resolvedProjectId || plan.projectId,
        ...plan.fields,
      });
      this.cacheAndFollow(workitem, context);
      return {
        kind: 'reply',
        text: `A1 工作项已创建并回读确认：\n${workitemLines(workitem, { includeDescription: false }).join('\n')}`,
        workitem,
      };
    }
    const current = await this.client.getWorkitem(
      pending.resolvedWorkitemId || plan.workitemId,
    );
    if (String(current.updatedAt || '') !== String(pending.expectedUpdatedAt || '')) {
      throw new Error('A1 workitem changed after the preview; please generate a fresh plan');
    }
    if (plan.action === 'update') {
      const workitem = await this.client.updateWorkitem(current.id, plan.fields);
      this.cacheAndFollow(workitem, context);
      return {
        kind: 'reply',
        text: `A1 工作项已更新并回读确认：\n${workitemLines(workitem, { includeDescription: false }).join('\n')}`,
        workitem,
      };
    }
    if (plan.action === 'comment') {
      const workitem = await this.client.createComment(current.id, plan.content);
      this.cacheAndFollow(workitem, context);
      return {
        kind: 'reply',
        text: `已在 A1 工作项 ${current.id} 添加评论并完成回读：\n${plan.content}`,
        workitem,
      };
    }
    throw new Error(`Unsupported A1 mutation: ${plan.action}`);
  }
}
