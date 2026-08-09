import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applySemanticRepeatGate,
  SEMANTIC_REPEAT_CLOSE_REPLY,
} from './semantic-repeat-controller.mjs';
import { AgentState } from './state.mjs';

const directory = mkdtempSync(join(tmpdir(), 'aipro-semantic-controller-'));
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
    text: '收到，这个需要杨红宝本人确认安排，我帮您转达一下。',
    nowMs: 1_000,
  })).action, 'process');
  assert.equal(aiCalls, 1);

  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'message-2' },
    text: '等杨红宝本人确认后再推进，确认了发我一声。',
    nowMs: 2_000,
  })).action, 'close');
  assert.equal(aiCalls, 1, 'the closing response must not invoke the AI runtime');
  assert.deepEqual(sent, [{
    text: SEMANTIC_REPEAT_CLOSE_REPLY,
    idempotencyKey: 'aipro-semantic-repeat-close-message-2',
  }]);

  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'message-3' },
    text: '这个需要杨红宝本人确认后再推进。',
    nowMs: 3_000,
  })).action, 'suppress');
  assert.equal(aiCalls, 1, 'the third repeat must not invoke the AI runtime');
  assert.equal(sent.length, 1, 'the third repeat must be silent');

  const requiredRepeat = await route({
    ...base,
    responseRequired: true,
    message: { ...base.message, message_id: 'message-required' },
    text: '这个需要杨红宝本人确认后再推进。 @詹老师',
    nowMs: 3_500,
  });
  assert.equal(requiredRepeat.action, 'acknowledge_required');
  assert.equal(requiredRepeat.handled, true);
  assert.deepEqual(sent.at(-1), {
    text: '收到，这条我看到了；相同内容我不重复展开，有新问题我继续接。',
    idempotencyKey: 'aipro-semantic-repeat-required-ack-message-required',
  });

  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'message-4' },
    text: 'MYS-12 已完成，请查看新结果。',
    nowMs: 4_000,
  })).action, 'process');
  assert.equal(aiCalls, 2, 'new information must reach normal processing');

  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'direct-1', chat_type: 'p2p' },
    text: '同样内容',
    nowMs: 5_000,
  })).reason, 'direct_message_bypass');
  assert.equal((await route({
    ...base,
    channel: 'wechat',
    message: { ...base.message, message_id: 'wechat-1' },
    text: '同样内容',
    nowMs: 6_000,
  })).reason, 'channel_bypass');
  assert.equal((await route({
    ...base,
    message: { ...base.message, message_id: 'status-1' },
    text: '状态',
    operatorCommand: 'status',
    nowMs: 7_000,
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
  const retried = await applySemanticRepeatGate({
    ...failedClose,
    sendClose: async text => retrySent.push(text),
  });
  assert.equal(retried.action, 'close', 'retrying the same inbound must retry the close');
  assert.deepEqual(retrySent, [SEMANTIC_REPEAT_CLOSE_REPLY]);

  assert.equal(audits.some(item => item.event === 'semantic_repeat_closed'), true);
  assert.equal(audits.some(item => item.event === 'semantic_repeat_suppressed'), true);
  assert.equal(JSON.stringify(audits).includes('杨红宝'), false, 'audits must not contain message text');
} finally {
  state.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log('SEMANTIC_REPEAT_CONTROLLER_TEST_OK');
