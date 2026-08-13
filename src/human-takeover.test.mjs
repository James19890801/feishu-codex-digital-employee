import assert from 'node:assert/strict';
import * as humanTakeoverModule from './human-takeover.mjs';
import {
  MINIMUM_TAKEOVER_MS,
  activateHumanTakeover,
  applyOwnerActivityHistory,
  applyOwnerControlHistory,
  applyVerifiedOwnerHistory,
  evaluateHumanTakeover,
  humanTakeoverStatus,
  latestOwnerControl,
  matchHumanTakeoverCommand,
  requestHumanTakeoverResume,
} from './human-takeover.mjs';

assert.equal(MINIMUM_TAKEOVER_MS, 5 * 60_000);

assert.equal(
  typeof humanTakeoverModule.takeoverSyncFailurePolicy,
  'function',
  'DingTalk takeover sync failures must have an explicit durable retry policy',
);
assert.equal(humanTakeoverModule.takeoverSyncFailurePolicy({
  current: null,
  nowMs: 1_000,
  attemptNumber: 1,
  maxAttempts: 3,
}), 'retry');
assert.equal(humanTakeoverModule.takeoverSyncFailurePolicy({
  current: null,
  nowMs: 1_000,
  attemptNumber: 3,
  maxAttempts: 3,
}), 'proceed_degraded');
assert.equal(humanTakeoverModule.takeoverSyncFailurePolicy({
  current: { pausedUntilMs: 10_000 },
  nowMs: 1_000,
  attemptNumber: 3,
  maxAttempts: 3,
}), 'suppress');

for (const phrase of [
  '数字人请退场',
  '数字人请退场。',
  '数字人停止！',
  '数字人先不要你了',
  '暂停接管',
  '暂停回复',
  '我来回复',
]) {
  assert.equal(matchHumanTakeoverCommand(phrase), 'pause', phrase);
}
for (const phrase of ['恢复接管', '恢复回复。', '你来回复']) {
  assert.equal(matchHumanTakeoverCommand(phrase), 'resume', phrase);
}
assert.equal(matchHumanTakeoverCommand('对方说“数字人停止”是什么意思？'), null);
assert.equal(matchHumanTakeoverCommand('数字人停止后会怎么样'), null);
assert.equal(matchHumanTakeoverCommand(''), null);

const unauthenticated = evaluateHumanTakeover({
  current: null,
  text: '数字人停止',
  authenticatedOwner: false,
  nowMs: 1_000,
  sourceMessageId: 'attacker',
});
assert.deepEqual(unauthenticated, {
  command: null, handled: false, suppressed: false, state: null, resumed: false,
});

const evaluatedPause = evaluateHumanTakeover({
  current: null,
  text: '数字人请退场',
  authenticatedOwner: true,
  nowMs: 1_000,
  sourceMessageId: 'owner-pause',
});
assert.equal(evaluatedPause.command, 'pause');
assert.equal(evaluatedPause.handled, true);
assert.equal(evaluatedPause.suppressed, true);
assert.equal(evaluatedPause.state.pausedUntilMs, 1_000 + 5 * 60_000);

const suppressedInbound = evaluateHumanTakeover({
  current: evaluatedPause.state,
  text: '你好',
  authenticatedOwner: false,
  nowMs: 2_000,
});
assert.equal(suppressedInbound.handled, false);
assert.equal(suppressedInbound.suppressed, true);

assert.equal(
  typeof humanTakeoverModule.rememberSuppressedTakeoverContext,
  'function',
  'suppressed replies must still preserve incoming context for the later handoff',
);
const rememberedDuringTakeover = [];
assert.equal(humanTakeoverModule.rememberSuppressedTakeoverContext({
  state: {
    remember: (...args) => rememberedDuringTakeover.push(args),
  },
  chatId: 'dingtalk:group:test',
  senderId: 'dingtalk:other-bot',
  text: 'AI 会把流程管理从事后复盘推到事中干预',
  messageType: 'text',
  messageId: 'paused-context-1',
}), true);
assert.deepEqual(rememberedDuringTakeover, [[
  'dingtalk:group:test',
  'dingtalk:other-bot',
  'user',
  'AI 会把流程管理从事后复盘推到事中干预',
  { sourceMessageId: 'paused-context-1' },
]]);

assert.equal(
  typeof humanTakeoverModule.rememberDingTalkConversationContext,
  'function',
  'DingTalk conversation snapshots must preserve every participant, not only the current sender',
);
const rememberedGroupSnapshot = [];
assert.equal(humanTakeoverModule.rememberDingTalkConversationContext([
  {
    content: 'AI 会把流程管理推向事中干预',
    createTime: '2026-08-08 20:00:00',
    openMessageId: 'group-message-1',
    senderOpenDingTalkId: 'member-a',
  },
  {
    content: '价值重心会从画流程转向解释 AI 判断',
    createTime: '2026-08-08 20:00:01',
    openMessageId: 'group-message-2',
    senderOpenDingTalkId: 'member-b',
  },
], {
  state: { remember: (...args) => { rememberedGroupSnapshot.push(args); return true; } },
  chatId: 'dingtalk:group:test',
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
}), 2);
assert.deepEqual(
  rememberedGroupSnapshot.map(args => [args[1], args[3], args[4].sourceMessageId]),
  [
    ['dingtalk:member-a', 'AI 会把流程管理推向事中干预', 'dingtalk:group-message-1'],
    ['dingtalk:member-b', '价值重心会从画流程转向解释 AI 判断', 'dingtalk:group-message-2'],
  ],
);

const prematureResume = evaluateHumanTakeover({
  current: evaluatedPause.state,
  text: '恢复接管',
  authenticatedOwner: true,
  nowMs: 3_000,
});
assert.equal(prematureResume.handled, true);
assert.equal(prematureResume.resumed, false);
assert.equal(prematureResume.suppressed, true);
assert.equal(prematureResume.state.pausedUntilMs, evaluatedPause.state.pausedUntilMs);

const expiredInbound = evaluateHumanTakeover({
  current: evaluatedPause.state,
  text: '你好',
  authenticatedOwner: false,
  nowMs: evaluatedPause.state.pausedUntilMs,
});
assert.equal(expiredInbound.suppressed, false);

const nowMs = Date.parse('2026-08-01T08:00:00.000Z');
const first = activateHumanTakeover(null, {
  nowMs,
  sourceMessageId: 'pause-1',
});
assert.equal(first.pausedUntilMs, nowMs + MINIMUM_TAKEOVER_MS);
assert.equal(first.sourceMessageId, 'pause-1');
assert.equal(humanTakeoverStatus(first, nowMs + 1).active, true);
assert.equal(humanTakeoverStatus(first, nowMs + MINIMUM_TAKEOVER_MS).active, false);

const extended = activateHumanTakeover(first, {
  nowMs: nowMs + 60_000,
  sourceMessageId: 'pause-2',
});
assert.equal(extended.pausedUntilMs, nowMs + 60_000 + MINIMUM_TAKEOVER_MS);
assert.equal(extended.sourceMessageId, 'pause-2');

const deniedResume = requestHumanTakeoverResume(extended, nowMs + 2 * 60_000);
assert.equal(deniedResume.resumed, false);
assert.equal(deniedResume.state.pausedUntilMs, extended.pausedUntilMs);
const acceptedResume = requestHumanTakeoverResume(extended, extended.pausedUntilMs);
assert.equal(acceptedResume.resumed, true);
assert.equal(acceptedResume.state, null);

const latest = latestOwnerControl([
  {
    content: '数字人请退场', createTime: '2026-08-01 15:59:00',
    openMessageId: 'owner-pause', senderOpenDingTalkId: 'owner-id',
  },
  {
    content: '数字人停止', createTime: '2026-08-01 16:00:00',
    openMessageId: 'attacker-pause', senderOpenDingTalkId: 'other-id',
  },
  {
    content: '数字人停止后会怎么样', createTime: '2026-08-01 16:01:00',
    openMessageId: 'owner-question', senderOpenDingTalkId: 'owner-id',
  },
], {
  ownerId: 'owner-id',
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
});
assert.deepEqual(latest, {
  command: 'pause',
  messageId: 'owner-pause',
  occurredAtMs: Date.parse('2026-08-01T15:59:00+08:00'),
});

const historyApplied = applyOwnerControlHistory([
  {
    content: '数字人请退场', createTime: '2026-08-01 16:00:00',
    openMessageId: 'pause-first', senderOpenDingTalkId: 'owner-id',
  },
  {
    content: '恢复接管', createTime: '2026-08-01 16:01:00',
    openMessageId: 'resume-too-soon', senderOpenDingTalkId: 'owner-id',
  },
], {
  ownerId: 'owner-id',
  current: null,
  nowMs: Date.parse('2026-08-01T16:02:00+08:00'),
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
});
assert.equal(historyApplied.changed, true);
assert.equal(historyApplied.state.pausedUntilMs, Date.parse('2026-08-01T16:05:00+08:00'));
assert.equal(historyApplied.state.lastControlMessageId, 'resume-too-soon');
assert.equal(historyApplied.active, true);

const noReplay = applyOwnerControlHistory([
  {
    content: '数字人请退场', createTime: '2026-08-01 16:00:00',
    openMessageId: 'pause-first', senderOpenDingTalkId: 'owner-id',
  },
  {
    content: '恢复接管', createTime: '2026-08-01 16:01:00',
    openMessageId: 'resume-too-soon', senderOpenDingTalkId: 'owner-id',
  },
], {
  ownerId: 'owner-id',
  current: historyApplied.state,
  nowMs: Date.parse('2026-08-01T16:02:30+08:00'),
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
});
assert.equal(noReplay.changed, false);
assert.equal(noReplay.active, true);

const activityApplied = applyOwnerActivityHistory([
  {
    content: '我先来跟你说', createTime: '2026-08-01 16:10:00',
    openMessageId: 'owner-manual-1', senderOpenDingTalkId: 'owner-id',
  },
  {
    content: '数字人的发送', createTime: '2026-08-01 16:10:30',
    openMessageId: 'assistant-echo-1', senderOpenDingTalkId: 'owner-id',
  },
], {
  ownerId: 'owner-id',
  current: null,
  nowMs: Date.parse('2026-08-01T16:11:00+08:00'),
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
  isAssistantMessage: message => message.openMessageId === 'assistant-echo-1',
});
assert.equal(activityApplied.changed, true);
assert.equal(activityApplied.activities.length, 1);
assert.equal(activityApplied.state.reason, 'owner_manual_activity');
assert.equal(activityApplied.state.pausedUntilMs, Date.parse('2026-08-01T16:15:00+08:00'));

const activityNoReplay = applyOwnerActivityHistory([
  {
    content: '我先来跟你说', createTime: '2026-08-01 16:10:00',
    openMessageId: 'owner-manual-1', senderOpenDingTalkId: 'owner-id',
  },
], {
  ownerId: 'owner-id',
  current: activityApplied.state,
  nowMs: Date.parse('2026-08-01T16:12:00+08:00'),
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
});
assert.equal(activityNoReplay.changed, false);

const rollingActivity = applyOwnerActivityHistory([
  {
    content: '第一句真人消息', createTime: '2026-08-01 16:20:00',
    openMessageId: 'owner-rolling-1', senderOpenDingTalkId: 'owner-id',
  },
  {
    content: '第二句真人消息', createTime: '2026-08-01 16:24:30',
    openMessageId: 'owner-rolling-2', senderOpenDingTalkId: 'owner-id',
  },
], {
  ownerId: 'owner-id',
  current: null,
  nowMs: Date.parse('2026-08-01T16:25:00+08:00'),
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
});
assert.equal(
  rollingActivity.state.pausedUntilMs,
  Date.parse('2026-08-01T16:29:30+08:00'),
  'every verified owner message must roll the direct-chat silence deadline forward',
);
assert.equal(humanTakeoverStatus(
  rollingActivity.state,
  Date.parse('2026-08-01T16:29:29.999+08:00'),
).active, true);
assert.equal(humanTakeoverStatus(
  rollingActivity.state,
  Date.parse('2026-08-01T16:29:30+08:00'),
).active, false, 'the assistant may return only after five full minutes of owner inactivity');

const wechatGroupActivity = applyOwnerActivityHistory([{
  content: '我在微信群里手动回复',
  create_time: '2026-08-01T08:40:00.000Z',
  message_id: 'wechat:app:owner-group-1',
  sender: { id: 'wechat:wxid_owner' },
}], {
  ownerId: 'wechat:wxid_owner',
  current: null,
  nowMs: Date.parse('2026-08-01T08:40:01.000Z'),
});
assert.equal(wechatGroupActivity.changed, true);
assert.equal(wechatGroupActivity.state.reason, 'owner_manual_activity');
assert.equal(
  wechatGroupActivity.state.pausedUntilMs,
  Date.parse('2026-08-01T08:45:00.000Z'),
  'verified GeWe owner activity must use the same five-minute rolling takeover window',
);

const groupOwnerHistory = applyVerifiedOwnerHistory([{
  content: '我在群里正常说话', createTime: '2026-08-01 16:30:00',
  openMessageId: 'owner-group-normal', senderOpenDingTalkId: 'owner-id',
}], {
  chatType: 'group',
  ownerId: 'owner-id',
  current: null,
  nowMs: Date.parse('2026-08-01T16:30:01+08:00'),
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
});
assert.equal(groupOwnerHistory.changed, false, 'group conversations require an explicit stop command');
const directOwnerHistory = applyVerifiedOwnerHistory([{
  content: '我真人来回复', createTime: '2026-08-01 16:30:00',
  openMessageId: 'owner-direct-normal', senderOpenDingTalkId: 'owner-id',
}], {
  chatType: 'p2p',
  ownerId: 'owner-id',
  current: null,
  nowMs: Date.parse('2026-08-01T16:30:01+08:00'),
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
});
assert.equal(directOwnerHistory.changed, true);
assert.equal(directOwnerHistory.active, true);

console.log('HUMAN_TAKEOVER_TEST_OK');
