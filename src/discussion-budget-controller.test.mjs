import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyDiscussionBudgetGate,
  appendDiscussionInstruction,
  DISCUSSION_LOW_VALUE_CLOSE_REPLY,
  shouldUseSemanticRepeatFallback,
} from './discussion-budget-controller.mjs';
import { semanticTopic } from './semantic-repeat-guard.mjs';
import { AgentState } from './state.mjs';

const directory = mkdtempSync(join(tmpdir(), 'aipro-discussion-controller-'));
const state = new AgentState(join(directory, 'state.sqlite'));
try {
  const sent = [];
  const audits = [];
  const baseMessage = {
    message_id: 'discussion-message-1',
    chat_id: 'dingtalk:group:discussion',
    chat_type: 'group',
    message_type: 'text',
  };
  const base = {
    state,
    enabled: true,
    maxReplies: 100,
    lowValueLimit: 3,
    cooldownMs: 30 * 60_000,
    channel: 'dingtalk',
    ownerAuthorized: false,
    message: baseMessage,
    sendClose: async (text, idempotencyKey) => sent.push({ text, idempotencyKey }),
    audit: (event, detail) => audits.push({ event, detail }),
  };

  const first = await applyDiscussionBudgetGate({
    ...base,
    text: '但是实时干预会不会扩大 AI 误判？我有一个新的反例。',
    nowMs: 1_000,
  });
  assert.equal(first.handled, false);
  assert.equal(first.action, 'process');
  assert.equal(first.replyCount, 1);
  assert.equal(first.eligible, true);

  assert.equal((await applyDiscussionBudgetGate({
    ...base,
    message: { ...baseMessage, message_id: 'direct-1', chat_type: 'p2p' },
    text: '同样的讨论内容',
    nowMs: 2_000,
  })).reason, 'direct_message_bypass');
  assert.equal((await applyDiscussionBudgetGate({
    ...base,
    channel: 'wechat',
    message: { ...baseMessage, message_id: 'wechat-1' },
    text: '同样的讨论内容',
    nowMs: 3_000,
  })).reason, 'channel_bypass');
  assert.equal((await applyDiscussionBudgetGate({
    ...base,
    message: { ...baseMessage, message_id: 'operator-1' },
    text: '状态',
    operatorCommand: 'status',
    nowMs: 4_000,
  })).reason, 'operator_command_bypass');

  for (let replyCount = 2; replyCount <= 19; replyCount += 1) {
    state.claimDiscussionTurn({
      channel: 'dingtalk', chatId: baseMessage.chat_id,
      messageId: `prefill-${replyCount}`,
      value: { substantive: true, score: 3, topic: semanticTopic(`第 ${replyCount} 轮新观点`) },
      nowMs: 4_000 + replyCount,
    });
  }
  const checkpoint = await applyDiscussionBudgetGate({
    ...base,
    message: { ...baseMessage, message_id: 'checkpoint-20' },
    text: '第 20 轮，我补充一个新的因果解释和案例。',
    nowMs: 5_000,
  });
  assert.equal(checkpoint.action, 'checkpoint');
  assert.match(checkpoint.checkpointPrompt, /阶段总结/);
  assert.equal(checkpoint.finalizeAfterReply, false);

  const lowChat = 'dingtalk:group:low-discussion';
  await applyDiscussionBudgetGate({
    ...base,
    message: { ...baseMessage, chat_id: lowChat, message_id: 'low-start' },
    text: '我认为流程规则治理会成为新的重点，因为例外必须有人负责。',
    nowMs: 10_000,
  });
  for (let turn = 1; turn <= 2; turn += 1) {
    const low = await applyDiscussionBudgetGate({
      ...base,
      message: { ...baseMessage, chat_id: lowChat, message_id: `low-${turn}` },
      text: turn === 1 ? '好的，我也赞同。' : '收到。',
      nowMs: 10_000 + turn,
    });
    assert.equal(low.action, 'process');
  }
  const close = await applyDiscussionBudgetGate({
    ...base,
    message: { ...baseMessage, chat_id: lowChat, message_id: 'low-3' },
    text: '行，就这样。',
    nowMs: 10_003,
  });
  assert.equal(close.action, 'close_low_value');
  assert.equal(close.handled, true);
  assert.deepEqual(sent.at(-1), {
    text: DISCUSSION_LOW_VALUE_CLOSE_REPLY,
    idempotencyKey: 'aipro-discussion-close-low-3',
  });
  const suppressed = await applyDiscussionBudgetGate({
    ...base,
    message: { ...baseMessage, chat_id: lowChat, message_id: 'low-4' },
    text: '但是我现在又想到一个新证据。',
    nowMs: 10_004,
  });
  assert.equal(suppressed.action, 'suppress_cooldown');
  assert.equal(suppressed.handled, true);
  const requiredDuringCooldown = await applyDiscussionBudgetGate({
    ...base,
    responseRequired: true,
    message: { ...baseMessage, chat_id: lowChat, message_id: 'low-required' },
    text: '这条我明确 @ 你，请确认收到。',
    nowMs: 10_004.5,
  });
  assert.equal(requiredDuringCooldown.action, 'acknowledge_required');
  assert.equal(requiredDuringCooldown.handled, true);
  assert.deepEqual(sent.at(-1), {
    text: '收到，这条我看到了；当前讨论刚收束，有新内容我继续接。',
    idempotencyKey: 'aipro-discussion-required-ack-low-required',
  });

  const restarted = await applyDiscussionBudgetGate({
    ...base,
    ownerAuthorized: true,
    message: { ...baseMessage, chat_id: lowChat, message_id: 'owner-continue' },
    text: '继续讨论',
    nowMs: 10_005,
  });
  assert.equal(restarted.action, 'process');
  assert.equal(restarted.replyCount, 1);
  assert.equal(restarted.ownerContinue, true);

  const finalChat = 'feishu:group:final';
  for (let replyCount = 1; replyCount <= 99; replyCount += 1) {
    state.claimDiscussionTurn({
      channel: 'feishu', chatId: finalChat, messageId: `final-prefill-${replyCount}`,
      value: { substantive: true, score: 3, topic: semanticTopic(`第 ${replyCount} 轮独立论据`) },
      nowMs: 20_000 + replyCount,
    });
  }
  const final = await applyDiscussionBudgetGate({
    ...base,
    channel: 'feishu',
    message: { ...baseMessage, chat_id: finalChat, message_id: 'final-100' },
    text: '最后我补充一个新的反例，请综合全部讨论。',
    nowMs: 21_000,
  });
  assert.equal(final.action, 'final');
  assert.equal(final.replyCount, 100);
  assert.equal(final.finalizeAfterReply, true);
  assert.match(final.checkpointPrompt, /最终综合/);
  assert.match(
    appendDiscussionInstruction('回答当前问题', final.checkpointPrompt),
    /回答当前问题[\s\S]*第 100 次[\s\S]*最终综合/,
  );
  assert.equal(shouldUseSemanticRepeatFallback({
    semanticEnabled: true, adaptiveEligible: true,
  }), false);
  assert.equal(shouldUseSemanticRepeatFallback({
    semanticEnabled: true, adaptiveEligible: false,
  }), true);
  assert.equal(audits.some(item => item.event === 'discussion_low_value_closed'), true);
  assert.equal(JSON.stringify(audits).includes('流程规则治理'), false, 'audit must not include raw discussion text');
} finally {
  state.close();
  rmSync(directory, { recursive: true, force: true });
}

console.log('DISCUSSION_BUDGET_CONTROLLER_TEST_OK');
