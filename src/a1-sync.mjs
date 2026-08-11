import { createHash } from 'node:crypto';

const FIELD_LABELS = {
  title: '标题',
  description: '正文',
  status: '状态',
  assignee: '负责人',
  category: '类别',
  type: '工作项类型',
  projectId: '项目 ID',
  projectName: '项目',
};

function fieldValue(field, value) {
  if (field === 'description') return value ? '已更新' : '已清空';
  return String(value || '未设置');
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

function notificationKey(workitem, chatId) {
  const digest = createHash('sha256')
    .update(`${workitem.id}\0${workitem.updatedAt || ''}\0${chatId}`)
    .digest('hex')
    .slice(0, 18);
  return `a1-sync-${digest}`;
}

export function formatA1Change(change) {
  const workitem = change.after;
  const project = workitem.projectName ? ` · ${workitem.projectName}` : '';
  if (change.isNew) {
    return [
      `A1 新工作项：${workitem.id}${project}`,
      workitem.title || '未命名工作项',
      `状态：${workitem.status || '未设置'}`,
      `负责人：${workitem.assignee || '未设置'}`,
      ...(workitem.url ? [workitem.url] : []),
    ].join('\n');
  }
  const lines = change.changedFields.map(field => {
    const label = FIELD_LABELS[field] || field;
    const before = fieldValue(field, change.before?.[field]);
    const after = fieldValue(field, workitem[field]);
    return `${label}：${before} → ${after}`;
  });
  return [
    `A1 工作项更新：${workitem.id}${project}`,
    workitem.title || change.before?.title || '未命名工作项',
    ...lines,
    ...(workitem.url ? [workitem.url] : []),
  ].join('\n');
}

export class A1Synchronizer {
  constructor({
    client,
    state,
    notify,
    audit = () => {},
    defaultProjectId = '',
    maxWorkitems = 500,
    maxNotificationAttempts = 10,
  }) {
    this.client = client;
    this.state = state;
    this.notify = notify;
    this.audit = audit;
    this.defaultProjectId = String(defaultProjectId || '');
    this.maxWorkitems = Math.max(1, Math.min(5_000, Number(maxWorkitems) || 500));
    this.maxNotificationAttempts = Math.max(
      1,
      Math.min(50, Number(maxNotificationAttempts) || 10),
    );
  }

  async deliverNotifications(now = new Date()) {
    let notified = 0;
    let failed = 0;
    let dead = 0;
    const due = this.state.listDueA1Notifications(now.toISOString(), 200);
    for (const item of due) {
      try {
        await this.notify(item.chatId, item.content, item.notificationKey);
        this.state.completeA1Notification(item.notificationKey);
        notified += 1;
      } catch (error) {
        failed += 1;
        const delayMs = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(item.attempts, 8)));
        const failure = this.state.failA1Notification(
          item.notificationKey,
          error?.message || error,
          new Date(now.getTime() + delayMs).toISOString(),
          this.maxNotificationAttempts,
        );
        if (failure.deadLettered) dead += 1;
        this.audit(failure.deadLettered
          ? 'a1_sync_notification_dead_lettered'
          : 'a1_sync_notification_failed', {
          workitemId: item.workitemId,
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
      pending: this.state.a1NotificationCount(),
    };
  }

  async scanWorkitems() {
    const workitems = [];
    const seen = new Set();
    if (this.defaultProjectId) {
      const projectItems = await this.client.listWorkitems({
        projectId: this.defaultProjectId,
        scope: 'project',
        category: 'req,bug,task',
        pageSize: this.maxWorkitems,
      });
      for (const workitem of projectItems.slice(0, this.maxWorkitems)) {
        if (seen.has(workitem.id)) continue;
        seen.add(workitem.id);
        workitems.push(workitem);
      }
    }
    const followed = this.state.a1SubscribedWorkitemIds();
    for (const id of followed) {
      if (seen.has(id) || workitems.length >= this.maxWorkitems) continue;
      const workitem = await this.client.getWorkitem(id);
      seen.add(workitem.id);
      workitems.push(workitem);
    }
    return workitems;
  }

  async cycle({ now = new Date() } = {}) {
    const workitems = await this.scanWorkitems();
    const establishingBaseline = workitems.length > 0
      && this.state.get('a1_sync', 'baseline_complete', false) !== true;
    const changes = [];
    for (const workitem of workitems) {
      const change = this.state.upsertA1Workitem(workitem);
      if (!establishingBaseline && (change.isNew || change.changedFields.length)) {
        changes.push(change);
      }
    }
    if (establishingBaseline) {
      this.state.set('a1_sync', 'baseline_complete', true);
    }

    for (const change of changes) {
      const projectSubscribers = change.after.projectId === this.defaultProjectId
        ? this.state.a1ProjectSubscribers(this.defaultProjectId)
        : [];
      const workitemSubscribers = change.isNew
        ? []
        : this.state.a1WorkitemSubscribers(change.after.id);
      const recipients = uniqueRecipients([...projectSubscribers, ...workitemSubscribers]);
      const message = formatA1Change(change);
      for (const recipient of recipients) {
        this.state.enqueueA1Notification({
          notificationKey: notificationKey(change.after, recipient.chatId),
          workitemId: change.after.id,
          chatId: recipient.chatId,
          senderId: recipient.senderId,
          content: message,
          availableAt: now.toISOString(),
        });
      }
      this.audit('a1_sync_change', {
        workitemId: change.after.id,
        projectId: change.after.projectId,
        isNew: change.isNew,
        changedFields: change.changedFields,
        recipients: recipients.length,
      });
    }
    const delivery = await this.deliverNotifications(now);
    this.state.set('a1_sync', 'last_success_at', now.toISOString());
    this.state.set('a1_sync', 'last_scanned', workitems.length);
    this.state.set('a1_sync', 'last_change_count', changes.length);
    this.state.unset('a1_sync', 'last_error');
    return {
      baseline: establishingBaseline,
      scanned: workitems.length,
      ...delivery,
      changes: changes.length,
    };
  }
}
