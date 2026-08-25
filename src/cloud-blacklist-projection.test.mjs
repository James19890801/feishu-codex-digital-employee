import assert from 'node:assert/strict';
import { projectDingTalkCloudBlacklist } from './cloud-blacklist-projection.mjs';

const result = projectDingTalkCloudBlacklist([
  { channel: 'dingtalk', displayName: 'A', ids: ['open-a', 'staff-a'] },
  { channel: 'feishu', displayName: 'B', ids: ['ignored'] },
  { channel: 'dingtalk', displayName: 'C', ids: ['staff-a', 'open-c'] },
]);
assert.deepEqual(result.senderIds, ['open-a', 'open-c', 'staff-a']);
assert.deepEqual(result.chatIds, []);
assert.equal(result.sourceEntryCount, 2);
assert.equal(result.senderCount, 3);
assert.match(result.digest, /^[a-f0-9]{64}$/);

const reordered = projectDingTalkCloudBlacklist([
  { channel: 'dingtalk', ids: ['open-c', 'staff-a'] },
  { channel: 'dingtalk', ids: ['open-a'] },
]);
assert.equal(reordered.digest, result.digest, 'digest must be stable across entry ordering and duplicates');

assert.throws(
  () => projectDingTalkCloudBlacklist([{ channel: 'dingtalk', ids: ['value,with-comma'] }]),
  /comma/i,
);

console.log('CLOUD_BLACKLIST_PROJECTION_TEST_OK');
