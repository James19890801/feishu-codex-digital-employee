import assert from 'node:assert/strict';
import {
  cloudReply, evaluateCloudMessage, messageDigest, normalizeConnectorMessage,
  ownerHandoffReply, stableMessageUuid, validateContainerEnvironment,
} from './policy.mjs';

const env = {
  ENTERPRISE_CHAT_CONNECTOR_AUTH_BUNDLE_B64: 'bundle', AIPROS_COORDINATOR_URL: 'https://internal.test',
  AIPROS_CLOUD_CONNECTOR_CHANNEL: 'cloud-channel',
  AIPROS_CONTAINER_TOKEN: 'token', AIPROS_ACCESS_MODE: 'blacklist',
  AIPROS_BLOCKED_CHAT_IDS: 'blocked-chat', AIPROS_BLOCKED_SENDER_IDS: 'blocked-user',
};
const policy = validateContainerEnvironment(env);
assert.throws(() => validateContainerEnvironment({ ...env, ENTERPRISE_CHAT_CLIENT_ID: 'cloud-app' }),
  /ENTERPRISE_CHAT_CLIENT_ID and ENTERPRISE_CHAT_CLIENT_SECRET must be provided together/);
assert.doesNotThrow(() => validateContainerEnvironment({
  ...env, ENTERPRISE_CHAT_CLIENT_ID: 'cloud-app', ENTERPRISE_CHAT_CLIENT_SECRET: 'secret',
}));
assert.throws(() => validateContainerEnvironment({ ...env, CONNECTOR_PROFILE: 'local:user' }), /prohibited/);
assert.throws(() => validateContainerEnvironment({ ...env, CONNECTOR_CHANNEL: 'local-channel' }), /prohibited/);
assert.throws(() => validateContainerEnvironment({ ...env, AIPROS_CLOUD_CONNECTOR_CHANNEL: '' }),
  /AIPROS_CLOUD_CONNECTOR_CHANNEL is required/);
assert.throws(() => validateContainerEnvironment({ ...env, AIPROS_ACCESS_MODE: 'allowlist' }),
  /AIPROS_ACCESS_MODE must be blacklist/);
const now = 1_786_060_800_000;
const message = normalizeConnectorMessage({ messageId: 'm1', chatId: 'chat-1', senderId: 'user-1', text: '你好', createdAt: now });
assert.deepEqual(normalizeConnectorMessage({
  openMessageId: 'm-mention', openConversationId: 'chat-1',
  senderEnterpriseUserId: 'user-1', content: '@我 你好', createTime: now,
}), {
  messageId: 'm-mention', chatId: 'chat-1', senderId: 'user-1', text: '@我 你好',
  createdAt: now, messageType: 'text', raw: undefined,
});
assert.deepEqual(normalizeConnectorMessage({
  type: 'message.mention.received', message_id: 'm-event', conversation_id: 'chat-1',
  sender_enterprise_user_id: 'user-1', content: '云端测试', create_time: '2026-08-12 15:39:33',
}), {
  messageId: 'm-event', chatId: 'chat-1', senderId: 'user-1', text: '云端测试',
  createdAt: new Date('2026-08-12 15:39:33').getTime(), messageType: 'text', raw: undefined,
});
const imageMessage = normalizeConnectorMessage({
  type: 'message.direct.received', message_id: 'm-image', conversation_id: 'chat-1',
  sender_enterprise_user_id: 'user-1', content: '@数字人 [图片消息](mediaId=image-resource-1) 这是哪里？',
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
assert.equal(evaluateCloudMessage({ ...message, chatId: 'blocked-chat' }, { ...policy, generation: 2, expectedGeneration: 2, now }).reason,
  'blocked_chat');
assert.equal(evaluateCloudMessage({ ...message, senderId: 'blocked-user' }, { ...policy, generation: 2, expectedGeneration: 2, now }).reason,
  'blocked_sender');
assert.equal(evaluateCloudMessage({ ...message, createdAt: now - 180_001 }, { ...policy, generation: 2, expectedGeneration: 2, now }).reason,
  'outside_backfill_window');
assert.equal(evaluateCloudMessage({ ...message, text: '帮我转账100元' }, { ...policy, generation: 2, expectedGeneration: 2, now }).handoff,
  true);
assert.match(stableMessageUuid('enterpriseChat', 'm1'), /^[a-f0-9-]{36}$/);
assert.equal(stableMessageUuid('enterpriseChat', 'm1'), stableMessageUuid('enterpriseChat', 'm1'));
assert.match(messageDigest('m1'), /^[a-f0-9]{64}$/);
assert.equal(cloudReply('好'), '好');
assert.match(ownerHandoffReply(), /本人确认/);
assert.doesNotMatch(ownerHandoffReply(), /云端兜底/);
console.log('FAILOVER_CONTAINER_POLICY_TEST_OK');
