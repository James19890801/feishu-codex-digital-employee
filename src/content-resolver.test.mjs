import assert from 'node:assert/strict';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInboundContent } from './content-resolver.mjs';

const root = await mkdtemp(join(tmpdir(), 'aipro-content-resolver-'));
const fetched = [];
const result = await resolveInboundContent({
  messageId: 'msg-1',
  items: [
    { kind: 'image', source: 'feishu', resourceId: 'img-1' },
    { kind: 'document', source: 'enterpriseChat', resourceId: 'doc-1', fileName: '报告.pdf' },
    { kind: 'web', source: 'url', url: 'https://example.com/slides.pptx' },
    { kind: 'audio', source: 'enterpriseChat', resourceId: 'audio-1' },
    { kind: 'video', source: 'enterpriseChat', resourceId: 'video-1' },
    { kind: 'document', source: 'enterpriseChat', resourceId: 'broken' },
  ],
}, {
  tempRoot: root,
  fetchItem: async (item, directory) => {
    fetched.push(item.resourceId || item.url);
    if (item.resourceId === 'broken') throw new Error('download unavailable');
    const actualKind = item.kind === 'web' ? 'document' : item.kind;
    const name = `${fetched.length}-${actualKind}.bin`;
    const path = join(directory, name);
    await writeFile(path, item.resourceId || item.url);
    return { path, kind: actualKind, fileName: item.fileName || name };
  },
  extractText: async (_path, item) => `提取：${item.fileName}`,
  transcribe: async (_path, item) => `转写：${item.resourceId}`,
  videoFrames: async (_path, directory) => {
    const frame = join(directory, 'frame.png');
    await writeFile(frame, 'frame');
    return [frame];
  },
});

assert.equal(result.imagePaths.length, 2);
assert.match(result.textBlocks.join('\n'), /提取：报告.pdf/);
assert.match(result.textBlocks.join('\n'), /提取：https:\/\/example.com\/slides.pptx/);
assert.match(result.textBlocks.join('\n'), /转写：audio-1/);
assert.match(result.textBlocks.join('\n'), /转写：video-1/);
assert.equal(result.warnings.length, 1);
assert.match(result.warnings[0], /download unavailable/);
assert.equal(result.sources.length, 5);
await access(result.tempDir);

console.log('CONTENT_RESOLVER_TEST_OK');
