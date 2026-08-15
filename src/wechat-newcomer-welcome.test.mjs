import assert from 'node:assert/strict';
import test from 'node:test';

import { WeChatNewcomerWelcome } from './wechat-newcomer-welcome.mjs';

class MemoryState {
  constructor() {
    this.values = new Map();
    this.audits = [];
  }

  key(scope, key) { return `${scope}:${key}`; }
  get(scope, key, fallback = null) { return this.values.get(this.key(scope, key)) ?? fallback; }
  set(scope, key, value) { this.values.set(this.key(scope, key), structuredClone(value)); }
  audit(event, { detail = {} } = {}) { this.audits.push({ event, detail }); }
}

function createHarness({ groupName = 'AI流程与组织变革交流二群' } = {}) {
  const state = new MemoryState();
  let members = [
    { memberId: 'wxid_existing', displayName: '老成员' },
  ];
  let nowMs = 1_000_000;
  let sendError = null;
  const sent = [];
  const channel = {
    async getChatroomInfo() { return { nickName: groupName }; },
    async getChatroomMemberList() { return structuredClone(members); },
    async send(target, text) {
      if (sendError) throw sendError;
      sent.push({ target, text });
      return { ok: true };
    },
  };
  const controller = new WeChatNewcomerWelcome({
    state,
    channel,
    groupId: 'target-room@chatroom',
    groupName: 'AI流程与组织变革交流二群',
    intervalMs: 120_000,
    now: () => nowMs,
  });
  return {
    state,
    sent,
    controller,
    setMembers(value) { members = value; },
    setSendError(value) { sendError = value; },
    advance(ms) { nowMs += ms; },
  };
}

test('first roster creates a baseline without welcoming existing members', async () => {
  const harness = createHarness();
  const result = await harness.controller.reconcile('startup');

  assert.equal(result.baselineCreated, true);
  assert.equal(harness.sent.length, 0);
  const stored = [...harness.state.values.values()][0];
  assert.equal(stored.initialized, true);
  assert.equal(stored.members.length, 1);
  assert.equal(JSON.stringify(stored).includes('wxid_existing'), false);
});

test('welcomes one newcomer once with identity, capabilities and wake instruction', async () => {
  const harness = createHarness();
  await harness.controller.reconcile('startup');
  harness.setMembers([
    { memberId: 'wxid_existing', displayName: '老成员' },
    { memberId: 'wxid_new', displayName: '一尘' },
  ]);

  await harness.controller.reconcile('system-event');
  await harness.controller.reconcile('periodic');

  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].target.id, 'target-room@chatroom');
  assert.match(harness.sent[0].text, /欢迎一尘加入「AI流程与组织变革交流二群」/);
  assert.match(harness.sent[0].text, /个人 AI 数字人/);
  assert.match(harness.sent[0].text, /图片、文件和链接/);
  assert.match(harness.sent[0].text, /@小詹/);
});

test('merges multiple newcomers into one welcome', async () => {
  const harness = createHarness();
  await harness.controller.reconcile('startup');
  harness.setMembers([
    { memberId: 'wxid_existing', displayName: '老成员' },
    { memberId: 'wxid_new_a', displayName: '甲老师' },
    { memberId: 'wxid_new_b', displayName: '乙老师' },
  ]);

  await harness.controller.reconcile('system-event');

  assert.equal(harness.sent.length, 1);
  assert.match(harness.sent[0].text, /欢迎甲老师、乙老师加入/);
});

test('persists a failed delivery and retries it later', async () => {
  const harness = createHarness();
  await harness.controller.reconcile('startup');
  harness.setMembers([
    { memberId: 'wxid_existing', displayName: '老成员' },
    { memberId: 'wxid_retry', displayName: '重试成员' },
  ]);
  harness.setSendError(new Error('temporary network failure'));

  const failed = await harness.controller.reconcile('system-event');
  assert.equal(failed.pendingCount, 1);
  assert.equal(harness.sent.length, 0);

  harness.setSendError(null);
  harness.advance(60_000);
  const recovered = await harness.controller.reconcile('periodic');
  assert.equal(recovered.pendingCount, 0);
  assert.equal(harness.sent.length, 1);
});

test('does not send when the configured group name no longer matches', async () => {
  const harness = createHarness({ groupName: '另一个群' });
  const result = await harness.controller.reconcile('startup');

  assert.equal(result.disabled, true);
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.state.audits.at(-1).event, 'wechat_newcomer_welcome_group_mismatch');
});

test('start reconciles immediately, schedules fallback, and stop cancels it', async () => {
  const state = new MemoryState();
  let scheduled = null;
  let cleared = null;
  let rosterCalls = 0;
  const controller = new WeChatNewcomerWelcome({
    state,
    channel: {
      async getChatroomInfo() { return { nickName: 'AI流程与组织变革交流二群' }; },
      async getChatroomMemberList() {
        rosterCalls += 1;
        return [{ memberId: 'wxid_existing', displayName: '老成员' }];
      },
      async send() { throw new Error('must not send baseline'); },
    },
    groupId: 'target-room@chatroom',
    groupName: 'AI流程与组织变革交流二群',
    intervalMs: 120_000,
    setIntervalImpl(callback, intervalMs) {
      scheduled = { callback, intervalMs, unref() {} };
      return scheduled;
    },
    clearIntervalImpl(handle) { cleared = handle; },
  });

  await controller.start();
  assert.equal(rosterCalls, 1);
  assert.equal(scheduled.intervalMs, 120_000);
  controller.stop();
  assert.equal(cleared, scheduled);
});
