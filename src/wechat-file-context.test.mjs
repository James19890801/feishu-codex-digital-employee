import assert from 'node:assert/strict';
import {
  downloadWeChatFile,
  recentWeChatFileSources,
  recentWeChatFiles,
  rememberWeChatFile,
  rememberWeChatFileSource,
  resolveWeChatFileContext,
} from './wechat-file-context.mjs';

const values = new Map();
const state = {
  get(namespace, key, fallback) {
    return values.get(`${namespace}:${key}`) ?? fallback;
  },
  set(namespace, key, value) {
    values.set(`${namespace}:${key}`, value);
  },
};

rememberWeChatFileSource(state, 'wechat:group:room', {
  xml: '<msg><appmsg><type>6</type><aeskey>secret-one</aeskey></appmsg></msg>',
  fileName: 'first.pdf', sizeBytes: 1024,
  messageId: 'file-1', senderId: 'user-1', createdAtMs: 1_000,
});
rememberWeChatFileSource(state, 'wechat:group:room', {
  xml: '<msg><appmsg><type>6</type><aeskey>secret-two</aeskey></appmsg></msg>',
  fileName: 'second.docx', sizeBytes: 2048,
  messageId: 'file-2', senderId: 'user-2', createdAtMs: 2_000,
});
assert.deepEqual(
  recentWeChatFileSources(state, 'wechat:group:room', {
    nowMs: 3_000,
    allowedMessageIds: new Set(['file-2']),
  }).map(item => ({ fileName: item.fileName, messageId: item.messageId })),
  [{ fileName: 'second.docx', messageId: 'file-2' }],
);

rememberWeChatFile(state, 'wechat:group:room', {
  path: '/private/cache/first.pdf', fileName: 'first.pdf',
  messageId: 'file-1', senderId: 'user-1', createdAtMs: 1_000,
});
assert.deepEqual(recentWeChatFiles(state, 'wechat:group:room', {
  nowMs: 3_000, allowedMessageIds: new Set(['file-1']),
}).map(item => item.path), ['/private/cache/first.pdf']);

{
  const direct = resolveWeChatFileContext(state, {
    chatId: 'wechat:group:delayed-room',
    messageId: 'original-file',
    senderId: 'sender-a',
    createdAtMs: 10_000,
    currentFile: {
      xml: '<msg><appmsg><type>6</type><aeskey>private</aeskey></appmsg></msg>',
      fileName: 'delayed.pdf', sizeBytes: 4096,
    },
    shouldRead: false,
  });
  assert.equal(direct.sources.length, 0, 'silent files are recorded without being downloaded');

  const delayed = resolveWeChatFileContext(state, {
    chatId: 'wechat:group:delayed-room',
    messageId: 'later-request',
    senderId: 'sender-b',
    createdAtMs: 20_000,
    shouldRead: true,
    allowedMessageIds: new Set(['original-file']),
  });
  assert.deepEqual(delayed.sources.map(item => item.messageId), ['original-file']);
  assert.deepEqual(delayed.files, []);

  rememberWeChatFile(state, 'wechat:group:delayed-room', {
    path: '/private/cache/delayed.pdf', fileName: 'delayed.pdf',
    messageId: 'original-file', senderId: 'sender-a', createdAtMs: 10_000,
  });
  const cached = resolveWeChatFileContext(state, {
    chatId: 'wechat:group:delayed-room',
    messageId: 'repeat-request',
    senderId: 'sender-c',
    createdAtMs: 30_000,
    shouldRead: true,
    allowedMessageIds: new Set(['original-file']),
  });
  assert.deepEqual(cached.files.map(item => item.messageId), ['original-file']);
  assert.deepEqual(cached.sources, [], 'cached files must not be downloaded again');

  const missingCache = resolveWeChatFileContext(state, {
    chatId: 'wechat:group:delayed-room',
    messageId: 'missing-cache-request',
    senderId: 'sender-c',
    createdAtMs: 40_000,
    shouldRead: true,
    allowedMessageIds: new Set(['original-file']),
    fileExists: () => false,
  });
  assert.deepEqual(missingCache.files, []);
  assert.deepEqual(missingCache.sources.map(item => item.messageId), ['original-file']);
}

{
  const calls = [];
  const result = await downloadWeChatFile({
    channel: {
      async downloadFile(xml) {
        calls.push({ xml });
        return 'https://media.example.com/report.pdf';
      },
    },
    file: {
      xml: '<msg><appmsg><type>6</type></appmsg></msg>',
      fileName: 'report.pdf', sizeBytes: 14090895,
    },
    outputDir: '/private/cache',
    maxBytes: 20 * 1024 * 1024,
    downloadContent: async (url, outputDir, options) => {
      calls.push({ url, outputDir, options });
      return { path: '/private/cache/report.pdf', kind: 'document', bytes: 14090895 };
    },
  });
  assert.equal(result.path, '/private/cache/report.pdf');
  assert.equal(result.fileName, 'report.pdf');
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.maxBytes, 20 * 1024 * 1024);
}

await assert.rejects(
  downloadWeChatFile({
    channel: { async downloadFile() { throw new Error('must not call'); } },
    file: { xml: '<msg />', fileName: 'large.pdf', sizeBytes: 21 * 1024 * 1024 },
    outputDir: '/private/cache',
    maxBytes: 20 * 1024 * 1024,
    downloadContent: async () => { throw new Error('must not call'); },
  }),
  /size limit/i,
);

console.log('WECHAT_FILE_CONTEXT_TEST_OK');
