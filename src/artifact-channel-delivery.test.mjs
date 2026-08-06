import assert from 'node:assert/strict';
import {
  buildDingTalkArtifactSendArgs,
  buildFeishuArtifactSendArgs,
  artifactFormatForPath,
} from './artifact-channel-delivery.mjs';

assert.equal(artifactFormatForPath('/tmp/report.pdf'), 'pdf');
assert.equal(artifactFormatForPath('/tmp/slides.PPTX'), 'pptx');
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

assert.deepEqual(buildDingTalkArtifactSendArgs({
  target: { channel: 'dingtalk', kind: 'user', id: 'open-owner' },
  path: '/tmp/report.pdf',
  uuid: 'artifact-2',
}), [
  'chat', 'message', 'send', '--open-dingtalk-id', 'open-owner',
  '--msg-type', 'file', '--file-path', '/tmp/report.pdf',
  '--ai-tag=false', '--uuid', 'artifact-2', '--yes', '--format', 'json',
]);

assert.throws(() => buildFeishuArtifactSendArgs({
  chatId: 'oc_owner', relativePath: '../secret.pdf',
}), /safe relative path/i);
assert.throws(() => buildDingTalkArtifactSendArgs({
  target: { channel: 'dingtalk', kind: 'group', id: '' }, path: '/tmp/report.pdf',
}), /target/i);

console.log('ARTIFACT_CHANNEL_DELIVERY_TEST_OK');
