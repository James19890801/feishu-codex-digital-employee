import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  applyOwnerCommitmentGuard,
  evaluateStableResponseInbound,
  generateStableResponse,
  sendStableGeneratedReply,
} from './stable-response-policy.mjs';
import {
  SEMANTIC_REPEAT_CLOSE_REPLY,
  SEMANTIC_REPEAT_REQUIRED_ACK_REPLY,
} from './semantic-repeat-controller.mjs';
import { REQUIRED_RESPONSE_FALLBACK_REPLY } from './required-response-fallback.mjs';

const directory = mkdtempSync(join(tmpdir(), 'james-stable-response-'));
const state = new AgentState(join(directory, 'state.sqlite'));
try {
  assert.deepEqual(applyOwnerCommitmentGuard({
    request: '走不走？',
    response: '走走走，1楼见',
    ownerLabel: '阿充',
  }), {
    text: '这个需要阿充本人确认，我不能替他约定见面或行程。',
    guarded: true,
  });
  assert.deepEqual(applyOwnerCommitmentGuard({
    request: '这个方案怎么走？',
    response: '建议先做小流量验证。',
    ownerLabel: '阿充',
  }), {
    text: '建议先做小流量验证。',
    guarded: false,
  });

  const sent = [];
  const audits = [];
  const base = {
    state,
    config: {
      responseMentionAliases: ['James', '詹老师'],
      semanticRepeatGuardEnabled: true,
      semanticRepeatWindowMs: 30 * 60_000,
      semanticRepeatMaxReplies: 2,
    },
    channel: 'enterpriseChat',
    senderId: 'enterpriseChat:peer',
    message: {
      message_id: 'inbound-1',
      chat_id: 'enterpriseChat:group:test',
      chat_type: 'group',
      message_type: 'text',
      mentions: [{ id: 'enterpriseChat-current-user' }],
    },
    metadata: { channel: 'enterpriseChat', eventType: 'message.mention.received' },
    text: '这个需要本人确认后再推进 @James',
    nowMs: 1_000,
    sendClose: async (text, idempotencyKey) => sent.push({ text, idempotencyKey }),
    audit: (event, detail) => audits.push({ event, detail }),
  };

  const first = await evaluateStableResponseInbound(base);
  assert.equal(first.responseRequired, true);
  assert.equal(first.handled, false);

  const second = await evaluateStableResponseInbound({
    ...base,
    message: { ...base.message, message_id: 'inbound-2' },
    nowMs: 2_000,
  });
  assert.equal(second.handled, true);
  assert.equal(second.repeat.action, 'close');
  assert.equal(sent.at(-1).text, SEMANTIC_REPEAT_CLOSE_REPLY);

  const third = await evaluateStableResponseInbound({
    ...base,
    message: { ...base.message, message_id: 'inbound-3' },
    nowMs: 3_000,
  });
  assert.equal(third.handled, true);
  assert.equal(third.repeat.action, 'acknowledge_required');
  assert.equal(sent.at(-1).text, SEMANTIC_REPEAT_REQUIRED_ACK_REPLY);
  let generatorCalls = 0;
  if (!third.handled) {
    await generateStableResponse({
      responseRequired: third.responseRequired,
      generate: async () => { generatorCalls += 1; return '不应执行'; },
    });
  }
  assert.equal(generatorCalls, 0);

  const fallbackAudits = [];
  const fallback = await generateStableResponse({
    responseRequired: true,
    generate: async () => { throw new Error('AI prompt failed with private text'); },
    audit: (event, detail) => fallbackAudits.push({ event, detail }),
  });
  assert.equal(fallback.text, REQUIRED_RESPONSE_FALLBACK_REPLY);
  assert.equal(fallback.fallback, true);
  assert.deepEqual(fallbackAudits, [{
    event: 'required_response_fallback_sent',
    detail: { error: 'ai_generation_error' },
  }]);

  const generatedSent = [];
  const sendBase = {
    state,
    message: {
      message_id: 'generated-1',
      chat_id: 'enterpriseChat:group:generated',
      chat_type: 'group',
    },
    senderId: 'enterpriseChat:requester',
    text: '这是一条基于资料得出的结论',
    responseRequired: true,
    nowMs: 10_000,
    windowMs: 60_000,
    send: async text => {
      generatedSent.push(text);
      return { ok: true };
    },
  };
  await sendStableGeneratedReply(sendBase);
  const repeated = await sendStableGeneratedReply({
    ...sendBase,
    message: { ...sendBase.message, message_id: 'generated-2' },
    text: '这是一条基于资料得出的结论！',
    nowMs: 11_000,
  });
  assert.equal(repeated.acknowledged, true);
  assert.equal(repeated.sentText, SEMANTIC_REPEAT_REQUIRED_ACK_REPLY);
  assert.deepEqual(generatedSent, [
    '这是一条基于资料得出的结论',
    SEMANTIC_REPEAT_REQUIRED_ACK_REPLY,
  ]);

  const directSent = [];
  for (const messageId of ['direct-1', 'direct-2']) {
    const direct = await sendStableGeneratedReply({
      ...sendBase,
      message: { message_id: messageId, chat_id: 'enterpriseChat:user:one', chat_type: 'p2p' },
      text: '私聊相同回复',
      send: async text => { directSent.push(text); return { ok: true }; },
    });
    assert.equal(direct.sentText, '私聊相同回复');
  }
  assert.deepEqual(directSent, ['私聊相同回复', '私聊相同回复']);
  assert.equal(JSON.stringify(audits).includes('本人确认'), false);
} finally {
  state.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log('STABLE_RESPONSE_POLICY_TEST_OK');
