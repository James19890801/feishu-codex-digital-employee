import assert from 'node:assert/strict';
import { buildInboundContentEnvelope } from './inbound-content.mjs';

const envelope = buildInboundContentEnvelope({
  message: {
    message_id: 'msg-1',
    chat_id: 'enterpriseChat:group:cid-1',
    chat_type: 'group',
    message_type: 'file',
  },
  senderId: 'enterpriseChat:sender-1',
  text: '请结合 https://example.com/a 和 https://example.com/b 看一下',
  imageRefs: [
    { messageId: 'img-msg-1', fileKey: 'img-1' },
    { messageId: 'img-msg-2', fileKey: 'img-2' },
  ],
  fileRefs: [
    { messageId: 'file-msg-1', fileKey: 'file-1', fileName: '方案.pdf' },
  ],
  metadata: {
    channel: 'enterpriseChat',
    file: {
      resourceId: 'drive-file-1', fileName: '复盘.pptx',
      messageId: 'msg-1', conversationId: 'cid-1',
    },
  },
  maxUrls: 2,
});

assert.equal(envelope.channel, 'enterpriseChat');
assert.equal(envelope.items.length, 6);
assert.deepEqual(envelope.items.map(item => item.kind), [
  'image', 'image', 'document', 'document', 'web', 'web',
]);
assert.deepEqual(envelope.items[3], {
  kind: 'document',
  source: 'enterpriseChat',
  resourceId: 'drive-file-1',
  fileName: '复盘.pptx',
  messageId: 'msg-1',
  conversationId: 'cid-1',
});
assert.equal(envelope.items[4].url, 'https://example.com/a');
assert.equal(envelope.items[5].url, 'https://example.com/b');

const limited = buildInboundContentEnvelope({
  message: { message_id: 'msg-2', chat_id: 'oc_1', chat_type: 'p2p' },
  senderId: 'ou_1',
  imageRefs: [
    { messageId: 'i1', fileKey: 'k1' },
    { messageId: 'i2', fileKey: 'k2' },
  ],
  fileRefs: [{ messageId: 'f1', fileKey: 'fk1', fileName: 'a.pdf' }],
  maxItems: 2,
});
assert.equal(limited.items.length, 2);
assert.equal(limited.truncatedItems, 1);

console.log('INBOUND_CONTENT_TEST_OK');
