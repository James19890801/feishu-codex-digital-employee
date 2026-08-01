import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.mjs';
import { runBufferedProcess } from './process-runner.mjs';

const dir = await mkdtemp(join(tmpdir(), 'aipro-artifact-writer-'));
try {
  for (const [format, signature] of [['docx', 'PK'], ['pdf', '%PDF']]) {
    const path = join(dir, `artifact.${format}`);
    await runBufferedProcess(config.pythonBin, ['src/artifact_writer.py'], {
      cwd: config.workdir,
      input: JSON.stringify({ path, title: '测试方案', content: '# 标题\n\n中文正文', format }),
    });
    const data = await readFile(path);
    assert.equal(data.subarray(0, signature.length).toString(), signature, format);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

console.log('ARTIFACT_WRITER_TEST_OK');
