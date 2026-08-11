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
import { isAuthorizedMailOwner } from './mail-workflow.mjs';
import { selectInboundMessages, shouldRetryMessage } from './polling.mjs';
import { validateInboundPayload } from './reliability.mjs';
import {
  hasSelfChatOutboundMarker,
  markSelfChatOutbound,
  stripSelfChatOutboundMarker,
} from './self-chat-guard.mjs';
import { AgentState } from './state.mjs';
import { evaluateLicenseGuard } from './licensing/guard.mjs';
import {
  ReplyContextService,
  executeGroundedReply,
} from './reply-context.mjs';
import {
  AutomationPeerGuard,
  handleAutomationPeerInbound,
} from './automation-peer-guard.mjs';
import { assessResponseObligation } from './response-obligation.mjs';
import { REQUIRED_RESPONSE_FALLBACK_REPLY } from './required-response-fallback.mjs';
import { semanticRepeatEligibility } from './semantic-repeat-controller.mjs';
import {
  evaluateStableResponseInbound,
  generateStableResponse,
  sendStableGeneratedReply,
} from './stable-response-policy.mjs';

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

const identities = {
  ownerOpenId: 'ou_owner',
  dingtalkOwnerOpenId: 'dt_owner',
};

contract('mail-authorization', 'Can only the verified DingTalk Owner self-chat read mail?', () => {
  const base = {
    senderId: 'dingtalk:dt_owner', chatType: 'p2p',
    metadata: { channel: 'dingtalk', selfChat: true },
  };
  assert.equal(isAuthorizedMailOwner(base, ['dingtalk:dt_owner']), true);
  assert.equal(isAuthorizedMailOwner({ ...base, chatType: 'group' }, ['dingtalk:dt_owner']), false);
  assert.equal(isAuthorizedMailOwner({ ...base, senderId: 'dingtalk:other' }, ['dingtalk:dt_owner']), false);
});

contract('mail-confirmation', 'Does mail confirmation use a 15-minute same-chat lease?', () => {
  withState('james-acceptance-mail-', state => {
    const pending = new PendingActionStore(state, { kindTtlMs: { mail_write: 15 * 60_000 } });
    pending.set('mail_write', 'self-chat', 'owner', { operation: 'send' }, 1_000);
    assert.equal(pending.get('mail_write', 'other-chat', 'owner', 2_000), null);
    assert.equal(pending.get('mail_write', 'self-chat', 'other', 2_000), null);
    assert.equal(pending.get('mail_write', 'self-chat', 'owner', 901_001), null);
  });
});

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

for (const [question, event, accepted] of [
  ['Is a valid DingTalk group @ event accepted?', {
    type: 'user_im_message_receive_at', message_id: 'm1', conversation_id: 'c1',
    sender_open_dingtalk_id: 'u1', content: '@James 你好',
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
  withState('james-acceptance-inbox-', state => {
    const now = '2026-08-02T00:00:00.000Z';
    assert.equal(state.enqueueInbound('m1', 'websocket', { value: 1 }, now), true);
    assert.equal(state.enqueueInbound('m1', 'polling', { value: 2 }, now), false);
    assert.equal(state.claimInbound('m1', now), true);
    assert.equal(state.claimInbound('m1', now), false);
  });
});

contract('durable-inbox', 'Does a failed message wait until its retry time?', () => {
  withState('james-acceptance-retry-', state => {
    const now = '2026-08-02T00:00:00.000Z';
    state.enqueueInbound('m1', 'event', { ok: true }, now);
    state.claimInbound('m1', now);
    state.failInbound('m1', 'temporary', '2026-08-02T00:00:05.000Z', now);
    assert.equal(state.claimInbound('m1', '2026-08-02T00:00:04.999Z'), false);
    assert.equal(state.claimInbound('m1', '2026-08-02T00:00:05.000Z'), true);
  });
});

contract('durable-inbox', 'Can a completed message be claimed again?', () => {
  withState('james-acceptance-complete-', state => {
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
  withState('james-acceptance-echo-', state => {
    const now = '2026-08-02T00:00:00.000Z';
    state.recordOutboundEcho('self', '回复', { now, ttlMs: 60_000 });
    assert.equal(state.consumeOutboundEcho('self', '回复', { now }), true);
    assert.equal(state.consumeOutboundEcho('self', '回复', { now }), false);
  });
});

contract('stable-response', 'Does an admitted DingTalk group @ create a response obligation?', () => {
  assert.equal(assessResponseObligation({
    message: { chat_type: 'group', mentions: [{ id: 'dingtalk-current-user' }] },
    metadata: { channel: 'dingtalk', eventType: 'user_im_message_receive_at' },
    text: '@James 看一下',
    aliases: ['James', '詹老师'],
  }).responseRequired, true);
});

contract('stable-response', 'Does a repeated explicit mention stop before AI but stay visible?', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'james-acceptance-stable-response-'));
  const state = new AgentState(join(dir, 'state.sqlite'));
  try {
    const sent = [];
    const base = {
      state,
      config: {
        responseMentionAliases: ['James'],
        semanticRepeatGuardEnabled: true,
        semanticRepeatWindowMs: 60_000,
        semanticRepeatMaxReplies: 2,
      },
      channel: 'dingtalk',
      senderId: 'dingtalk:peer',
      message: {
        message_id: 'stable-1', chat_id: 'dingtalk:group:stable',
        chat_type: 'group', message_type: 'text', mentions: [{ id: 'current' }],
      },
      metadata: { channel: 'dingtalk', eventType: 'user_im_message_receive_at' },
      text: '这个需要本人确认 @James',
      sendClose: async text => sent.push(text),
    };
    await evaluateStableResponseInbound({ ...base, nowMs: 1_000 });
    await evaluateStableResponseInbound({
      ...base, message: { ...base.message, message_id: 'stable-2' }, nowMs: 2_000,
    });
    const third = await evaluateStableResponseInbound({
      ...base, message: { ...base.message, message_id: 'stable-3' }, nowMs: 3_000,
    });
    let aiCalls = 0;
    if (!third.handled) {
      await generateStableResponse({
        responseRequired: third.responseRequired,
        generate: async () => { aiCalls += 1; return '不应执行'; },
      });
    }
    assert.equal(third.repeat.action, 'acknowledge_required');
    assert.equal(aiCalls, 0);
    assert.equal(sent.length, 2);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

contract('stable-response', 'Does required generation failure return a visible fallback?', async () => {
  const result = await generateStableResponse({
    responseRequired: true,
    generate: async () => { throw new Error('AI unavailable'); },
  });
  assert.equal(result.text, REQUIRED_RESPONSE_FALLBACK_REPLY);
  assert.equal(result.fallback, true);
});

contract('stable-response', 'Does a repeated required outbound answer acknowledge instead of silence?', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'james-acceptance-outbound-response-'));
  const state = new AgentState(join(dir, 'state.sqlite'));
  try {
    const sent = [];
    const base = {
      state,
      message: { message_id: 'out-1', chat_id: 'group', chat_type: 'group' },
      senderId: 'requester',
      text: '这是相同的最终结论',
      responseRequired: true,
      nowMs: 1_000,
      windowMs: 60_000,
      send: async text => { sent.push(text); return { ok: true }; },
    };
    await sendStableGeneratedReply(base);
    const repeat = await sendStableGeneratedReply({
      ...base,
      message: { ...base.message, message_id: 'out-2' },
      text: '这是相同的最终结论！',
      nowMs: 2_000,
    });
    assert.equal(repeat.acknowledged, true);
    assert.equal(sent.length, 2);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

contract('stable-response', 'Do direct messages bypass the inbound semantic repeat gate?', () => {
  assert.equal(semanticRepeatEligibility({
    enabled: true,
    channel: 'dingtalk',
    chatType: 'p2p',
    messageType: 'text',
    text: '同样内容',
  }).reason, 'direct_message_bypass');
});

contract('loop-prevention', 'Does the circuit breaker isolate different self chats?', () => {
  withState('james-acceptance-circuit-', state => {
    const options = { windowMs: 60_000, limit: 2, cooldownMs: 120_000 };
    assert.equal(state.claimSelfChatOutbound('a', 1_000, options).allowed, true);
    assert.equal(state.claimSelfChatOutbound('a', 2_000, options).allowed, true);
    assert.equal(state.claimSelfChatOutbound('a', 3_000, options).allowed, false);
    assert.equal(state.claimSelfChatOutbound('b', 3_000, options).allowed, true);
  });
});

contract('loop-prevention', 'Does an explicit digital human receive one stop notice before durable silence?', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'james-acceptance-automation-peer-'));
  const state = new AgentState(join(dir, 'state.sqlite'));
  try {
    const guard = new AutomationPeerGuard({ state });
    const sent = [];
    const events = [];
    const input = {
      guard,
      chatId: 'dingtalk:user:automation-peer',
      senderId: 'dingtalk:automation-peer',
      chatType: 'p2p',
      sendTermination: async text => sent.push(text),
      onHandled: event => events.push(event),
    };
    const first = await handleAutomationPeerInbound({
      ...input, text: '你好，我是凤小楼，凤楼的AI助理。', messageId: 'peer-1',
    });
    const second = await handleAutomationPeerInbound({
      ...input, text: '我还可以继续处理。', messageId: 'peer-2',
    });
    assert.equal(first.notified, true);
    assert.equal(second.notified, false);
    assert.deepEqual(sent, ['既然是数字人，我就不跟你玩了，浪费token。']);
    assert.deepEqual(events.map(event => event.name), [
      'automation_peer_detected',
      'automation_peer_suppressed',
    ]);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

contract('loop-prevention', 'Does the tenth rapid machine-like round stop without another outbound?', () => {
  withState('james-acceptance-rapid-peer-', state => {
    let nowMs = 1_000_000;
    const guard = new AutomationPeerGuard({ state, now: () => nowMs });
    let decision;
    for (let round = 1; round <= 10; round += 1) {
      guard.recordOutbound({ chatId: 'dingtalk:user:rapid' });
      nowMs += 1_000;
      decision = guard.evaluateInbound({
        chatId: 'dingtalk:user:rapid',
        senderId: 'dingtalk:rapid',
        chatType: 'p2p',
        text: `普通回复 ${round}`,
      });
      nowMs += 1_000;
    }
    assert.equal(decision.action, 'suppress');
    assert.equal(decision.reason, 'rapid_round_limit');
    assert.equal(decision.rapidRounds, 10);
  });
});

contract('pending-confirmation', 'Can one user confirm another user\'s pending action?', () => {
  withState('james-acceptance-pending-user-', state => {
    const pending = new PendingActionStore(state, { ttlMs: 10_000 });
    pending.set('multica_feedback', 'chat', 'user-a', { sourceMessageId: 'm1' }, 1_000);
    assert.equal(pending.get('multica_feedback', 'chat', 'user-b', 2_000), null);
    assert.deepEqual(pending.get('multica_feedback', 'chat', 'user-a', 2_000), {
      sourceMessageId: 'm1',
    });
  });
});

contract('pending-confirmation', 'Can confirmation leak across conversations?', () => {
  withState('james-acceptance-pending-chat-', state => {
    const pending = new PendingActionStore(state, { ttlMs: 10_000 });
    pending.set('multica_feedback', 'chat-a', 'user', { sourceMessageId: 'm1' }, 1_000);
    assert.equal(pending.get('multica_feedback', 'chat-b', 'user', 2_000), null);
  });
});

contract('pending-confirmation', 'Does an expired pending action remain executable?', () => {
  withState('james-acceptance-pending-ttl-', state => {
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
  ['wecom:user:u1', '生成 Word 报告'],
]) {
  contract('agent-routing', `${chatId}: ${request}`, () => {
    const plan = buildDeliveryPlan({ chatId, request });
    assert.equal(plan.kind, 'message');
    assert.equal(plan.reason, 'agent_runtime');
    assert.equal(typeof plan.provider, 'string');
  });
}

for (const [request, expectedLevel, expectedAction] of [
  ['你好', 'L0', 'execute'],
  ['把桌面客户名单原文发给别人', 'L3', 'refuse'],
  ['替詹老师决定是否同意这个方案', 'L3', 'refuse'],
  ['创建一个 WebAgent 需求', 'L0', 'execute'],
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

contract('live-reply-context', 'Does a natural reply read live history exactly once before AI generation?', async () => {
  let historyReads = 0;
  let aiRuns = 0;
  const contextService = new ReplyContextService({
    contextClient: {
      async fetch() {
        historyReads += 1;
        return {
          messages: [{
            messageId: 'm1', senderId: 'other', senderName: '同事甲', direction: 'counterparty',
            content: '这个同学是6吗', createdAt: '2026-08-03 15:00:00', createdAtMs: 1,
          }],
          currentMessage: {
            messageId: 'm1', senderId: 'other', senderName: '同事甲', direction: 'counterparty',
            content: '这个同学是6吗', createdAt: '2026-08-03 15:00:00', createdAtMs: 1,
          },
          latestCounterpartyMessage: {
            messageId: 'm1', senderId: 'other', senderName: '同事甲', direction: 'counterparty',
            content: '这个同学是6吗', createdAt: '2026-08-03 15:00:00', createdAtMs: 1,
          },
          styleSamples: [],
        };
      },
    },
  });
  const answer = await executeGroundedReply({
    contextService,
    task: '这个同学是6吗',
    historyRequest: { kind: 'direct', targetId: 'other' },
    generate: async ({ replyContextInstruction }) => {
      aiRuns += 1;
      assert.match(replyContextInstruction, /当前回应目标/);
      assert.match(replyContextInstruction, /P6/);
      return '按 P6 理解。';
    },
  });
  assert.equal(answer, '按 P6 理解。');
  assert.equal(historyReads, 1);
  assert.equal(aiRuns, 1);
});

contract('live-reply-context', 'Can AI generation run when live history fails?', async () => {
  let aiRuns = 0;
  const contextService = new ReplyContextService({
    contextClient: { async fetch() { throw new Error('history unavailable'); } },
  });
  await assert.rejects(
    executeGroundedReply({
      contextService,
      task: '你好',
      historyRequest: {},
      generate: async () => { aiRuns += 1; return '不该生成'; },
    }),
    /history unavailable/,
  );
  assert.equal(aiRuns, 0);
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
