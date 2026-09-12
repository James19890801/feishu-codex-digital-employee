import { createHash } from 'node:crypto';
import { normalizeDingTalkEvent } from '../src/im-channels.mjs';

const MAX_EVENT_BYTES = 1024 * 1024;

export class DingTalkIngress {
  constructor({ store, now = Date.now } = {}) {
    if (!store || typeof store.enqueue !== 'function') throw new TypeError('durable event store is required');
    this.store = store;
    this.now = now;
  }

  async acceptLine(line) {
    const text = String(line || '');
    if (Buffer.byteLength(text) > MAX_EVENT_BYTES) throw new Error('dingtalk_event_too_large');
    let raw;
    try { raw = JSON.parse(text); } catch { throw new Error('invalid_dingtalk_json'); }
    const event = normalizeDingTalkEvent(raw);
    if (!event) return { accepted: false, reason: 'irrelevant' };
    const digest = createHash('sha256').update(`dingtalk\0${event.message.message_id}`).digest('hex');
    const result = await this.store.enqueue({ digest, body: JSON.stringify(event), createdAt: this.now() });
    return { accepted: result.accepted === true, duplicate: result.duplicate === true, digest };
  }
}
