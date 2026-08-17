import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const installCommand = await readFile(join(root, 'install.command'), 'utf8');
const rootInstaller = await readFile(join(root, 'install.mjs'), 'utf8');

assert.equal(packageJson.engines.node, '>=22.13.0');
assert.match(installCommand, /22\.23\.2/u);
assert.match(installCommand, /minor\s*<\s*13/u);
assert.match(rootInstaller, /node:sqlite/u);

console.log('NODE_REQUIREMENTS_TEST_OK');
