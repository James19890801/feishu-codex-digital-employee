import { readdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { runBufferedProcess } from './process-runner.mjs';

export async function renderHtmlPreview(htmlPath, {
  outputDir,
  size = 1600,
  optional = false,
  run = (command, args) => runBufferedProcess(command, args, {
    timeoutMs: 45_000,
    maxStdoutBytes: 128 * 1024,
    maxStderrBytes: 128 * 1024,
  }),
} = {}) {
  try {
    await run('/usr/bin/qlmanage', [
      '-t', '-s', String(size), '-o', outputDir, htmlPath,
    ]);
    const expectedPrefix = basename(htmlPath);
    const preview = (await readdir(outputDir))
      .find(name => name.startsWith(expectedPrefix) && name.endsWith('.png'));
    if (!preview) throw new Error('HTML preview was not generated');
    return `${outputDir}/${preview}`;
  } catch (error) {
    if (optional) return '';
    throw error;
  }
}
