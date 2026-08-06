import assert from 'node:assert/strict';
import {
  assertOwnerFileRecipient,
  buildDingTalkCalendarCreateArgs,
  buildDingTalkCalendarListArgs,
  buildFeishuCalendarCreateArgs,
  buildFeishuFreebusyArgs,
  calendarAccessPolicy,
  formatCalendarAnswer,
  hasCalendarConflict,
  looksLikeAvailabilityQuery,
  looksLikeMeetingBookingRequest,
  normalizeDingTalkCalendarEvents,
  normalizeFeishuBusyIntervals,
  normalizeFeishuCalendarEvents,
} from './calendar-access.mjs';

const identities = {
  ownerOpenId: 'ou_james',
  dingtalkOwnerOpenId: 'dt_james',
};
const events = [{
  summary: '董事会私密会议',
  start: '2026-08-07T15:00:00+08:00',
  end: '2026-08-07T16:00:00+08:00',
}];

assert.deepEqual(calendarAccessPolicy({
  channel: 'feishu',
  senderId: 'ou_james',
  identities,
}), {
  isOwner: true,
  canViewDetails: true,
  canReceiveFiles: true,
  canRequestMeeting: true,
});

assert.deepEqual(calendarAccessPolicy({
  channel: 'dingtalk',
  senderId: 'dingtalk:dt_guest',
  identities,
}), {
  isOwner: false,
  canViewDetails: false,
  canReceiveFiles: false,
  canRequestMeeting: true,
});

assert.equal(calendarAccessPolicy({
  channel: 'dingtalk',
  senderId: 'dingtalk:dt_james',
  identities,
}).isOwner, true);

assert.doesNotThrow(() => assertOwnerFileRecipient({
  channel: 'feishu', senderId: 'ou_james', chatType: 'p2p', identities,
}));
assert.throws(() => assertOwnerFileRecipient({
  channel: 'feishu', senderId: 'ou_james', chatType: 'group', identities,
}), error => error?.code === 'OWNER_FILE_RECIPIENT_REQUIRED');
assert.throws(() => assertOwnerFileRecipient({
  channel: 'feishu', senderId: 'ou_guest', identities,
}), error => error?.code === 'OWNER_FILE_RECIPIENT_REQUIRED');

assert.equal(looksLikeAvailabilityQuery('詹老师明天下午有空吗'), true);
assert.equal(looksLikeAvailabilityQuery('帮我查一下今天的日历安排'), true);
assert.equal(looksLikeAvailabilityQuery('你今天好吗'), false);
assert.equal(looksLikeMeetingBookingRequest('我想约詹老师明天下午3点见面'), true);
assert.equal(looksLikeMeetingBookingRequest('我们的合同约定明天生效'), false);

assert.equal(hasCalendarConflict(events, {
  start: '2026-08-07T15:30:00+08:00',
  end: '2026-08-07T16:30:00+08:00',
}), true);
assert.equal(hasCalendarConflict(events, {
  start: '2026-08-07T16:00:00+08:00',
  end: '2026-08-07T17:00:00+08:00',
}), false);
assert.throws(() => assertOwnerFileRecipient({
  channel: 'dingtalk', senderId: 'dingtalk:dt_guest', identities,
}), error => error?.code === 'OWNER_FILE_RECIPIENT_REQUIRED');

const externalReply = formatCalendarAnswer({
  label: '今天下午',
  events,
  canViewDetails: false,
});
assert.match(externalReply, /15:00–16:00.*忙碌/);
assert.doesNotMatch(externalReply, /董事会|私密会议/);

const ownerReply = formatCalendarAnswer({
  label: '今天下午',
  events,
  canViewDetails: true,
});
assert.match(ownerReply, /董事会私密会议/);

assert.equal(formatCalendarAnswer({
  label: '明天上午',
  events: [],
  canViewDetails: false,
}), '明天上午目前空闲，可以发起预约。');

assert.deepEqual(buildDingTalkCalendarListArgs({
  profile: 'corp:user',
  start: '2026-08-07T09:00:00+08:00',
  end: '2026-08-07T18:00:00+08:00',
}), [
  '--profile', 'corp:user',
  'calendar', 'event', 'list',
  '--start', '2026-08-07T09:00:00+08:00',
  '--end', '2026-08-07T18:00:00+08:00',
  '--limit', '100', '--format', 'json',
]);

assert.deepEqual(buildFeishuCalendarCreateArgs({
  summary: '与詹老师沟通',
  start: '2026-08-08T09:00:00+08:00',
  end: '2026-08-08T10:00:00+08:00',
  attendeeId: 'ou_guest',
}), [
  'calendar', '+create', '--as', 'user',
  '--summary', '与詹老师沟通',
  '--start', '2026-08-08T09:00:00+08:00',
  '--end', '2026-08-08T10:00:00+08:00',
  '--attendee-ids', 'ou_guest', '--format', 'json',
]);

assert.deepEqual(buildDingTalkCalendarCreateArgs({
  profile: 'corp:user',
  summary: '与詹老师沟通',
  start: '2026-08-08T09:00:00+08:00',
  end: '2026-08-08T10:00:00+08:00',
  attendeeId: 'dingtalk:dt_guest',
}), [
  '--profile', 'corp:user',
  'calendar', 'event', 'create',
  '--title', '与詹老师沟通',
  '--start', '2026-08-08T09:00:00+08:00',
  '--end', '2026-08-08T10:00:00+08:00',
  '--open-dingtalk-ids', 'dt_guest',
  '--free-busy', 'busy', '--yes', '--format', 'json',
]);

assert.deepEqual(buildFeishuFreebusyArgs({
  ownerOpenId: 'ou_james',
  start: '2026-08-07T09:00:00+08:00',
  end: '2026-08-07T18:00:00+08:00',
}), [
  'calendar', '+freebusy', '--as', 'user',
  '--start', '2026-08-07T09:00:00+08:00',
  '--end', '2026-08-07T18:00:00+08:00',
  '--user-id', 'ou_james', '--format', 'json',
]);

assert.deepEqual(normalizeFeishuBusyIntervals({
  ok: true,
  data: [{
    start_time: '2026-08-07T15:00:00+08:00',
    end_time: '2026-08-07T16:00:00+08:00',
  }],
}), [{
  summary: '',
  start: '2026-08-07T15:00:00+08:00',
  end: '2026-08-07T16:00:00+08:00',
}]);

assert.deepEqual(normalizeFeishuCalendarEvents([{
  summary: '内部复盘',
  status: 'confirmed',
  start_time: { timestamp: '1786086000' },
  end_time: { timestamp: '1786089600' },
}, {
  summary: '取消会议',
  status: 'cancelled',
  start_time: { timestamp: '1786086000' },
  end_time: { timestamp: '1786089600' },
}]), [{
  summary: '内部复盘',
  start: '2026-08-07T07:00:00.000Z',
  end: '2026-08-07T08:00:00.000Z',
}]);

assert.deepEqual(normalizeDingTalkCalendarEvents({
  success: true,
  result: {
    events: [{
      title: '客户签约',
      start: { dateTime: '2026-08-07T10:00:00+08:00' },
      end: { dateTime: '2026-08-07T11:00:00+08:00' },
      status: 'confirmed',
    }, {
      title: '已取消',
      start: { dateTime: '2026-08-07T12:00:00+08:00' },
      end: { dateTime: '2026-08-07T13:00:00+08:00' },
      status: 'cancelled',
    }],
  },
}), [{
  summary: '客户签约',
  start: '2026-08-07T10:00:00+08:00',
  end: '2026-08-07T11:00:00+08:00',
}]);

console.log('CALENDAR_ACCESS_TEST_OK');
