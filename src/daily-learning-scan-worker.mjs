import { resolve } from 'node:path';
import { scanLearningFiles } from './daily-learning.mjs';

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 64 * 1024) throw new Error('Daily learning scan request is too large');
  chunks.push(chunk);
}
const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
const roots = (Array.isArray(input.roots) ? input.roots : [])
  .slice(0, 8)
  .map(value => resolve(String(value || '')))
  .filter(Boolean);
const sinceMs = Number.isFinite(Number(input.sinceMs)) ? Number(input.sinceMs) : Date.now() - 86_400_000;
let currentDirectory = '';
const progressTimer = setInterval(() => {
  if (currentDirectory) process.stderr.write(`SCANNING ${currentDirectory}\n`);
}, 1_000);
const files = await scanLearningFiles({
  roots,
  sinceMs,
  maxFiles: 160,
  maxExcerptChars: 800,
  maxDirectories: 2_500,
  maxDurationMs: 25_000,
  onDirectory: directory => { currentDirectory = directory; },
});
clearInterval(progressTimer);
process.stdout.write(JSON.stringify(files));
