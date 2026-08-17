import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const decode = values => String.fromCodePoint(...values);
const forbidden = [
  [100, 119, 115],
  [100, 105, 110, 103, 116, 97, 108, 107],
  [38025, 38025],
  [38463, 37324],
  [97, 108, 105, 98, 97, 98, 97],
  [119, 117, 107, 111, 110, 103],
  [24735, 31354],
  [97, 111, 110, 101],
  [99, 111, 100, 101, 117, 112],
  [119, 111, 114, 107, 105, 116, 101, 109],
  [119, 111, 114, 107, 32, 105, 116, 101, 109],
  [119, 111, 114, 107, 45, 105, 116, 101, 109],
  [97, 108, 105, 100, 111, 99, 115],
  [115, 104, 97, 110, 106, 105],
  [117, 115, 101, 114, 95, 105, 109, 95, 109, 101, 115, 115, 97, 103, 101],
  [111, 112, 101, 110, 116, 97, 115, 107, 105, 100],
  [115, 101, 110, 100, 115, 116, 97, 116, 117, 115],
  [111, 112, 101, 110, 101, 110, 116, 101, 114, 112, 114, 105, 115, 101, 99, 104, 97, 116],
  [113, 117, 101, 114, 121, 45, 115, 101, 110, 100, 45, 115, 116, 97, 116, 117, 115],
  [97, 105, 45, 116, 97, 103],
  [101, 110, 116, 101, 114, 112, 114, 105, 115, 101, 45, 100, 101, 118, 101, 108, 111, 112, 109, 101, 110, 116],
  [51, 56, 52, 51, 53, 49],
].map(decode);
const bounded = [
  [97, 49],
  [49, 97],
].map(decode);

const listed = spawnSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
assert.equal(listed.status, 0, listed.stderr);

const violations = [];
for (const path of listed.stdout.split('\0').filter(Boolean)) {
  if (path === 'pnpm-lock.yaml') continue;
  const loweredPath = path.toLowerCase();
  for (const word of forbidden) {
    if (loweredPath.includes(word.toLowerCase())) violations.push(`${path}: path`);
  }

  let buffer;
  try {
    buffer = await readFile(path);
  } catch (error) {
    if (error?.code === 'ENOENT') continue;
    throw error;
  }
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8').toLowerCase();
  for (const word of forbidden) {
    if (text.includes(word.toLowerCase())) violations.push(`${path}: ${word}`);
  }
  for (const word of bounded) {
    const pattern = new RegExp(`(^|[^a-z0-9])${word}([^a-z0-9]|$)`, 'iu');
    if (pattern.test(text) || pattern.test(loweredPath)) violations.push(`${path}: legacy project provider`);
  }
}

assert.deepEqual(violations, [], `Public repository contains company-specific integration references:\n${violations.join('\n')}`);
console.log('PUBLIC_REPOSITORY_NEUTRALITY_TEST_OK');
