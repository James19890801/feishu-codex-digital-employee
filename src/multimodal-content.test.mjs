import assert from 'node:assert/strict';
import {
  buildDingTalkDriveDownloadArgs,
  buildDingTalkMediaDownloadArgs,
  buildFeishuMediaDownloadArgs,
  buildTranscriptionInvocation,
  parseDingTalkFilePlaceholder,
  parseDingTalkMediaPlaceholder,
} from './multimodal-content.mjs';

assert.deepEqual(
  parseDingTalkMediaPlaceholder('[语音消息](mediaId=@voice_123) 注意：如需下载使用命令'),
  { kind: 'audio', resourceId: '@voice_123', displayName: '语音消息' },
);
assert.deepEqual(
  parseDingTalkMediaPlaceholder('[图片消息](mediaId=@image_456)'),
  { kind: 'image', resourceId: '@image_456', displayName: '图片消息' },
);
assert.deepEqual(
  parseDingTalkMediaPlaceholder('[视频消息] mediaId: @video_789'),
  { kind: 'video', resourceId: '@video_789', displayName: '视频消息' },
);
assert.equal(parseDingTalkMediaPlaceholder('普通文字消息'), null);

assert.deepEqual(
  parseDingTalkFilePlaceholder('[文件] 周报.pdf fileId: 54d69c1f-3f4e 注意：如需下载使用dws drive download命令下载'),
  {
    kind: 'document',
    resourceId: '54d69c1f-3f4e',
    fileName: '周报.pdf',
    displayName: '周报.pdf',
  },
);
assert.equal(parseDingTalkFilePlaceholder('[图片消息](mediaId=@image_456)'), null);

assert.deepEqual(buildDingTalkDriveDownloadArgs({
  profile: 'corp:user',
  fileId: '54d69c1f-3f4e',
  outputPath: '/tmp/aipro-media/周报.pdf',
}), [
  '--profile', 'corp:user',
  'drive', 'download',
  '--node', '54d69c1f-3f4e',
  '--output', '/tmp/aipro-media/周报.pdf',
  '--format', 'json',
]);

assert.deepEqual(buildDingTalkMediaDownloadArgs({
  profile: 'corp:user',
  resourceId: '@voice_123',
  messageId: 'msg-1',
  conversationId: 'cid-1',
  outputPath: '/tmp/aipro-media/audio.bin',
}), [
  '--profile', 'corp:user',
  'chat', 'message', 'download-media',
  '--type', 'mediaId',
  '--resource-id', '@voice_123',
  '--message-id', 'msg-1',
  '--open-conversation-id', 'cid-1',
  '--output', '/tmp/aipro-media/audio.bin',
  '--yes', '--format', 'json',
]);

assert.deepEqual(buildFeishuMediaDownloadArgs({
  messageId: 'om_1',
  fileKey: 'img_1',
  type: 'image',
  outputPath: 'data/media-abc/image.jpg',
}), [
  'im', '+messages-resources-download', '--as', 'user',
  '--message-id', 'om_1', '--file-key', 'img_1', '--type', 'image',
  '--output', 'data/media-abc/image.jpg', '--format', 'json',
]);

assert.deepEqual(buildTranscriptionInvocation({
  command: '/usr/local/bin/transcribe',
  args: ['--input', '{input}', '--language', 'zh'],
  inputPath: '/tmp/a clip.m4a',
}), {
  command: '/usr/local/bin/transcribe',
  args: ['--input', '/tmp/a clip.m4a', '--language', 'zh'],
});
assert.throws(() => buildTranscriptionInvocation({
  command: '/bin/sh',
  args: ['-c', 'cat {input}'],
  inputPath: '/tmp/audio.m4a',
}), /shell execution is not allowed/i);

console.log('MULTIMODAL_CONTENT_TEST_OK');
