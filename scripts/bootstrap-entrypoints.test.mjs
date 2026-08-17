import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
async function readOptional(path) {
  try {
    return await readFile(join(root, path), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

const posix = await readOptional('install.command');
const windows = await readOptional('install.ps1');
const distributionBuilder = await readOptional('scripts/distribution-package.mjs');

for (const script of [posix, windows]) {
  assert.match(script, /22\.23\.2/u);
  assert.match(script, /https:\/\/nodejs\.org\/dist\//u);
  assert.match(script, /SHASUMS256\.txt/u);
  assert.doesNotMatch(script, /brew install|winget install|apt(?:-get)? install/iu);
}
assert.match(posix, /shasum|sha256sum/u);
assert.match(posix, /tar\s+-x/u);
assert.match(posix, /export PATH=.*dirname.*NODE/u);
assert.match(windows, /Get-FileHash/u);
assert.match(windows, /Expand-Archive/u);
assert.match(windows, /LOCALAPPDATA/u);
assert.match(windows, /\$env:Path\s*=.*Split-Path.*\$Node/u);
assert.match(distributionBuilder, /'install\.ps1'/u);

console.log('BOOTSTRAP_ENTRYPOINTS_TEST_OK');
