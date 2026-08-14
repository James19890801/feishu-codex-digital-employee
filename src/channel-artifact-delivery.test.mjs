import assert from 'node:assert/strict';
import { buildChannelArtifactDeliveryPlan } from './channel-artifact-delivery.mjs';

const feishu = buildChannelArtifactDeliveryPlan({
  channel: 'feishu',
  chatId: 'oc_group',
  path: '/workspace/outputs/report.pdf',
  relativePath: 'outputs/report.pdf',
  caption: '报告已生成',
  idempotencyKey: 'artifact-1',
});
assert.equal(feishu.channel, 'feishu');
assert.ok(feishu.attachmentArgs.includes('--file'));
assert.equal(feishu.caption, '报告已生成');
assert.equal(feishu.captionIdempotencyKey, 'artifact-1-caption');

const dingtalk = buildChannelArtifactDeliveryPlan({
  channel: 'dingtalk',
  chatId: 'dingtalk:group:cid-1',
  target: { channel: 'dingtalk', kind: 'group', id: 'cid-1' },
  path: '/workspace/outputs/demo.mp4',
  relativePath: 'outputs/demo.mp4',
  caption: '视频已生成',
  idempotencyKey: 'artifact-2',
});
assert.equal(dingtalk.channel, 'dingtalk');
assert.deepEqual(dingtalk.attachmentArgs.slice(0, 7), [
  'chat', 'message', 'send', '--group', 'cid-1', '--msg-type', 'file',
]);
assert.equal(dingtalk.caption, '视频已生成');

const wechat = buildChannelArtifactDeliveryPlan({
  channel: 'wechat',
  chatId: 'wechat:group:room@chatroom',
  target: { channel: 'wechat', kind: 'group', id: 'room@chatroom' },
  path: '/workspace/outputs/report.pdf',
  fileUrl: 'https://callback.example.com/webhooks/gewe/secret/artifacts/token/report.pdf',
  fileName: 'report.pdf',
  caption: '报告已生成',
  idempotencyKey: 'artifact-3',
});
assert.equal(wechat.channel, 'wechat');
assert.deepEqual(wechat.file, {
  fileUrl: 'https://callback.example.com/webhooks/gewe/secret/artifacts/token/report.pdf',
  fileName: 'report.pdf',
});
assert.equal(wechat.caption, '报告已生成');
assert.equal(wechat.captionIdempotencyKey, 'artifact-3-caption');

const wechatImage = buildChannelArtifactDeliveryPlan({
  channel: 'wechat',
  chatId: 'wechat:group:room@chatroom',
  target: { channel: 'wechat', kind: 'group', id: 'room@chatroom' },
  path: '/workspace/outputs/process.png',
  fileUrl: 'https://callback.example.com/webhooks/gewe/secret/artifacts/token/process.png',
  fileName: 'process.png',
  caption: '流程图已生成',
  idempotencyKey: 'artifact-image-1',
});
assert.equal(wechatImage.channel, 'wechat');
assert.deepEqual(wechatImage.image, {
  imageUrl: 'https://callback.example.com/webhooks/gewe/secret/artifacts/token/process.png',
});
assert.equal(wechatImage.file, undefined);

console.log('CHANNEL_ARTIFACT_DELIVERY_TEST_OK');
