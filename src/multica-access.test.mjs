import assert from 'node:assert/strict';
import {
  isAuthorizedMulticaOwner,
  requireAuthorizedMulticaOwner,
} from './multica-access.mjs';

const identities = {
  ownerOpenId: 'ou_owner',
  dingtalkOwnerOpenId: 'dt_owner',
};

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'ou_owner',
  metadata: {},
}, identities), true);

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'dingtalk:dt_owner',
  metadata: { channel: 'dingtalk', selfChat: true },
}, identities), true);

for (const context of [
  { senderId: 'ou_other', metadata: {} },
  { senderId: 'dingtalk:dt_owner', metadata: { channel: 'dingtalk' } },
  { senderId: 'dingtalk:dt_other', metadata: { channel: 'dingtalk', selfChat: true } },
  { senderId: 'dingtalk:dt_owner', metadata: { channel: 'feishu', selfChat: true } },
  { senderId: '', metadata: { channel: 'dingtalk', selfChat: true } },
]) {
  assert.equal(isAuthorizedMulticaOwner(context, identities), false);
}

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'dingtalk:dt_owner',
  metadata: { channel: 'dingtalk', selfChat: true },
}, { ownerOpenId: 'ou_owner', dingtalkOwnerOpenId: '' }), false);

assert.doesNotThrow(() => requireAuthorizedMulticaOwner({
  senderId: 'ou_owner',
}, identities));
assert.throws(
  () => requireAuthorizedMulticaOwner({ senderId: 'ou_other' }, identities),
  error => error?.code === 'MULTICA_OWNER_REQUIRED' && /Owner/i.test(error.message),
);

console.log('MULTICA_ACCESS_TEST_OK');
