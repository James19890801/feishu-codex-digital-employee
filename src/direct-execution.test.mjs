import assert from 'node:assert/strict';
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDirectExecution } from './direct-execution.mjs';

const root = await mkdtemp(join(tmpdir(), 'aipro-direct-execution-'));
const target = join(root, 'release', 'script.mjs');
const link = join(root, 'current-script.mjs');
await mkdir(join(root, 'release'), { recursive: true });
await writeFile(target, '', 'utf8');
await symlink(target, link);

assert.equal(isDirectExecution(pathToFileURL(target), target), true);
assert.equal(isDirectExecution(pathToFileURL(target), link), true);
assert.equal(isDirectExecution(pathToFileURL(target), join(root, 'other.mjs')), false);
assert.equal(isDirectExecution(pathToFileURL(target), ''), false);

console.log('DIRECT_EXECUTION_TEST_OK');
