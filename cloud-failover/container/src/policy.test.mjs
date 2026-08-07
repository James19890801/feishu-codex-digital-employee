import assert from 'node:assert/strict';
import {
  cloudReply, evaluateCloudMessage, messageDigest, normalizeDwsMessage,
  ownerHandoffReply, stableMessageUuid, validateContainerEnvironment,
} from './policy.mjs';

const env = {
  DINGTALK_CLIENT_ID: 'cloud-app', DINGTALK_CLIENT_SECRET: 'secret',
  DINGTALK_DWS_AUTH_BUNDLE_B64: 'bundle', AIPROS_COORDINATOR_URL: 'https://internal.test',
  AIPROS_CONTAINER_TOKEN: 'token', AIPROS_ALLOWED_CHAT_IDS: 'chat-1,chat-2',
  AIPROS_ALLOWED_SENDER_IDS: 'user-1',
};
const policy = validateContainerEnvironment(env);
assert.throws(() => validateContainerEnvironment({ ...env, DWS_PROFILE: 'local:user' }), /prohibited/);
assert.throws(() => validateContainerEnvironment({ ...env, DWS_CHANNEL: 'local-channel' }), /prohibited/);
const now = 1_786_060_800_000;
const message = normalizeDwsMessage({ messageId: 'm1', chatId: 'chat-1', senderId: 'user-1', text: '你好', createdAt: now });
assert.deepEqual(evaluateCloudMessage(message, { ...policy, generation: 2, expectedGeneration: 2, now }),
  { allowed: true, level: 'L0', handoff: false });
assert.equal(evaluateCloudMessage({ ...message, chatId: 'other' }, { ...policy, generation: 2, expectedGeneration: 2, now }).reason,
  'unauthorized_chat');
assert.equal(evaluateCloudMessage({ ...message, createdAt: now - 180_001 }, { ...policy, generation: 2, expectedGeneration: 2, now }).reason,
  'outside_backfill_window');
assert.equal(evaluateCloudMessage({ ...message, text: '帮我转账100元' }, { ...policy, generation: 2, expectedGeneration: 2, now }).handoff,
  true);
assert.match(stableMessageUuid('dingtalk', 'm1'), /^[a-f0-9-]{36}$/);
assert.equal(stableMessageUuid('dingtalk', 'm1'), stableMessageUuid('dingtalk', 'm1'));
assert.match(messageDigest('m1'), /^[a-f0-9]{64}$/);
assert.equal(cloudReply('好'), '【云端兜底】好');
assert.match(ownerHandoffReply(), /本人确认/);
console.log('FAILOVER_CONTAINER_POLICY_TEST_OK');
