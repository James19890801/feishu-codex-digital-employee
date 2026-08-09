import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decideWorkflow } from './bible.mjs';
import {
  enforceReplyLength,
  replyLengthPolicy,
  shouldIntroduceAssistant,
} from './conversation-etiquette.mjs';
import { buildDeliveryPlan } from './delivery-routing.mjs';
import {
  applyOwnerActivityHistory,
  applyVerifiedOwnerHistory,
  evaluateHumanTakeover,
  humanTakeoverStatus,
  takeoverSyncFailurePolicy,
} from './human-takeover.mjs';
import {
  buildDingTalkSendArgs,
  normalizeDingTalkEvent,
  prepareGroupMention,
} from './im-channels.mjs';
import { isAuthorizedMulticaOwner } from './multica-access.mjs';
import { notificationEvent } from './notification-policy.mjs';
import { PendingActionStore } from './pending-actions.mjs';
import {
  selectInboundMessages,
  selectSemanticGroupCandidates,
  shouldRetryMessage,
} from './polling.mjs';
import {
  assessGroupEngagement,
  buildSemanticEngagementPrompt,
} from './semantic-group-engagement.mjs';
import {
  assessGroupHostCandidate,
  processGroupHostCandidate,
} from './group-host-mode.mjs';
import { validateInboundPayload } from './reliability.mjs';
import {
  hasSelfChatOutboundMarker,
  markSelfChatOutbound,
  stripSelfChatOutboundMarker,
} from './self-chat-guard.mjs';
import { AgentState } from './state.mjs';
import { evaluateLicenseGuard } from './licensing/guard.mjs';
import { semanticRepeatEligibility } from './semantic-repeat-controller.mjs';
import {
  discussionBudgetEligibility,
  shouldUseSemanticRepeatFallback,
} from './discussion-budget-controller.mjs';

const cases = [];

function contract(domain, question, verify) {
  cases.push({ domain, question, verify });
}

function withState(prefix, verify) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const state = new AgentState(join(dir, 'state.sqlite'));
  try {
    return verify(state);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withAsyncState(prefix, verify) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const state = new AgentState(join(dir, 'state.sqlite'));
  try {
    return await verify(state);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const identities = {
  ownerOpenId: 'ou_owner',
  dingtalkOwnerOpenId: 'dt_owner',
};

contract('licensing', 'Does development mode preserve the existing service path?', async () => {
  const result = await evaluateLicenseGuard({ enforced: false });
  assert.equal(result.allowed, true);
  assert.equal(result.edition, 'Development');
});

contract('licensing', 'Does a clean enforced installation stay dashboard-only?', async () => {
  const result = await evaluateLicenseGuard({
    enforced: true,
    publicKey: 'invalid',
    store: {
      async ensureDeviceIdentity() { return { keyHash: `sha256:${'a'.repeat(64)}` }; },
      async loadEntitlement() { return null; },
      async loadClockState() { return null; },
    },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'activation_required');
});

for (const channel of ['feishu', 'dingtalk', 'unknown']) {
  for (const chatType of ['p2p', 'group']) {
    for (const selfChat of [false, true]) {
      for (const actor of ['owner', 'other']) {
        contract('owner-authorization',
          `${channel}/${chatType}/self=${selfChat}/${actor} can write Multica?`, () => {
            const senderId = channel === 'dingtalk'
              ? `dingtalk:${actor === 'owner' ? 'dt_owner' : 'dt_other'}`
              : actor === 'owner' ? 'ou_owner' : 'ou_other';
            const expected = actor === 'owner'
              && chatType === 'p2p'
              && selfChat
              && ['feishu', 'dingtalk'].includes(channel);
            assert.equal(isAuthorizedMulticaOwner({
              senderId,
              chatType,
              metadata: { channel, selfChat },
            }, identities), expected);
          });
      }
    }
  }
}

for (const [question, input, expected] of [
  ['Can an authenticated Owner pause?', {
    current: null, text: '数字人请退场', authenticatedOwner: true,
    nowMs: 1_000, sourceMessageId: 'owner-pause',
  }, { handled: true, suppressed: true, command: 'pause' }],
  ['Can an attacker pause?', {
    current: null, text: '数字人停止', authenticatedOwner: false,
    nowMs: 1_000, sourceMessageId: 'attacker-pause',
  }, { handled: false, suppressed: false, command: null }],
]) {
  contract('human-takeover', question, () => {
    const result = evaluateHumanTakeover(input);
    assert.equal(result.handled, expected.handled);
    assert.equal(result.suppressed, expected.suppressed);
    assert.equal(result.command, expected.command);
  });
}

for (const [question, input, expected] of [
  ['Do DingTalk group discussions use adaptive budgeting?', {
    enabled: true, channel: 'dingtalk', chatType: 'group', messageType: 'text', text: '为什么会这样？',
  }, true],
  ['Do Feishu group discussions use adaptive budgeting?', {
    enabled: true, channel: 'feishu', chatType: 'group', messageType: 'post', text: '我有一个反例。',
  }, true],
  ['Do direct messages bypass adaptive budgeting?', {
    enabled: true, channel: 'dingtalk', chatType: 'p2p', messageType: 'text', text: '为什么会这样？',
  }, false],
]) {
  contract('loop-prevention', question, () => {
    assert.equal(discussionBudgetEligibility(input).eligible, expected);
  });
}

contract('loop-prevention', 'Does the fixed repeat guard remain as the adaptive fallback?', () => {
  assert.equal(shouldUseSemanticRepeatFallback({
    semanticEnabled: true, adaptiveEligible: false,
  }), true);
  assert.equal(shouldUseSemanticRepeatFallback({
    semanticEnabled: true, adaptiveEligible: true,
  }), false);
});

contract('human-takeover', 'Does the five-minute boundary expire exactly on time?', () => {
  const current = { pausedUntilMs: 301_000 };
  assert.equal(humanTakeoverStatus(current, 300_999).active, true);
  assert.equal(humanTakeoverStatus(current, 301_000).active, false);
});

for (const [attemptNumber, expected] of [[1, 'retry'], [2, 'retry'], [3, 'proceed_degraded']]) {
  contract('human-takeover', `What happens when takeover sync attempt ${attemptNumber} fails?`, () => {
    assert.equal(takeoverSyncFailurePolicy({
      current: null,
      nowMs: 1_000,
      attemptNumber,
      maxAttempts: 3,
    }), expected);
  });
}

contract('human-takeover', 'Does cached human takeover still win during an API outage?', () => {
  for (const attemptNumber of [1, 2, 3]) {
    assert.equal(takeoverSyncFailurePolicy({
      current: { pausedUntilMs: 10_000 },
      nowMs: 1_000,
      attemptNumber,
      maxAttempts: 3,
    }), 'suppress');
  }
});

contract('human-takeover', 'Can an assistant echo accidentally extend human takeover?', () => {
  const applied = applyOwnerActivityHistory([{
    content: '真人说话', createTime: '2026-08-02 08:00:00',
    openMessageId: 'owner-1', senderOpenDingTalkId: 'owner',
  }, {
    content: '助理回复', createTime: '2026-08-02 08:01:00',
    openMessageId: 'assistant-1', senderOpenDingTalkId: 'owner',
  }], {
    ownerId: 'owner',
    nowMs: Date.parse('2026-08-02T08:02:00+08:00'),
    parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
    isAssistantMessage: message => message.openMessageId === 'assistant-1',
  });
  assert.equal(applied.activities.length, 1);
  assert.equal(applied.state.lastActivityMessageId, 'owner-1');
});

contract('human-takeover', 'Does normal Owner activity stop only a direct conversation?', () => {
  const messages = [{
    content: '我真人接手', createTime: '2026-08-02 08:00:00',
    openMessageId: 'owner-direct', senderOpenDingTalkId: 'owner',
  }];
  const options = {
    ownerId: 'owner',
    nowMs: Date.parse('2026-08-02T08:00:01+08:00'),
    parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
  };
  assert.equal(applyVerifiedOwnerHistory(messages, { ...options, chatType: 'p2p' }).active, true);
  assert.equal(applyVerifiedOwnerHistory(messages, { ...options, chatType: 'group' }).changed, false);
});

for (const [question, input, expected] of [
  ['Does a DingTalk group reply @ the requester?', {
    chatId: 'dingtalk:group:cid-1', chatType: 'group',
    senderId: 'dingtalk:requester-1', text: '已处理',
  }, { prefix: '<@requester-1>', at: ['requester-1'] }],
  ['Does a Feishu group reply @ the requester?', {
    chatId: 'oc_group', chatType: 'group', senderId: 'ou_requester1', text: '已处理',
  }, { prefix: '<at user_id="ou_requester1">', at: [] }],
  ['Does a direct reply avoid accidental @?', {
    chatId: 'dingtalk:user:requester-1', chatType: 'p2p',
    senderId: 'dingtalk:requester-1', text: '已处理',
  }, { prefix: '已处理', at: [] }],
  ['Does a missing sender ID degrade without a malformed @?', {
    chatId: 'dingtalk:group:cid-1', chatType: 'group', senderId: '', text: '已处理',
  }, { prefix: '已处理', at: [] }],
]) {
  contract('group-attribution', question, () => {
    const result = prepareGroupMention(input);
    assert.equal(result.text.startsWith(expected.prefix), true);
    assert.deepEqual(result.atOpenDingTalkIds, expected.at);
  });
}

contract('group-attribution', 'Are DingTalk mentions deduplicated and bounded?', () => {
  const ids = Array.from({ length: 25 }, (_, index) => `user-${index}`);
  const text = ids.map(id => `<@${id}>`).join(' ') + '\n通知';
  const args = buildDingTalkSendArgs(
    { channel: 'dingtalk', kind: 'group', id: 'cid-1' },
    text,
    'bounded-mentions',
    { atOpenDingTalkIds: [...ids, 'user-0'] },
  );
  const mentioned = args[args.indexOf('--at-open-dingtalk-ids') + 1].split(',');
  assert.equal(mentioned.length, 20);
  assert.equal(new Set(mentioned).size, 20);
});

contract('group-attribution', 'Can a missing DingTalk @ placeholder pass silently?', () => {
  assert.throws(() => buildDingTalkSendArgs(
    { channel: 'dingtalk', kind: 'group', id: 'cid-1' },
    '没有占位符',
    'missing-placeholder',
    { atOpenDingTalkIds: ['requester-1'] },
  ), /mention placeholder/i);
});

for (const [question, input, expected] of [
  ['Do DingTalk group text messages enter semantic loop protection?', {
    enabled: true, channel: 'dingtalk', chatType: 'group', messageType: 'text', text: '继续讨论',
  }, true],
  ['Do Feishu group posts enter semantic loop protection?', {
    enabled: true, channel: 'feishu', chatType: 'group', messageType: 'post', text: '继续讨论',
  }, true],
  ['Do direct messages remain unchanged?', {
    enabled: true, channel: 'dingtalk', chatType: 'p2p', messageType: 'text', text: '继续讨论',
  }, false],
  ['Do unsupported channels remain unchanged?', {
    enabled: true, channel: 'wechat', chatType: 'group', messageType: 'text', text: '继续讨论',
  }, false],
  ['Do media-only messages remain unchanged?', {
    enabled: true, channel: 'dingtalk', chatType: 'group', messageType: 'image', text: '',
  }, false],
]) {
  contract('loop-prevention', question, () => {
    assert.equal(semanticRepeatEligibility(input).eligible, expected);
  });
}

for (const [question, event, accepted] of [
  ['Is a valid DingTalk group @ event accepted?', {
    type: 'user_im_message_receive_at', message_id: 'm1', conversation_id: 'c1',
    sender_open_dingtalk_id: 'u1', content: '@AIPRO 你好',
  }, true],
  ['Is a valid DingTalk direct event accepted?', {
    type: 'user_im_message_receive_o2o_all', event_id: 'e1',
    sender_open_dingtalk_id: 'u1', content: '你好',
  }, true],
  ['Is an unrelated DingTalk event rejected?', {
    type: 'user_im_message_recalled', event_id: 'e2', sender_open_dingtalk_id: 'u1',
  }, false],
  ['Is an event without sender rejected?', {
    type: 'user_im_message_receive_at', message_id: 'm2', conversation_id: 'c1',
  }, false],
  ['Is a group event without conversation rejected?', {
    type: 'user_im_message_receive_at', message_id: 'm3', sender_open_dingtalk_id: 'u1',
  }, false],
]) {
  contract('inbound-normalization', question, () => {
    assert.equal(Boolean(normalizeDingTalkEvent(event)), accepted);
  });
}

for (const [question, payload, expectedReason] of [
  ['Does a valid normalized payload pass?', {
    message: { message_id: 'm', chat_id: 'c', chat_type: 'p2p' },
    sender: { sender_type: 'user', sender_id: { open_id: 'u' } },
  }, ''],
  ['Is a payload without message ID rejected?', {
    message: { chat_id: 'c', chat_type: 'p2p' },
    sender: { sender_type: 'user', sender_id: { open_id: 'u' } },
  }, 'missing message_id'],
  ['Is an invalid chat type rejected?', {
    message: { message_id: 'm', chat_id: 'c', chat_type: 'channel' },
    sender: { sender_type: 'user', sender_id: { open_id: 'u' } },
  }, 'invalid chat_type'],
  ['Is a user without identity rejected?', {
    message: { message_id: 'm', chat_id: 'c', chat_type: 'group' },
    sender: { sender_type: 'user', sender_id: {} },
  }, 'missing sender open_id'],
]) {
  contract('inbound-validation', question, () => {
    const result = validateInboundPayload(payload);
    assert.equal(result.ok, expectedReason === '');
    assert.equal(result.reason || '', expectedReason);
  });
}

contract('durable-inbox', 'Can duplicate transports enqueue the same message twice?', () => {
  withState('aipro-acceptance-inbox-', state => {
    const now = '2026-08-02T00:00:00.000Z';
    assert.equal(state.enqueueInbound('m1', 'websocket', { value: 1 }, now), true);
    assert.equal(state.enqueueInbound('m1', 'polling', { value: 2 }, now), false);
    assert.equal(state.claimInbound('m1', now), true);
    assert.equal(state.claimInbound('m1', now), false);
  });
});

contract('durable-inbox', 'Does a failed message wait until its retry time?', () => {
  withState('aipro-acceptance-retry-', state => {
    const now = '2026-08-02T00:00:00.000Z';
    state.enqueueInbound('m1', 'event', { ok: true }, now);
    state.claimInbound('m1', now);
    state.failInbound('m1', 'temporary', '2026-08-02T00:00:05.000Z', now);
    assert.equal(state.claimInbound('m1', '2026-08-02T00:00:04.999Z'), false);
    assert.equal(state.claimInbound('m1', '2026-08-02T00:00:05.000Z'), true);
  });
});

contract('durable-inbox', 'Can a completed message be claimed again?', () => {
  withState('aipro-acceptance-complete-', state => {
    const now = '2026-08-02T00:00:00.000Z';
    state.enqueueInbound('m1', 'event', { ok: true }, now);
    state.claimInbound('m1', now);
    state.completeInbound('m1', now);
    assert.equal(state.claimInbound('m1', '2026-08-02T01:00:00.000Z'), false);
  });
});

contract('loop-prevention', 'Is the invisible self-chat marker idempotent and removable?', () => {
  const marked = markSelfChatOutbound('回复');
  assert.equal(hasSelfChatOutboundMarker(marked), true);
  assert.equal(markSelfChatOutbound(marked), marked);
  assert.equal(stripSelfChatOutboundMarker(marked), '回复');
});

contract('loop-prevention', 'Can the same outbound echo be consumed twice?', () => {
  withState('aipro-acceptance-echo-', state => {
    const now = '2026-08-02T00:00:00.000Z';
    state.recordOutboundEcho('self', '回复', { now, ttlMs: 60_000 });
    assert.equal(state.consumeOutboundEcho('self', '回复', { now }), true);
    assert.equal(state.consumeOutboundEcho('self', '回复', { now }), false);
  });
});

contract('loop-prevention', 'Does the circuit breaker isolate different self chats?', () => {
  withState('aipro-acceptance-circuit-', state => {
    const options = { windowMs: 60_000, limit: 2, cooldownMs: 120_000 };
    assert.equal(state.claimSelfChatOutbound('a', 1_000, options).allowed, true);
    assert.equal(state.claimSelfChatOutbound('a', 2_000, options).allowed, true);
    assert.equal(state.claimSelfChatOutbound('a', 3_000, options).allowed, false);
    assert.equal(state.claimSelfChatOutbound('b', 3_000, options).allowed, true);
  });
});

contract('pending-confirmation', 'Can one user confirm another user\'s pending action?', () => {
  withState('aipro-acceptance-pending-user-', state => {
    const pending = new PendingActionStore(state, { ttlMs: 10_000 });
    pending.set('multica_feedback', 'chat', 'user-a', { sourceMessageId: 'm1' }, 1_000);
    assert.equal(pending.get('multica_feedback', 'chat', 'user-b', 2_000), null);
    assert.deepEqual(pending.get('multica_feedback', 'chat', 'user-a', 2_000), {
      sourceMessageId: 'm1',
    });
  });
});

contract('pending-confirmation', 'Can confirmation leak across conversations?', () => {
  withState('aipro-acceptance-pending-chat-', state => {
    const pending = new PendingActionStore(state, { ttlMs: 10_000 });
    pending.set('multica_feedback', 'chat-a', 'user', { sourceMessageId: 'm1' }, 1_000);
    assert.equal(pending.get('multica_feedback', 'chat-b', 'user', 2_000), null);
  });
});

contract('pending-confirmation', 'Does an expired pending action remain executable?', () => {
  withState('aipro-acceptance-pending-ttl-', state => {
    const pending = new PendingActionStore(state, { ttlMs: 10_000 });
    pending.set('multica_feedback', 'chat', 'user', { sourceMessageId: 'm1' }, 1_000);
    assert.equal(pending.get('multica_feedback', 'chat', 'user', 11_000), null);
  });
});

for (const [request, detailed, maxChars] of [
  ['你好', false, 48],
  ['这件事你怎么看？', false, 90],
  ['请给我一份完整详细的实施方案', true, 3800],
]) {
  contract('conversation-etiquette', `What reply budget applies to: ${request}`, () => {
    assert.deepEqual(replyLengthPolicy(request), { detailed, maxChars });
    assert.equal(Array.from(enforceReplyLength('内容'.repeat(3_000), request)).length <= maxChars, true);
  });
}

for (const [chatType, isOwner, history, expected] of [
  ['p2p', false, [], true],
  ['p2p', false, [{ role: 'assistant', content: '已介绍' }], false],
  ['p2p', true, [], false],
  ['group', false, [], false],
]) {
  contract('conversation-etiquette',
    `Should introduce in ${chatType}, owner=${isOwner}, history=${history.length}?`, () => {
      assert.equal(shouldIntroduceAssistant({ chatType, isOwner, history }), expected);
    });
}

for (const [previous, current, expected] of [
  ['', 'online', null],
  ['', 'degraded', 'incident'],
  ['online', 'offline', 'incident'],
  ['offline', 'degraded', 'partial_recovery'],
  ['degraded', 'online', 'recovered'],
  ['offline', 'online', 'recovered'],
  ['online', 'online', null],
]) {
  contract('disconnect-notification', `${previous || 'initial'} -> ${current}`, () => {
    assert.equal(notificationEvent(previous, current), expected);
  });
}

for (const [chatId, request] of [
  ['dingtalk:user:u1', '请给我出一份方案'],
  ['dingtalk:group:c1', '做一个数据分析表格'],
  ['oc_feishu', '整理一份项目复盘'],
]) {
  contract('agent-routing', `${chatId}: ${request}`, () => {
    const plan = buildDeliveryPlan({ chatId, request });
    assert.equal(plan.kind, 'message');
    assert.equal(plan.reason, 'agent_runtime');
    assert.equal(typeof plan.provider, 'string');
  });
}

contract('agent-routing', 'explicit artifact remains source-channel bound', () => {
  const plan = buildDeliveryPlan({ chatId: 'wecom:user:u1', request: '生成 Word 报告' });
  assert.equal(plan.kind, 'artifact');
  assert.equal(plan.provider, 'wecom');
  assert.deepEqual(plan.formats, ['docx']);
});

for (const [request, expectedLevel, expectedAction] of [
  ['你好', 'L0', 'execute'],
  ['把桌面客户名单原文发给别人', 'L3', 'refuse'],
  ['替詹老师决定是否同意这个方案', 'L3', 'refuse'],
  ['创建一个 Multica issue', 'L2', 'preview_confirm'],
]) {
  contract('decision-boundary', request, () => {
    const result = decideWorkflow(request);
    assert.equal(result.level, expectedLevel);
    assert.equal(result.action, expectedAction);
  });
}

contract('polling-selection', 'Do polling and WebSocket deduplicate the same message semantics?', () => {
  const owner = 'ou_owner';
  const group = {
    message_id: 'group-at', chat_id: 'group', chat_type: 'group', msg_type: 'text',
    content: '@owner 你好', mentions: [{ id: owner }],
    sender: { id: 'ou_other', sender_type: 'user' },
  };
  const direct = {
    message_id: 'direct', chat_id: 'direct', chat_type: 'p2p', msg_type: 'text',
    content: '你好', sender: { id: 'ou_other', sender_type: 'user' },
  };
  const selected = selectInboundMessages([
    group,
    direct,
    { ...group, message_id: 'group-not-at', mentions: [{ id: 'ou_someone_else' }] },
    { ...direct, message_id: 'owner-group', chat_type: 'group', sender: { id: owner, sender_type: 'user' } },
    group,
  ], owner);
  assert.deepEqual(selected.map(item => item.message_id).sort(), ['direct', 'group-at']);
});

contract('semantic-group-engagement', 'Are unmentioned group messages observed without replacing the mention fast path?', () => {
  const candidates = selectSemanticGroupCandidates([{
    message_id: 'semantic-1', chat_id: 'group-1', chat_type: 'group', msg_type: 'text',
    content: 'AI 对流程管理有什么影响？', mentions: [],
    sender: { id: 'member-1', sender_type: 'user' },
  }], identities.ownerOpenId, 'app-id');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].semantic_candidate, true);
});

contract('semantic-group-engagement', 'Does a named unmentioned message enter the reply workflow?', () => {
  assert.equal(assessGroupEngagement({
    enabled: true, chatType: 'group', messageType: 'text',
    text: '詹老师助理，这一点你怎么看？', aliases: ['詹老师助理'],
  }).action, 'reply_named');
});

contract('semantic-group-engagement', 'Is semantic classification limited to the preceding 30 group messages?', () => {
  const prompt = buildSemanticEngagementPrompt({
    text: '这个问题要不要参与？', senderId: 'member-1',
    recentMessages: Array.from({ length: 31 }, (_, index) => ({
      role: 'user', senderId: `member-${index}`, content: `context-${index + 1}`,
    })),
  });
  assert.equal(prompt.includes('context-1\n'), false);
  assert.equal(prompt.includes('context-2'), true);
  assert.equal(prompt.includes('context-31'), true);
});

contract('group-host-mode', 'Does an allowlisted public topic wait for the full grace period?', () => {
  withState('aipro-acceptance-group-host-grace-', state => {
    const assessment = assessGroupHostCandidate({
      enabled: true,
      allowlisted: true,
      chatType: 'group',
      messageType: 'text',
      text: '大家怎么看 AI 对项目协作方式的影响？',
    });
    assert.equal(assessment.eligible, true);
    state.scheduleGroupHostCandidate({
      messageId: 'host-grace-1',
      chatId: 'dingtalk:group:test',
      senderId: 'dingtalk:member-a',
      text: '大家怎么看 AI 对项目协作方式的影响？',
      topic: assessment.topic,
      createdAtMs: 1_000,
      dueAtMs: 76_000,
    });
    assert.equal(state.claimDueGroupHostCandidate(75_999), null);
    assert.equal(state.claimDueGroupHostCandidate(76_000).messageId, 'host-grace-1');
  });
});

contract('group-host-mode', 'Does another member picking up the topic prevent host output?', async () => {
  let sends = 0;
  const result = await processGroupHostCandidate({
    candidate: {
      messageId: 'host-human-1',
      senderId: 'dingtalk:member-a',
      text: '大家怎么看 AI 对项目协作方式的影响？',
      createdAtMs: 1_000,
    },
    recentMessages: [{
      role: 'user',
      senderId: 'dingtalk:member-b',
      content: '我认为首先会降低团队等待反馈的时间。',
      createdAt: new Date(2_000).toISOString(),
    }],
    runDecisionClassifier: async () => { throw new Error('classifier should not run'); },
    runReplyGenerator: async () => { throw new Error('generator should not run'); },
    send: async () => { sends += 1; },
  });
  assert.equal(result.action, 'human_picked_up');
  assert.equal(sends, 0);
});

contract('group-host-mode', 'Does a recovered send failure produce only one successful host reply?', async () => {
  await withAsyncState('aipro-acceptance-group-host-retry-', async state => {
    const text = '大家怎么看 AI 对项目协作方式的影响？';
    const assessment = assessGroupHostCandidate({
      enabled: true, allowlisted: true, chatType: 'group', messageType: 'text', text,
    });
    state.scheduleGroupHostCandidate({
      messageId: 'host-retry-1', chatId: 'dingtalk:group:test',
      senderId: 'dingtalk:member-a', text, topic: assessment.topic,
      createdAtMs: 1_000, dueAtMs: 2_000,
    });
    let successfulSends = 0;
    const reply = '这个话题值得接住。一个关键变化是数字人会开始识别协作里的等待和断点，让协调从被动催办转向主动发现风险。大家更看重效率提升，还是判断过程保持透明？';
    const run = candidate => processGroupHostCandidate({
      candidate,
      recentMessages: [],
      runDecisionClassifier: async () => '{"action":"host","confidence":0.95,"reasonCode":"silent"}',
      runReplyGenerator: async () => reply,
      send: async () => {
        if (candidate.attempts === 1) throw new Error('temporary send failure');
        successfulSends += 1;
      },
    });
    const first = state.claimDueGroupHostCandidate(2_000);
    await assert.rejects(run(first), /temporary send failure/);
    state.retryGroupHostCandidate(first.messageId, 'temporary', 3_000, 2_100, 3);
    const second = state.claimDueGroupHostCandidate(3_000);
    const result = await run(second);
    assert.equal(result.action, 'replied');
    state.completeGroupHostCandidate(second.messageId, 'host_replied', 3_100);
    assert.equal(successfulSends, 1);
    assert.equal(state.claimDueGroupHostCandidate(10_000), null);
  });
});

for (const [attempt, expected] of [[1, true], [2, true], [3, false], [4, false]]) {
  contract('retry-boundary', `Should inbound attempt ${attempt} retry?`, () => {
    assert.equal(shouldRetryMessage(attempt), expected);
  });
}

const failures = [];
const totalsByDomain = {};
for (const testCase of cases) {
  totalsByDomain[testCase.domain] = (totalsByDomain[testCase.domain] || 0) + 1;
  try {
    await testCase.verify();
  } catch (error) {
    failures.push({
      domain: testCase.domain,
      question: testCase.question,
      error: String(error?.message || error),
    });
  }
}

console.log(JSON.stringify({
  ok: failures.length === 0,
  total: cases.length,
  passed: cases.length - failures.length,
  failed: failures.length,
  domains: totalsByDomain,
  failures,
}, null, 2));

if (failures.length) {
  throw new Error(`MECHANISM_ACCEPTANCE_FAILED ${failures.length}/${cases.length}`);
}

console.log(`MECHANISM_ACCEPTANCE_OK ${cases.length}`);
