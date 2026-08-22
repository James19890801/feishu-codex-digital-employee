import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const helperUrl = new URL('./keychain-credential-helper.swift', import.meta.url);
const source = await readFile(helperUrl, 'utf8');
assert.match(source, /FileHandle\.standardInput\.readDataToEndOfFile/);
assert.match(source, /SecItemUpdate/);
assert.match(source, /SecItemAdd/);
assert.equal(source.includes('print(credential'), false);
await execFile('/usr/bin/xcrun', [
  'swiftc', '-typecheck', decodeURIComponent(helperUrl.pathname),
], { timeout: 30_000, encoding: 'utf8' });

console.log('KEYCHAIN_CREDENTIAL_HELPER_TEST_OK');
