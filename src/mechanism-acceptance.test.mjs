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
import { selectInboundMessages, shouldRetryMessage } from './polling.mjs';
import { validateInboundPayload } from './reliability.mjs';
import {
  hasSelfChatOutboundMarker,
  markSelfChatOutbound,
  stripSelfChatOutboundMarker,
} from './self-chat-guard.mjs';
import { AgentState } from './state.mjs';
import { evaluateLicenseGuard } from './licensing/guard.mjs';
import { semanticRepeatEligibility } from './semantic-repeat-controller.mjs';

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
