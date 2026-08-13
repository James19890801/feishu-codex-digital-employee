import assert from 'node:assert/strict';
import {
  cloudReply, evaluateCloudMessage, messageDigest, normalizeDwsMessage,
  ownerHandoffReply, stableMessageUuid, validateContainerEnvironment,
} from './policy.mjs';

const env = {
  DINGTALK_DWS_AUTH_BUNDLE_B64: 'bundle', AIPROS_COORDINATOR_URL: 'https://internal.test',
  AIPROS_CLOUD_DWS_CHANNEL: 'cloud-channel',
  AIPROS_CONTAINER_TOKEN: 'token', AIPROS_ACCESS_MODE: 'blacklist',
  AIPROS_BLOCKED_CHAT_IDS: 'blocked-chat', AIPROS_BLOCKED_SENDER_IDS: 'blocked-user',
};
const policy = validateContainerEnvironment(env);
assert.throws(() => validateContainerEnvironment({ ...env, DINGTALK_CLIENT_ID: 'cloud-app' }),
  /DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET must be provided together/);
assert.doesNotThrow(() => validateContainerEnvironment({
  ...env, DINGTALK_CLIENT_ID: 'cloud-app', DINGTALK_CLIENT_SECRET: 'secret',
}));
assert.throws(() => validateContainerEnvironment({ ...env, DWS_PROFILE: 'local:user' }), /prohibited/);
assert.throws(() => validateContainerEnvironment({ ...env, DWS_CHANNEL: 'local-channel' }), /prohibited/);
assert.throws(() => validateContainerEnvironment({ ...env, AIPROS_CLOUD_DWS_CHANNEL: '' }),
  /AIPROS_CLOUD_DWS_CHANNEL is required/);
assert.throws(() => validateContainerEnvironment({ ...env, AIPROS_ACCESS_MODE: 'allowlist' }),
  /AIPROS_ACCESS_MODE must be blacklist/);
const now = 1_786_060_800_000;
const message = normalizeDwsMessage({ messageId: 'm1', chatId: 'chat-1', senderId: 'user-1', text: '你好', createdAt: now });
assert.deepEqual(normalizeDwsMessage({
  openMessageId: 'm-mention', openConversationId: 'chat-1',
  senderOpenDingTalkId: 'user-1', content: '@我 你好', createTime: now,
}), {
  messageId: 'm-mention', chatId: 'chat-1', senderId: 'user-1', text: '@我 你好',
  createdAt: now, messageType: 'text', chatType: 'p2p', raw: undefined,
});
assert.deepEqual(normalizeDwsMessage({
  type: 'user_im_message_receive_at', message_id: 'm-event', conversation_id: 'chat-1',
  sender_open_dingtalk_id: 'user-1', content: '云端测试', create_time: '2026-08-12 15:39:33',
}), {
  messageId: 'm-event', chatId: 'chat-1', senderId: 'user-1', text: '云端测试',
  createdAt: new Date('2026-08-12 15:39:33').getTime(), messageType: 'text', chatType: 'group', raw: undefined,
});
const imageMessage = normalizeDwsMessage({
  type: 'user_im_message_receive_o2o_all', message_id: 'm-image', conversation_id: 'chat-1',
  sender_open_dingtalk_id: 'user-1', content: '@数字人 [图片消息](mediaId=image-resource-1) 这是哪里？',
  create_time: now,
});
assert.deepEqual(imageMessage.media, {
  kind: 'image', resourceId: 'image-resource-1', messageId: 'm-image', conversationId: 'chat-1',
});
assert.equal(imageMessage.messageType, 'image');
assert.equal(imageMessage.text, '@数字人 这是哪里？');
assert.deepEqual(evaluateCloudMessage(imageMessage, {
  ...policy, generation: 2, expectedGeneration: 2, now,
}), { allowed: true, level: 'L0', handoff: false });
assert.deepEqual(evaluateCloudMessage(message, { ...policy, generation: 2, expectedGeneration: 2, now }),
  { allowed: true, level: 'L0', handoff: false });
for (const text of [
  '好的，有需要随时说。', '好的，回头联系。', '谢谢，先这样。', '我整理好稍后发你。',
  '哈哈没事没事，你也去忙吧，咱别循环了～', '👌',
]) {
  assert.deepEqual(evaluateCloudMessage({ ...message, text }, {
    ...policy, generation: 2, expectedGeneration: 2, now,
  }), { allowed: false, reason: 'conversation_closed' });
}
assert.deepEqual(evaluateCloudMessage({ ...message, text: '好的，那请帮我创建明天九点的日程' }, {
  ...policy, generation: 2, expectedGeneration: 2, now,
}), { allowed: true, level: 'L2', handoff: true });
assert.equal(evaluateCloudMessage({ ...message, chatId: 'blocked-chat' }, { ...policy, generation: 2, expectedGeneration: 2, now }).reason,
  'blocked_chat');
assert.equal(evaluateCloudMessage({ ...message, senderId: 'blocked-user' }, { ...policy, generation: 2, expectedGeneration: 2, now }).reason,
  'blocked_sender');
assert.equal(evaluateCloudMessage({ ...message, createdAt: now - 180_001 }, { ...policy, generation: 2, expectedGeneration: 2, now }).reason,
  'outside_backfill_window');
assert.equal(evaluateCloudMessage({ ...message, text: '帮我转账100元' }, { ...policy, generation: 2, expectedGeneration: 2, now }).handoff,
  true);
assert.match(stableMessageUuid('dingtalk', 'm1'), /^[a-f0-9-]{36}$/);
assert.equal(stableMessageUuid('dingtalk', 'm1'), stableMessageUuid('dingtalk', 'm1'));
assert.match(messageDigest('m1'), /^[a-f0-9]{64}$/);
assert.equal(cloudReply('好'), '', 'a one-word acknowledgement is not a useful cloud answer');
assert.equal(cloudReply('好，有需要随时说。', {
  requestText: '好的，回头联系。',
}), '', 'generic closing replies must fail the outbound quality gate');
assert.equal(cloudReply('好的，随时找我。', {
  requestText: '帮我分析一下这个问题',
}), '', 'a generated non-answer must not become outbound merely because the request was actionable');
assert.equal(cloudReply('哈哈好，收住，不循环了～'), '');
assert.equal(cloudReply('👌'), '');
assert.match(ownerHandoffReply(), /本人确认/);
assert.doesNotMatch(ownerHandoffReply(), /云端兜底/);
console.log('FAILOVER_CONTAINER_POLICY_TEST_OK');
