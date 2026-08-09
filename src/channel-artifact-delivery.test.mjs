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

console.log('CHANNEL_ARTIFACT_DELIVERY_TEST_OK');
