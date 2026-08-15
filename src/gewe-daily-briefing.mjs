import { createHash } from 'node:crypto';
import { executeMutationOnce } from './mutation-execution.mjs';

function normalizedDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || Number.isNaN(new Date(`${date}T00:00:00+08:00`).getTime())) {
    throw new Error('GeWe daily briefing requires a valid YYYY-MM-DD date');
  }
  return date;
}

function normalizedTarget(groupId, groupName) {
  const id = String(groupId || '').trim();
  const name = String(groupName || '').trim();
  if (!id.endsWith('@chatroom') || id.length > 500) {
    throw new Error('GeWe daily briefing group ID is invalid');
  }
  if (!name || name.length > 200) throw new Error('GeWe daily briefing group name is invalid');
  return { id, name };
}

function normalizedContent(value) {
  const content = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (content.length < 20 || content.length > 8_000) {
    throw new Error('GeWe daily briefing content must contain 20 to 8000 characters');
  }
  if (/<@all>|@所有人|@all\b/iu.test(content)) {
    throw new Error('Personal WeChat daily briefing must use ordinary delivery without @所有人');
  }
  return content;
}

function executionKey(date, groupId) {
  const digest = createHash('sha256')
    .update(`${date}\0${groupId}`)
    .digest('hex')
    .slice(0, 24);
  return `automation:ai-daily-briefing:wechat:${date}:${digest}`;
}

export async function deliverGeWeDailyBriefing({
  state,
  channel,
  briefingDate,
  groupId,
  groupName,
  content,
} = {}) {
  if (!state || !channel) throw new Error('GeWe daily briefing requires state and channel');
  const date = normalizedDate(briefingDate);
  const target = normalizedTarget(groupId, groupName);
  const text = normalizedContent(content);
  return executeMutationOnce({
    state,
    executionKey: executionKey(date, target.id),
    kind: 'gewe_daily_briefing_send',
    operation: async () => {
      try {
        if (typeof channel.checkOnline === 'function' && !await channel.checkOnline()) {
          throw new Error('Personal WeChat account is offline');
        }
        const info = await channel.getChatroomInfo(target.id);
        if (String(info?.nickName || '').trim() !== target.name) {
          throw new Error('Personal WeChat daily briefing group name mismatch');
        }
      } catch (error) {
        error.code = 'GEWE_DAILY_BRIEFING_PRECONDITION';
        throw error;
      }
      return channel.send({
        channel: 'wechat',
        kind: 'group',
        id: target.id,
      }, text);
    },
    definitelyNotApplied: error => error?.code === 'GEWE_DAILY_BRIEFING_PRECONDITION',
  });
}
