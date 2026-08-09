import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { renderHtmlPreview } from './html-preview.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-html-preview-'));
const htmlPath = join(directory, 'report.html');
await writeFile(htmlPath, '<html><body><h1>报告</h1></body></html>');

const preview = await renderHtmlPreview(htmlPath, {
  outputDir: directory,
  run: async (command, args) => {
    assert.equal(command, '/usr/bin/qlmanage');
    assert.deepEqual(args.slice(0, 4), ['-t', '-s', '1600', '-o']);
    await writeFile(join(directory, `${basename(htmlPath)}.png`), 'png');
  },
});
assert.equal(preview, join(directory, 'report.html.png'));

const noPreview = await renderHtmlPreview(htmlPath, {
  outputDir: directory,
  run: async () => { throw new Error('Quick Look unavailable'); },
  optional: true,
});
assert.equal(noPreview, '');

console.log('HTML_PREVIEW_TEST_OK');
