import { createHash } from 'node:crypto';

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

function uniqueRecipients(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.chatId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function notificationKey(issue, chatId) {
  const digest = createHash('sha256')
    .update(`${issue.id}\0${issue.updated_at || ''}\0${chatId}`)
    .digest('hex')
    .slice(0, 18);
  return `multica-sync-${digest}`;
}

export function formatMulticaChange(change) {
  const issue = change.after;
  const workspace = issue.workspace_name ? ` · ${issue.workspace_name}` : '';
  if (change.isNew) {
    return [
      `Multica 新 Issue：${issue.identifier}${workspace}`,
      issue.title || '未命名 Issue',
      `状态：${STATUS_LABELS[issue.status] || issue.status || '未设置'}`,
      `优先级：${PRIORITY_LABELS[issue.priority] || issue.priority || '未设置'}`,
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
    issue.title || change.before?.title || '未命名 Issue',
    ...lines,
  ].join('\n');
}

export class MulticaSynchronizer {
  constructor({
    client,
    state,
    notify,
    audit = () => {},
    maxNotificationAttempts = 10,
  }) {
    this.client = client;
    this.state = state;
    this.notify = notify;
    this.audit = audit;
    this.maxNotificationAttempts = Math.max(
      1,
      Math.min(50, Number(maxNotificationAttempts) || 10),
    );
  }

  async deliverNotifications(now = new Date()) {
    let notified = 0;
    let failed = 0;
    let dead = 0;
    const due = this.state.listDueMulticaNotifications(now.toISOString(), 200);
    for (const item of due) {
      try {
        await this.notify(item.chatId, item.content, item.notificationKey);
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
      const issueSubscribers = change.isNew
        ? []
        : this.state.multicaIssueSubscribers(change.after.id);
      const recipients = uniqueRecipients([...globalSubscribers, ...issueSubscribers]);
      const message = formatMulticaChange(change);
      for (const recipient of recipients) {
        this.state.enqueueMulticaNotification({
          notificationKey: notificationKey(change.after, recipient.chatId),
          issueId: change.after.id,
          chatId: recipient.chatId,
          senderId: recipient.senderId,
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
        recipients: recipients.length,
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
