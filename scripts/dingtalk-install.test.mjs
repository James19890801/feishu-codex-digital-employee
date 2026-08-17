import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const lockfile = await readFile(join(root, 'pnpm-lock.yaml'), 'utf8');

assert.equal(packageJson.dependencies?.['dingtalk-workspace-cli'], '1.0.58');
assert.equal(packageJson.packageManager, 'pnpm@9.15.9');
assert.deepEqual(packageJson.pnpm?.onlyBuiltDependencies, ['dingtalk-workspace-cli']);
assert.match(lockfile, /dingtalk-workspace-cli:\s*\n\s+specifier: 1\.0\.58/u);

console.log('DINGTALK_INSTALL_TEST_OK');
