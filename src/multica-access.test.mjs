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
  chatType: 'group',
  metadata: { channel: 'feishu', selfChat: true },
}, identities), false, 'an Owner group message must never authorize Multica writes');

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'ou_owner',
  chatType: 'p2p',
  metadata: { channel: 'feishu' },
}, identities), false, 'an ordinary Owner p2p message must never authorize Multica writes');

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'ou_owner',
  chatType: 'p2p',
  metadata: { channel: 'feishu', selfChat: true },
}, identities), true);

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'ou_owner',
  chatType: 'p2p',
  metadata: { selfChat: true },
}, identities), false, 'an unknown channel must fail closed even with self-chat metadata');

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'dingtalk:dt_owner',
  chatType: 'p2p',
  metadata: { channel: 'dingtalk', selfChat: true },
}, identities), true);

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'wechat:wxid_owner',
  chatType: 'p2p',
  metadata: {
    channel: 'wechat',
    selfChat: true,
    ownerControlAuthenticated: true,
  },
}, identities), true);

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'wechat:wxid_guest',
  chatType: 'p2p',
  metadata: { channel: 'wechat', selfChat: false },
}, identities), true, '个人微信单聊中的任何联系人都可以发起 Multica 任务');

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'wechat:wxid_owner',
  chatType: 'group',
  metadata: {
    channel: 'wechat',
    ownerControlAuthenticated: true,
    explicitBotMention: true,
  },
}, identities), true, '本人在微信群明确点名数字人时可以进入 Multica 确认流程');

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'wechat:wxid_owner',
  chatType: 'group',
  metadata: {
    channel: 'wechat',
    ownerControlAuthenticated: true,
    explicitBotMention: false,
  },
}, identities), false, '本人普通群聊不能触发 Multica 写入');

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'wechat:wxid_group_member',
  chatType: 'group',
  metadata: {
    channel: 'wechat',
    explicitBotMention: true,
  },
}, identities), true, '微信群任何成员明确点名数字人后都可以发起 Multica 写入');

assert.equal(isAuthorizedMulticaOwner({
  senderId: 'wechat:wxid_group_member',
  chatType: 'group',
  metadata: {
    channel: 'wechat',
    explicitBotMention: false,
  },
}, identities), false, '没有点名且没有本人待确认操作的普通群聊不能写入 Multica');

for (const context of [
  { senderId: 'ou_other', metadata: {} },
  {
    senderId: 'ou_other',
    chatType: 'p2p',
    metadata: { channel: 'feishu', selfChat: true },
  },
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
  chatType: 'p2p',
  metadata: { channel: 'feishu', selfChat: true },
}, identities));
assert.throws(
  () => requireAuthorizedMulticaOwner({ senderId: 'ou_other' }, identities),
  error => error?.code === 'MULTICA_OWNER_REQUIRED' && /Owner/i.test(error.message),
);

console.log('MULTICA_ACCESS_TEST_OK');
