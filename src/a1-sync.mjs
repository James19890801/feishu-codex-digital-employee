import { createHash } from 'node:crypto';

function notificationKey(item, subscriber) {
  return `a1-status:${createHash('sha256').update([
    item.id, item.status, item.updatedAt || '', subscriber.chatId, subscriber.senderId,
  ].join('\n')).digest('hex')}`;
}

function statusChangeText(previous, current) {
  return `1A 需求状态已变更：${current.title || current.id}\n`
    + `ID：${current.id}\n`
    + `状态：${previous.status || '未知'} → ${current.status || '未知'}\n`
    + `${current.assignee ? `负责人：${current.assignee}\n` : ''}`
    + `${current.updatedAt ? `更新时间：${current.updatedAt}\n` : ''}`
    + `链接：${current.url}`;
}

export class A1Synchronizer {
  constructor({ client, state, notify, audit = () => {}, now = () => new Date() } = {}) {
    if (!client) throw new Error('A1 sync client is required');
    if (!state) throw new Error('A1 sync state is required');
    if (typeof notify !== 'function') throw new Error('A1 sync notify is required');
    this.client = client;
    this.state = state;
    this.notify = notify;
    this.audit = audit;
    this.now = now;
  }

  async pollChanges() {
    const result = { fetched: 0, changed: 0, enqueued: 0, fetchFailed: 0 };
    for (const id of this.state.a1WorkitemIds()) {
      try {
        const previous = this.state.getA1WorkitemSnapshot(id);
        const current = await this.client.getWorkitem(id);
        result.fetched += 1;
        if (previous?.status && current.status && previous.status !== current.status) {
          result.changed += 1;
          const content = statusChangeText(previous, current);
          for (const subscriber of this.state.a1Subscribers(id)) {
            const inserted = this.state.enqueueA1Notification({
              notificationKey: notificationKey(current, subscriber),
              workitemId: id,
              chatId: subscriber.chatId,
              senderId: subscriber.senderId,
              chatType: subscriber.chatType,
              content,
              availableAt: this.now().toISOString(),
            });
            if (inserted) result.enqueued += 1;
          }
          this.audit('a1_status_changed', {
            workitemId: id, before: previous.status, after: current.status,
          });
        }
        this.state.cacheA1Workitem(current);
      } catch (error) {
        result.fetchFailed += 1;
        this.audit('a1_status_fetch_failed', {
          workitemId: id, error: String(error?.message || error).slice(0, 1000),
        });
      }
    }
    return result;
  }

  async deliverNotifications() {
    const result = { delivered: 0, failed: 0, deadLettered: 0 };
    const now = this.now();
    for (const item of this.state.listDueA1Notifications(now.toISOString(), 200)) {
      try {
        await this.notify(item.chatId, item.content, item.notificationKey, {
          senderId: item.senderId,
          chatType: item.chatType,
        });
        this.state.completeA1Notification(item.notificationKey);
        result.delivered += 1;
      } catch (error) {
        result.failed += 1;
        const delayMs = Math.min(15 * 60_000, 5_000 * (2 ** Math.min(item.attempts, 8)));
        const failure = this.state.failA1Notification(
          item.notificationKey,
          error?.message || error,
          new Date(now.getTime() + delayMs).toISOString(),
          10,
        );
        if (failure.deadLettered) result.deadLettered += 1;
        this.audit('a1_status_notification_failed', {
          workitemId: item.workitemId,
          notificationKey: item.notificationKey,
          attempts: failure.attempts,
          deadLettered: failure.deadLettered,
          error: String(error?.message || error).slice(0, 1000),
        });
      }
    }
    return result;
  }

  async syncOnce() {
    const polled = await this.pollChanges();
    const delivered = await this.deliverNotifications();
    return { ...polled, ...delivered };
  }
}
