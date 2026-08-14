import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  classifyContentType,
  downloadPublicContent,
  responseFileName,
} from './remote-content.mjs';

assert.equal(classifyContentType('application/pdf'), 'document');
assert.equal(classifyContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'), 'document');
assert.equal(classifyContentType('image/png'), 'image');
assert.equal(classifyContentType('audio/mpeg'), 'audio');
assert.equal(classifyContentType('video/mp4'), 'video');
assert.equal(classifyContentType('text/html'), 'web');
assert.equal(classifyContentType('application/octet-stream'), 'file');

assert.equal(responseFileName({
  contentDisposition: "attachment; filename*=UTF-8''%E5%91%A8%E6%8A%A5.pdf",
  sourceUrl: 'https://example.test/download',
  mimeType: 'application/pdf',
}), '周报.pdf');
assert.equal(responseFileName({
  sourceUrl: 'https://example.test/download',
  mimeType: 'image/gif',
}), 'download.gif');
assert.equal(responseFileName({
  sourceUrl: 'https://example.test/download',
  mimeType: 'image/webp',
}), 'download.webp');

const outputDir = await mkdtemp(join(tmpdir(), 'aipro-remote-content-'));
const downloaded = await downloadPublicContent('https://docs.example.test/start', outputDir, {
  lookup: async hostname => {
    assert.equal(hostname, 'docs.example.test');
    return [{ address: '93.184.216.34', family: 4 }];
  },
  fetchImpl: async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    return new Response(new Uint8Array([37, 80, 68, 70]), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="report.pdf"',
      },
    });
  },
  dispatcherFactory: () => ({ close: async () => {} }),
});
assert.equal(downloaded.kind, 'document');
assert.equal(downloaded.fileName, 'report.pdf');
assert.deepEqual([...await readFile(downloaded.path)], [37, 80, 68, 70]);

const genericMimeImage = await downloadPublicContent('https://media.example.test/wechat-image', outputDir, {
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  fetchImpl: async () => new Response(new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46,
  ]), {
    status: 200,
    headers: { 'content-type': 'application/octst-stream' },
  }),
  dispatcherFactory: () => ({ close: async () => {} }),
});
assert.equal(genericMimeImage.kind, 'image', 'valid image bytes must override GeWe generic MIME');
assert.equal(genericMimeImage.mimeType, 'image/jpeg');
assert.match(genericMimeImage.fileName, /\.jpg$/);

await assert.rejects(
  downloadPublicContent('http://localhost/private.pdf', outputDir, {
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    fetchImpl: async () => { throw new Error('must not fetch'); },
  }),
  /not public/i,
);

await assert.rejects(
  downloadPublicContent('https://docs.example.test/huge.pdf', outputDir, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => new Response(new Uint8Array(9), {
      headers: { 'content-type': 'application/pdf', 'content-length': '9' },
    }),
    dispatcherFactory: () => ({ close: async () => {} }),
    maxBytes: 8,
  }),
  /size limit/i,
);
assert.equal((await readdir(outputDir)).some(name => name.endsWith('.part')), false);

let oversizedStreamCancelled = false;
await assert.rejects(
  downloadPublicContent('https://docs.example.test/streamed-huge.pdf', outputDir, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
      },
      pull(controller) {
        controller.enqueue(new Uint8Array([6, 7, 8, 9, 10]));
      },
      cancel() {
        oversizedStreamCancelled = true;
      },
    }), { headers: { 'content-type': 'application/pdf' } }),
    dispatcherFactory: () => ({ close: async () => {} }),
    maxBytes: 8,
  }),
  /size limit/i,
);
assert.equal(oversizedStreamCancelled, true);
assert.equal((await readdir(outputDir)).some(name => name.endsWith('.part')), false);

console.log('REMOTE_CONTENT_TEST_OK');
