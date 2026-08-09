import assert from 'node:assert/strict';
import {
  refersToRecentFiles,
  refersToRecentImages,
  requestedImageLimit,
  selectRecentFileRef,
  selectRecentFileRefs,
  selectRecentImageRefs,
} from './media-context.mjs';

assert.equal(refersToRecentImages('看看刚才那张截图写了什么'), true);
assert.equal(refersToRecentImages('今天开会吗'), false);
assert.equal(refersToRecentFiles('帮我总结一下上面的 PDF'), true);
assert.equal(refersToRecentFiles('帮我写一个项目文档'), false);
assert.equal(requestedImageLimit('分析这两张图片'), 2);

const currentTime = 2_000_000;
const items = [
  {
    message_id: 'image-new',
    msg_type: 'image',
    create_time: String(currentTime - 1_000),
    sender: { sender_type: 'user', id: 'owner' },
    body: { content: JSON.stringify({ image_key: 'img-new' }) },
  },
  {
    message_id: 'image-old',
    msg_type: 'image',
    create_time: String(currentTime - 2_000),
    sender: { sender_type: 'user', id: 'owner' },
    body: { content: JSON.stringify({ image_key: 'img-old' }) },
  },
  {
    message_id: 'file-new',
    msg_type: 'file',
    create_time: String(currentTime - 500),
    sender: { sender_type: 'user', id: 'owner' },
    body: { content: JSON.stringify({ file_key: 'file-new', file_name: '说明.pdf' }) },
  },
  {
    message_id: 'file-older',
    msg_type: 'file',
    create_time: String(currentTime - 1_500),
    sender: { sender_type: 'user', id: 'owner' },
    body: { content: JSON.stringify({ file_key: 'file-older', file_name: '附件.docx' }) },
  },
  {
    message_id: 'other-sender',
    msg_type: 'file',
    create_time: String(currentTime - 100),
    sender: { sender_type: 'user', id: 'other' },
    body: { content: JSON.stringify({ file_key: 'private-file', file_name: '其他人.pdf' }) },
  },
  {
    message_id: 'too-old',
    msg_type: 'file',
    create_time: String(currentTime - 31 * 60 * 1_000),
    sender: { sender_type: 'user', id: 'owner' },
    body: { content: JSON.stringify({ file_key: 'expired-file', file_name: '旧文件.pdf' }) },
  },
];

assert.deepEqual(selectRecentImageRefs(items, {
  senderOpenId: 'owner',
  currentTime,
  limit: 2,
}), [
  { messageId: 'image-old', fileKey: 'img-old' },
  { messageId: 'image-new', fileKey: 'img-new' },
]);

assert.deepEqual(selectRecentFileRef(items, {
  senderOpenId: 'owner',
  currentTime,
}), {
  messageId: 'file-new',
  fileKey: 'file-new',
  fileName: '说明.pdf',
});

assert.deepEqual(selectRecentFileRefs(items, {
  senderOpenId: 'owner',
  currentTime,
  limit: 2,
}), [{
  messageId: 'file-older',
  fileKey: 'file-older',
  fileName: '附件.docx',
}, {
  messageId: 'file-new',
  fileKey: 'file-new',
  fileName: '说明.pdf',
}]);

console.log('MEDIA_CONTEXT_TEST_OK');
