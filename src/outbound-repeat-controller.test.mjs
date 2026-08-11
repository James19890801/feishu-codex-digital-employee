import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import { sendUnlessRecentRepeat } from './outbound-repeat-controller.mjs';
import { SEMANTIC_REPEAT_REQUIRED_ACK_REPLY } from './semantic-repeat-controller.mjs';

const directory = mkdtempSync(join(tmpdir(), 'james-outbound-repeat-'));
const state = new AgentState(join(directory, 'state.sqlite'));
try {
  const sent = [];
  const audits = [];
  const base = {
    state,
    chatId: 'dingtalk:group:one',
    audienceKey: 'dingtalk:requester',
    nowMs: 1_000,
    windowMs: 10 * 60_000,
    audit: (event, detail) => audits.push({ event, detail }),
    send: async text => {
      sent.push(text);
      return { ok: true };
    },
  };

  const first = await sendUnlessRecentRepeat({
    ...base,
    text: '后面流程管理相关的我都会先检索，再基于材料回复。',
  });
  assert.equal(first.suppressed, undefined);

  const repeated = await sendUnlessRecentRepeat({
    ...base,
    nowMs: 2_000,
    text: '后面流程管理相关的我都会先检索，再基于材料回复！',
  });
  assert.deepEqual(repeated, { suppressed: true, reason: 'outbound_repeat' });
  assert.equal(sent.length, 1);

  const required = await sendUnlessRecentRepeat({
    ...base,
    nowMs: 3_000,
    responseRequired: true,
    text: '后面流程管理相关的我都会先检索，再基于材料回复。',
  });
  assert.equal(required.acknowledged, true);
  assert.equal(required.reason, 'outbound_repeat');
  assert.equal(sent.at(-1), SEMANTIC_REPEAT_REQUIRED_ACK_REPLY);

  await sendUnlessRecentRepeat({
    ...base,
    audienceKey: 'dingtalk:other-requester',
    nowMs: 4_000,
    text: '后面流程管理相关的我都会先检索，再基于材料回复。',
  });
  assert.equal(sent.length, 3);

  await sendUnlessRecentRepeat({
    ...base,
    chatId: 'dingtalk:group:progress',
    nowMs: 5_000,
    text: '项目当前完成 80%，剩余验收工作明天处理。',
  });
  await sendUnlessRecentRepeat({
    ...base,
    chatId: 'dingtalk:group:progress',
    nowMs: 6_000,
    text: '项目当前完成 90%，剩余验收工作明天处理。',
  });
  assert.equal(sent.includes('项目当前完成 80%，剩余验收工作明天处理。'), true);
  assert.equal(sent.includes('项目当前完成 90%，剩余验收工作明天处理。'), true);

  await assert.rejects(() => sendUnlessRecentRepeat({
    ...base,
    chatId: 'dingtalk:group:failure',
    nowMs: 7_000,
    text: '临时发送失败',
    send: async () => { throw new Error('temporary failure'); },
  }), /temporary failure/);
  await sendUnlessRecentRepeat({
    ...base,
    chatId: 'dingtalk:group:failure',
    nowMs: 8_000,
    text: '临时发送失败',
  });
  assert.equal(sent.includes('临时发送失败'), true);

  await sendUnlessRecentRepeat({
    ...base,
    chatId: 'dingtalk:group:downstream',
    nowMs: 9_000,
    text: '下游暂时抑制',
    send: async () => ({ suppressed: true, reason: 'hard_boundary' }),
  });
  await sendUnlessRecentRepeat({
    ...base,
    chatId: 'dingtalk:group:downstream',
    nowMs: 10_000,
    text: '下游暂时抑制',
  });
  assert.equal(sent.includes('下游暂时抑制'), true);

  const failOpenSent = [];
  const failOpenAudits = [];
  const failOpen = await sendUnlessRecentRepeat({
    ...base,
    state: { claimOutboundReply() { throw new Error('sqlite unavailable'); } },
    chatId: 'dingtalk:group:state-error',
    text: '状态库失败仍要发送',
    send: async text => {
      failOpenSent.push(text);
      return { ok: true };
    },
    audit: (event, detail) => failOpenAudits.push({ event, detail }),
  });
  assert.equal(failOpen.suppressed, undefined);
  assert.deepEqual(failOpenSent, ['状态库失败仍要发送']);
  assert.deepEqual(failOpenAudits, [{
    event: 'outbound_repeat_state_error',
    detail: {
      chatId: 'dingtalk:group:state-error',
      audienceKey: 'dingtalk:requester',
    },
  }]);

  assert.equal(audits.some(item => item.event === 'outbound_repeat_suppressed'), true);
  assert.equal(audits.some(item => item.event === 'outbound_repeat_required_acknowledged'), true);
  assert.equal(JSON.stringify(audits).includes('流程管理'), false);
} finally {
  state.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log('OUTBOUND_REPEAT_CONTROLLER_TEST_OK');
