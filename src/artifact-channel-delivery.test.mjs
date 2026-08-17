import assert from 'node:assert/strict';
import {
  buildEnterpriseChatArtifactSendArgs,
  buildFeishuArtifactSendArgs,
  artifactFormatForPath,
} from './artifact-channel-delivery.mjs';

assert.equal(artifactFormatForPath('/tmp/report.pdf'), 'pdf');
assert.equal(artifactFormatForPath('/tmp/slides.PPTX'), 'pptx');
assert.equal(artifactFormatForPath('/tmp/preview.html'), 'html');
assert.equal(artifactFormatForPath('/tmp/unsafe.exe'), '');

assert.deepEqual(buildFeishuArtifactSendArgs({
  chatId: 'oc_owner',
  relativePath: 'data/multica-artifacts/report.pdf',
  uuid: 'artifact-1',
}), [
  'im', '+messages-send', '--as', 'user', '--chat-id', 'oc_owner',
  '--file', 'data/multica-artifacts/report.pdf', '--format', 'json',
  '--idempotency-key', 'artifact-1',
]);

assert.deepEqual(buildEnterpriseChatArtifactSendArgs({
  target: { channel: 'enterpriseChat', kind: 'user', id: 'open-owner' },
  path: '/tmp/report.pdf',
  uuid: 'artifact-2',
}), [
  'chat', 'message', 'send', '--user', 'open-owner',
  '--msg-type', 'file', '--file-path', '/tmp/report.pdf',
  '--transport-mode=standard', '--uuid', 'artifact-2', '--yes', '--format', 'json',
]);

assert.deepEqual(buildFeishuArtifactSendArgs({
  chatId: 'oc_group',
  relativePath: 'outputs/chart.png',
  uuid: 'image-1',
}), [
  'im', '+messages-send', '--as', 'user', '--chat-id', 'oc_group',
  '--image', 'outputs/chart.png', '--format', 'json',
  '--idempotency-key', 'image-1',
]);

assert.deepEqual(buildFeishuArtifactSendArgs({
  chatId: 'oc_group',
  relativePath: 'outputs/demo.mp4',
  videoCoverRelativePath: 'outputs/demo-cover.png',
  uuid: 'video-1',
}), [
  'im', '+messages-send', '--as', 'user', '--chat-id', 'oc_group',
  '--video', 'outputs/demo.mp4', '--video-cover', 'outputs/demo-cover.png',
  '--format', 'json', '--idempotency-key', 'video-1',
]);

assert.deepEqual(buildFeishuArtifactSendArgs({
  chatId: 'oc_group', relativePath: 'outputs/voice.opus',
}), [
  'im', '+messages-send', '--as', 'user', '--chat-id', 'oc_group',
  '--audio', 'outputs/voice.opus', '--format', 'json',
]);

assert.throws(() => buildFeishuArtifactSendArgs({
  chatId: 'oc_owner', relativePath: '../secret.pdf',
}), /safe relative path/i);
assert.throws(() => buildEnterpriseChatArtifactSendArgs({
  target: { channel: 'enterpriseChat', kind: 'group', id: '' }, path: '/tmp/report.pdf',
}), /target/i);

console.log('ARTIFACT_CHANNEL_DELIVERY_TEST_OK');
