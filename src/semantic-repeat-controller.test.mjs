import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySemanticRepeatGate,
  SEMANTIC_REPEAT_CLOSE_REPLY,
  SEMANTIC_REPEAT_REQUIRED_ACK_REPLY,
} from './semantic-repeat-controller.mjs';
import { AgentState } from './state.mjs';

const directory = mkdtempSync(join(tmpdir(), 'james-semantic-controller-'));
const state = new AgentState(join(directory, 'state.sqlite'));
try {
  const sent = [];
  const audits = [];
  let aiCalls = 0;
  const base = {
    state,
    enabled: true,
    windowMs: 30 * 60_000,
    maxReplies: 2,
    channel: 'dingtalk',
    senderId: 'dingtalk:other-bot',
    message: {
      message_id: 'message-1',
      chat_id: 'dingtalk:group:test',
      chat_type: 'group',
      message_type: 'text',
    },
    sendClose: async (text, idempotencyKey) => sent.push({ text, idempotencyKey }),
    audit: (event, detail) => audits.push({ event, detail }),
  };

  const route = async input => {
    const result = await applySemanticRepeatGate(input);
    if (!result.handled) aiCalls += 1;
    return result;
  };

  assert.equal((await route({
    ...base,
    text: '这个需要本人确认安排，我帮您转达一下。',
    nowMs: 1_000,
  })).action, 'process');
  assert.equal(aiCalls, 1);

  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'message-2' },
    text: '等本人确认后再推进，确认了发我一声。',
    nowMs: 2_000,
  })).action, 'close');
  assert.equal(aiCalls, 1);
  assert.deepEqual(sent, [{
    text: SEMANTIC_REPEAT_CLOSE_REPLY,
    idempotencyKey: 'james-semantic-repeat-close-message-2',
  }]);

  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'message-3' },
    text: '这个需要本人确认后再推进。',
    nowMs: 3_000,
  })).action, 'suppress');
  assert.equal(aiCalls, 1);
  assert.equal(sent.length, 1);

  const required = await route({
    ...base,
    responseRequired: true,
    message: { ...base.message, message_id: 'message-required' },
    text: '这个需要本人确认后再推进。 @詹老师',
    nowMs: 3_500,
  });
  assert.equal(required.action, 'acknowledge_required');
  assert.equal(required.handled, true);
  assert.deepEqual(sent.at(-1), {
    text: SEMANTIC_REPEAT_REQUIRED_ACK_REPLY,
    idempotencyKey: 'james-semantic-repeat-required-ack-message-required',
  });

  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'message-4' },
    text: 'MYS-12 已完成，请查看新结果。',
    nowMs: 4_000,
  })).action, 'process');
  assert.equal(aiCalls, 2);

  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'direct-1', chat_type: 'p2p' },
    text: '同样内容',
  })).reason, 'direct_message_bypass');
  assert.equal((await route({
    ...base,
    channel: 'wechat',
    message: { ...base.message, message_id: 'wechat-1' },
    text: '同样内容',
  })).reason, 'channel_bypass');
  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'status-1' },
    text: '状态',
    operatorCommand: 'status',
  })).reason, 'operator_command_bypass');

  const retryBase = {
    ...base,
    senderId: 'dingtalk:retry-bot',
    message: { ...base.message, message_id: 'retry-first' },
    text: '同一个重复发送问题需要确认',
    nowMs: 10_000,
  };
  await applySemanticRepeatGate(retryBase);
  const failedClose = {
    ...retryBase,
    message: { ...retryBase.message, message_id: 'retry-close' },
    nowMs: 11_000,
    sendClose: async () => { throw new Error('temporary send failure'); },
  };
  await assert.rejects(() => applySemanticRepeatGate(failedClose), /temporary send failure/);
  const retrySent = [];
  assert.equal((await applySemanticRepeatGate({
    ...failedClose,
    sendClose: async text => retrySent.push(text),
  })).action, 'close');
  assert.deepEqual(retrySent, [SEMANTIC_REPEAT_CLOSE_REPLY]);

  const stateErrors = [];
  const failOpen = await applySemanticRepeatGate({
    ...base,
    state: { claimSemanticRepeat() { throw new Error('sqlite unavailable'); } },
    message: { ...base.message, message_id: 'state-error' },
    text: '这条应该继续处理',
    audit: (event, detail) => stateErrors.push({ event, detail }),
  });
  assert.equal(failOpen.handled, false);
  assert.equal(failOpen.reason, 'state_error');
  assert.deepEqual(stateErrors, [{
    event: 'semantic_repeat_state_error',
    detail: { channel: 'dingtalk', chatId: 'dingtalk:group:test', senderId: 'dingtalk:other-bot' },
  }]);

  assert.equal(audits.some(item => item.event === 'semantic_repeat_closed'), true);
  assert.equal(audits.some(item => item.event === 'semantic_repeat_suppressed'), true);
  assert.equal(JSON.stringify(audits).includes('本人确认'), false);
} finally {
  state.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log('SEMANTIC_REPEAT_CONTROLLER_TEST_OK');
