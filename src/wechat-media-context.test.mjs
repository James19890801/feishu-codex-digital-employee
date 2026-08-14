import assert from 'node:assert/strict';
import {
  downloadWeChatImage,
  recentWeChatImages,
  recentWeChatImageSources,
  rememberWeChatImage,
  rememberWeChatImageSource,
  weChatImageFailurePolicy,
} from './wechat-media-context.mjs';

assert.equal(weChatImageFailurePolicy({ contextOnly: true }), 'observe');
assert.equal(weChatImageFailurePolicy({ contextOnly: false }), 'reply_unavailable');

const values = new Map();
const state = {
  get(namespace, key, fallback) {
    return values.get(`${namespace}:${key}`) ?? fallback;
  },
  set(namespace, key, value) {
    values.set(`${namespace}:${key}`, value);
  },
};

rememberWeChatImage(state, 'wechat:group:room', {
  path: '/tmp/first.jpg', messageId: 'm1', senderId: 'u1', createdAtMs: 1_000,
});
rememberWeChatImage(state, 'wechat:group:room', {
  path: '/tmp/second.png', messageId: 'm2', senderId: 'u2', createdAtMs: 2_000,
});

assert.deepEqual(recentWeChatImages(state, 'wechat:group:room', {
  nowMs: 3_000, limit: 2,
}), [
  { path: '/tmp/first.jpg', messageId: 'm1', senderId: 'u1', createdAtMs: 1_000 },
  { path: '/tmp/second.png', messageId: 'm2', senderId: 'u2', createdAtMs: 2_000 },
]);

assert.deepEqual(recentWeChatImages(state, 'wechat:group:room', {
  nowMs: 31 * 60 * 1_000, limit: 4,
}), []);
assert.deepEqual(recentWeChatImages(state, 'wechat:group:other', {
  nowMs: 3_000, limit: 4,
}), []);

for (let index = 1; index <= 55; index += 1) {
  rememberWeChatImageSource(state, 'wechat:group:room', {
    xml: `<msg><img id="${index}" /></msg>`,
    messageId: `source-${index}`,
    senderId: `u${index % 3}`,
    createdAtMs: 5_000 + index,
  });
}
rememberWeChatImageSource(state, 'wechat:group:other', {
  xml: '<msg><img id="other" /></msg>',
  messageId: 'source-other',
  senderId: 'other',
  createdAtMs: 9_000,
});
rememberWeChatImageSource(state, 'wechat:group:thumbnail-limit', {
  xml: '<msg><img id="oversized-thumbnail" /></msg>',
  thumbnailBase64: 'a'.repeat(512 * 1024 + 1),
  messageId: 'source-oversized-thumbnail',
  senderId: 'u1',
  createdAtMs: 10_000,
});
assert.equal(
  recentWeChatImageSources(state, 'wechat:group:thumbnail-limit', { limit: 1 })[0].thumbnailBase64,
  undefined,
  'oversized thumbnails must be omitted instead of truncated into corrupt image data',
);
const recentSources = recentWeChatImageSources(state, 'wechat:group:room', { limit: 50 });
assert.equal(recentSources.length, 50);
assert.equal(recentSources[0].messageId, 'source-6');
assert.equal(recentSources.at(-1).messageId, 'source-55');
assert.equal(recentSources.some(item => item.messageId === 'source-other'), false);

{
  const calls = [];
  const result = await downloadWeChatImage({
    channel: {
      async downloadImage(xml, options) {
        calls.push({ xml, options });
        return 'https://media.example.com/wechat.jpg';
      },
    },
    image: { xml: '<msg><img /></msg>' },
    outputDir: '/tmp/wechat-media',
    maxBytes: 20 * 1024 * 1024,
    downloadContent: async (url, outputDir, options) => {
      calls.push({ url, outputDir, options });
      return { path: '/tmp/wechat-media/image.jpg', kind: 'image', bytes: 1024 };
    },
  });
  assert.equal(result.path, '/tmp/wechat-media/image.jpg');
  assert.deepEqual(calls[0], { xml: '<msg><img /></msg>', options: { type: 2 } });
  assert.equal(calls[1].options.maxBytes, 20 * 1024 * 1024);
}

{
  let saved = null;
  const result = await downloadWeChatImage({
    channel: { async downloadImage() { throw new Error('regular image unavailable'); } },
    image: {
      xml: '<msg><img /></msg>',
      thumbnailBase64: 'iVBORw0KGgoAAAANSUhEUg==',
    },
    outputDir: '/tmp/wechat-media',
    maxBytes: 1024,
    downloadContent: async () => { throw new Error('must not run'); },
    saveThumbnail: async ({ bytes, extension }) => {
      saved = { bytes: bytes.length, extension };
      return '/tmp/wechat-media/fallback.png';
    },
  });
  assert.deepEqual(saved, { bytes: 16, extension: '.png' });
  assert.equal(result.path, '/tmp/wechat-media/fallback.png');
  assert.equal(result.kind, 'image');
}

{
  const attemptedTypes = [];
  const result = await downloadWeChatImage({
    channel: {
      async downloadImage(_xml, { type }) {
        attemptedTypes.push(type);
        return `https://media.example.com/wechat-${type}`;
      },
    },
    image: { xml: '<msg><img /></msg>' },
    outputDir: '/tmp/wechat-media',
    maxBytes: 1024,
    downloadContent: async url => {
      if (url.endsWith('-2')) return { path: '/tmp/not-image.bin', kind: 'file', bytes: 10 };
      if (url.endsWith('-1')) return { path: '/tmp/high-definition.jpg', kind: 'image', bytes: 100 };
      throw new Error('thumbnail variant should not be reached');
    },
  });
  assert.deepEqual(attemptedTypes, [2, 1]);
  assert.equal(result.path, '/tmp/high-definition.jpg');
}

console.log('WECHAT_MEDIA_CONTEXT_TEST_OK');
