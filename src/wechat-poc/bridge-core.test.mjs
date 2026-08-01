import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeChatPocBridge } from './bridge-core.mjs';
import { WeChatPocControlStore } from './control-store.mjs';
import { WeChatPocState } from './state.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-wechat-bridge-'));
let clock = 0;
const now = () => new Date(Date.UTC(2026, 7, 1, 3, 0, clock++)).toISOString();
const controlStore = new WeChatPocControlStore({ directory, now });
const state = new WeChatPocState(join(directory, 'state.sqlite'));

function observation(suffix, overrides = {}) {
  return {
    sourceMessageId: `source-${suffix}`,
    conversationTitle: `受控联系人-${suffix}`,
    conversationKind: 'direct',
    senderName: `受控联系人-${suffix}`,
    direction: 'incoming',
    contentType: 'text',
    text: `消息-${suffix}`,
    observedAt: `2026-08-01T03:01:${String(suffix).padStart(2, '0')}.000Z`,
    ...overrides,
  };
}

class FakeUi {
  observations = [];
  inserted = [];
  sent = [];
  available = true;
  reason = '';
  targetMatches = true;
  uncertain = false;
  onInsert = null;

  async probe() {
    return { available: this.available, reason: this.reason };
  }

  async scan() {
    return [...this.observations];
  }

  async resolveTarget(event) {
    return { matched: this.targetMatches, proof: { chatId: event.chatId, nonce: event.messageId } };
  }

  async verifyTarget(proof, event) {
    return this.targetMatches && proof.chatId === event.chatId;
  }

  async insertText(proof, text) {
    this.inserted.push({ proof, text });
    if (this.onInsert) await this.onInsert();
    return { inserted: true };
  }

  async send(proof) {
    if (this.uncertain) return { sent: false, uncertain: true, error: 'no visible confirmation' };
    this.sent.push(proof);
    return { sent: true };
  }
}

const ui = new FakeUi();
let activeReplies = 0;
let maxActiveReplies = 0;
const responder = {
  async reply(event) {
    activeReplies += 1;
    maxActiveReplies = Math.max(maxActiveReplies, activeReplies);
    await Promise.resolve();
    activeReplies -= 1;
    return `回复：${event.text}`;
  },
};
const bridge = new WeChatPocBridge({
  controlStore,
  state,
  ui,
  responder,
  maxQueue: 4,
});

try {
  const initialized = await bridge.initialize();
  assert.equal(initialized.enabled, true, 'first launch should connect by default');
  assert.equal(initialized.reason, 'auto_enabled');

  ui.observations = [observation(1)];
  await bridge.tick();
  assert.equal(ui.sent.length, 1);
  await bridge.tick();
  assert.equal(ui.sent.length, 1, 'duplicate scan must not send twice');

  ui.observations = [
    observation(2, {
      conversationTitle: '受控测试群',
      conversationKind: 'group',
      mentionedSelf: false,
    }),
    observation(3, {
      conversationTitle: '受控测试群',
      conversationKind: 'group',
      mentionedSelf: true,
    }),
  ];
  await bridge.tick();
  assert.equal(ui.sent.length, 2, 'only the explicit group mention should send');

  ui.observations = [observation(4)];
  ui.onInsert = () => controlStore.setEnabled(false, { reason: 'operator_stop' });
  await bridge.tick();
  assert.equal(ui.sent.length, 2, 'switch epoch change before send must cancel');
  assert.equal(state.statusCounts().cancelled >= 1, true);
  ui.onInsert = null;

  await controlStore.setEnabled(true, { reason: 'operator' });
  ui.targetMatches = false;
  ui.observations = [observation(5)];
  await bridge.tick();
  assert.equal(ui.sent.length, 2, 'target mismatch must abort');
  ui.targetMatches = true;

  ui.uncertain = true;
  ui.observations = [observation(6)];
  await bridge.tick();
  assert.equal(state.statusCounts().uncertain, 1);
  assert.equal((await controlStore.read()).enabled, false, 'uncertain send must trip the safety fuse');
  await bridge.tick();
  assert.equal(state.statusCounts().uncertain, 1, 'uncertain send must not retry');
  ui.uncertain = false;
  await controlStore.setEnabled(true, { reason: 'operator' });

  ui.available = false;
  ui.reason = 'screen_locked';
  ui.observations = [observation(7)];
  const sentBeforePause = ui.sent.length;
  const paused = await bridge.tick();
  assert.equal((await controlStore.read()).enabled, true);
  assert.equal(paused.degraded, 'ui_screen_locked');
  assert.equal(ui.sent.length, sentBeforePause, 'paused UI must not send');
  ui.available = true;

  ui.observations = Array.from({ length: 8 }, (_, index) => observation(20 + index));
  const sentBeforeFlood = ui.sent.length;
  await bridge.tick();
  assert.equal(ui.sent.length - sentBeforeFlood <= 4, true, 'queue cap must bound flood work');
  assert.equal(maxActiveReplies, 1, 'POC replies must remain serialized in phase one');

  await bridge.stop('test_stop');
  assert.equal((await controlStore.read()).enabled, false);
  console.log('WECHAT_POC_BRIDGE_CORE_TEST_OK');
} finally {
  state.close();
  await rm(directory, { recursive: true, force: true });
}
