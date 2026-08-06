function normalizedChannel(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedSender(value) {
  return String(value || '').trim();
}

export function calendarAccessPolicy({ channel, senderId, identities = {} } = {}) {
  const provider = normalizedChannel(channel);
  const sender = normalizedSender(senderId);
  const owner = provider === 'feishu'
    ? normalizedSender(identities.ownerOpenId)
    : provider === 'dingtalk'
      ? `dingtalk:${normalizedSender(identities.dingtalkOwnerOpenId)}`
      : '';
  const isOwner = Boolean(sender && owner && sender === owner);
  return {
    isOwner,
    canViewDetails: isOwner,
    canReceiveFiles: isOwner,
    canRequestMeeting: ['feishu', 'dingtalk'].includes(provider),
  };
}

export function assertOwnerFileRecipient({ channel, senderId, chatType, identities = {} } = {}) {
  const privateConversation = String(chatType || '').trim().toLowerCase() === 'p2p';
  if (privateConversation
    && calendarAccessPolicy({ channel, senderId, identities }).canReceiveFiles) return true;
  const error = new Error('Only the verified owner identity may receive files');
  error.code = 'OWNER_FILE_RECIPIENT_REQUIRED';
  throw error;
}

export function looksLikeAvailabilityQuery(value) {
  const text = String(value || '').trim();
  if (!/(?:今天|明天|后天|上午|下午|晚上)/.test(text)) return false;
  return /(?:日历|日程|安排|有空|空闲|忙不忙|忙吗|忙闲)/.test(text);
}

export function looksLikeMeetingBookingRequest(value) {
  const text = String(value || '').trim();
  return /(?:预约.{0,12}(?:詹老师|James|见面|沟通|开会|会议)|约.{0,6}(?:詹老师|James|见面|沟通|开会|会议))/i.test(text);
}

export function hasCalendarConflict(events, candidate = {}) {
  const candidateStart = new Date(candidate.start).getTime();
  const candidateEnd = new Date(candidate.end).getTime();
  if (!Number.isFinite(candidateStart) || !Number.isFinite(candidateEnd)
    || candidateEnd <= candidateStart) return true;
  return (Array.isArray(events) ? events : []).some(event => {
    const eventStart = new Date(event?.start).getTime();
    const eventEnd = new Date(event?.end).getTime();
    return Number.isFinite(eventStart) && Number.isFinite(eventEnd)
      && candidateStart < eventEnd && candidateEnd > eventStart;
  });
}

function eventTime(value) {
  const direct = String(value || '').trim();
  if (direct) return direct;
  return '';
}

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '--:--';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatCalendarAnswer({ label, events = [], canViewDetails = false } = {}) {
  const period = String(label || '该时段').trim();
  const available = Array.isArray(events) ? events : [];
  if (!available.length) {
    return canViewDetails
      ? `${period}日历里没有安排哦。`
      : `${period}目前空闲，可以发起预约。`;
  }
  const lines = available.map(event => {
    const range = `${formatTime(event.start)}–${formatTime(event.end)}`;
    return canViewDetails ? `${range} ${event.summary || '未命名日程'}` : `${range} 忙碌`;
  });
  return canViewDetails
    ? `${period}有这些安排：\n${lines.join('\n')}`
    : `${period}的忙闲情况：\n${lines.join('\n')}\n其他时间可以发起预约。`;
}

export function buildDingTalkCalendarListArgs({ profile = '', start, end } = {}) {
  const startTime = String(start || '').trim();
  const endTime = String(end || '').trim();
  if (!startTime || !endTime) throw new Error('DingTalk calendar query requires start and end');
  return [
    ...(profile ? ['--profile', String(profile)] : []),
    'calendar', 'event', 'list',
    '--start', startTime,
    '--end', endTime,
    '--limit', '100', '--format', 'json',
  ];
}

function calendarCreateFields({ summary, start, end } = {}) {
  const title = String(summary || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  const startTime = String(start || '').trim();
  const endTime = String(end || '').trim();
  if (!title || !startTime || !endTime) {
    throw new Error('Calendar creation requires summary, start and end');
  }
  return { title, startTime, endTime };
}

export function buildFeishuCalendarCreateArgs(input = {}) {
  const { title, startTime, endTime } = calendarCreateFields(input);
  const attendeeId = String(input.attendeeId || '').trim();
  return [
    'calendar', '+create', '--as', 'user',
    '--summary', title,
    '--start', startTime,
    '--end', endTime,
    ...(attendeeId ? ['--attendee-ids', attendeeId] : []),
    '--format', 'json',
  ];
}

export function buildDingTalkCalendarCreateArgs(input = {}) {
  const { title, startTime, endTime } = calendarCreateFields(input);
  const profile = String(input.profile || '').trim();
  const attendeeId = String(input.attendeeId || '').replace(/^dingtalk:/, '').trim();
  return [
    ...(profile ? ['--profile', profile] : []),
    'calendar', 'event', 'create',
    '--title', title,
    '--start', startTime,
    '--end', endTime,
    ...(attendeeId ? ['--open-dingtalk-ids', attendeeId] : []),
    '--free-busy', 'busy', '--yes', '--format', 'json',
  ];
}

export function buildFeishuFreebusyArgs({ ownerOpenId, start, end } = {}) {
  const owner = String(ownerOpenId || '').trim();
  const startTime = String(start || '').trim();
  const endTime = String(end || '').trim();
  if (!owner || !startTime || !endTime) {
    throw new Error('Feishu freebusy query requires owner, start and end');
  }
  return [
    'calendar', '+freebusy', '--as', 'user',
    '--start', startTime,
    '--end', endTime,
    '--user-id', owner,
    '--format', 'json',
  ];
}

export function normalizeFeishuBusyIntervals(payload) {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  return items.flatMap(item => {
    const start = String(item?.start_time || '').trim();
    const end = String(item?.end_time || '').trim();
    return start && end ? [{ summary: '', start, end }] : [];
  });
}

export function normalizeFeishuCalendarEvents(items) {
  return (Array.isArray(items) ? items : []).flatMap(item => {
    if (String(item?.status || '').toLowerCase() === 'cancelled') return [];
    const startSeconds = Number(item?.start_time?.timestamp || 0);
    const endSeconds = Number(item?.end_time?.timestamp || 0);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)
      || startSeconds <= 0 || endSeconds <= 0) return [];
    return [{
      summary: String(item?.summary || '').trim(),
      start: new Date(startSeconds * 1000).toISOString(),
      end: new Date(endSeconds * 1000).toISOString(),
    }];
  });
}

function eventDateTime(value) {
  if (typeof value === 'string') return value;
  return eventTime(value?.dateTime || value?.date_time || value?.startTime || value?.endTime);
}

export function normalizeDingTalkCalendarEvents(payload) {
  const root = payload?.result || payload?.data || payload || {};
  const items = Array.isArray(root) ? root : (root.events || root.items || []);
  return (Array.isArray(items) ? items : []).flatMap(item => {
    const status = String(item?.status || '').toLowerCase();
    if (['cancelled', 'canceled'].includes(status)) return [];
    const start = eventDateTime(item?.start || item?.startTime || item?.start_time);
    const end = eventDateTime(item?.end || item?.endTime || item?.end_time);
    if (!start || !end) return [];
    return [{
      summary: String(item?.title || item?.summary || item?.subject || '').trim(),
      start,
      end,
    }];
  });
}
