import assert from 'node:assert/strict';
import * as humanTakeoverModule from './human-takeover.mjs';
import {
  MINIMUM_TAKEOVER_MS,
  activateHumanTakeover,
  applyOwnerActivityHistory,
  applyOwnerControlHistory,
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
assert.equal(
  typeof humanTakeoverModule.takeoverSyncFailureTerminalEvent,
  'function',
  'suppressed takeover sync failures need an explicit terminal audit event',
);
assert.equal(
  humanTakeoverModule.takeoverSyncFailureTerminalEvent('suppress'),
  'message_skipped_takeover_control_unavailable',
);
assert.equal(humanTakeoverModule.takeoverSyncFailureTerminalEvent('retry'), '');
assert.equal(humanTakeoverModule.takeoverSyncFailureTerminalEvent('proceed_degraded'), '');

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

const generatedCalendarCardIgnored = applyOwnerActivityHistory([
  {
    content: [
      '0',
      '和谢冰雪吃饭',
      'Asia/Shanghai',
      'dingtalk://dingtalkclient/action/switchtab?index=1&name=ding&type=calendar&targetDateTime=1786075200000',
      '21001',
      '周五中午和谢冰雪吃饭',
      'dingtalk://dingtalkclient/page/calendar_detail?uniqueId=eDFtQ04xWU5xTUlmVkZPQ0ZXNnZCQT09&corpId=dingd8e1123006514592&from=im_card',
      'eDFtQ04xWU5xTUlmVkZPQ0ZXNnZCQT09',
    ].join('\n'),
    createTime: '2026-08-03 16:35:13',
    openMessageId: 'calendar-card-1',
    senderOpenDingTalkId: 'owner-id',
  },
], {
  ownerId: 'owner-id',
  current: null,
  nowMs: Date.parse('2026-08-03T16:36:00+08:00'),
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
});
assert.equal(
  generatedCalendarCardIgnored.changed,
  false,
  'a DingTalk-generated calendar card must not look like owner manual activity',
);
assert.deepEqual(generatedCalendarCardIgnored.activities, []);
assert.equal(generatedCalendarCardIgnored.active, false);

const manuallySharedCalendarLinkStillPauses = applyOwnerActivityHistory([
  {
    content: '这个日程你看下：dingtalk://dingtalkclient/page/calendar_detail?uniqueId=manual-share',
    createTime: '2026-08-03 16:37:00',
    openMessageId: 'manual-calendar-link-1',
    senderOpenDingTalkId: 'owner-id',
  },
], {
  ownerId: 'owner-id',
  current: null,
  nowMs: Date.parse('2026-08-03T16:38:00+08:00'),
  parseTime: value => Date.parse(String(value).replace(' ', 'T') + '+08:00'),
});
assert.equal(manuallySharedCalendarLinkStillPauses.changed, true);
assert.equal(manuallySharedCalendarLinkStillPauses.activities.length, 1);
assert.equal(manuallySharedCalendarLinkStillPauses.state.reason, 'owner_manual_activity');

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

console.log('HUMAN_TAKEOVER_TEST_OK');
