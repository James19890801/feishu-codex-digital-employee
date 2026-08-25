import assert from 'node:assert/strict';
import { chmod, cp, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const distributionPath = join(root, 'config.distribution.json');
const defaults = JSON.parse(await readFile(distributionPath, 'utf8'));
const example = JSON.parse(await readFile(join(root, 'config.example.json'), 'utf8'));
const packageMetadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

assert.equal(packageMetadata.author, '阿充');

for (const key of [
  'feishuEnabled', 'wecomEnabled', 'geweEnabled',
  'a1Enabled', 'multicaEnabled', 'licensingEnforced',
]) {
  assert.equal(defaults[key], false, `${key} must fail closed`);
}
assert.equal(defaults.dingtalkEnabled, true);
assert.equal(defaults.dingtalkTransport, 'event-stream');
assert.equal(defaults.dingtalkProfile, '');
assert.equal(defaults.dingtalkChannel, '');
assert.equal(defaults.dingtalkBin, '');
assert.equal(example.dingtalkEnabled, true);
assert.equal(example.dingtalkTransport, 'event-stream');
assert.equal(example.feishuEnabled, false);
assert.equal(example.feishuAppId, '');
assert.equal(example.ownerOpenId, '');
assert.equal(defaults.allowAllChats, false);
assert.deepEqual(defaults.authorizedChatIds, ['__SETUP_REQUIRED__']);
assert.equal(defaults.ownerOpenId, '');
assert.equal(defaults.dingtalkOwnerOpenId, '');
assert.equal(defaults.aiRuntime, 'auto');
for (const candidate of [defaults, example]) {
  assert.equal(candidate.cloudFailoverEnabled, false);
  assert.equal(candidate.cloudFailoverBaseUrl, '');
  assert.equal(candidate.cloudFailoverNodeId, '');
  assert.equal(candidate.cloudFailoverHeartbeatMs, 30_000);
  assert.equal(candidate.cloudFailoverMissThreshold, 3);
  assert.equal(candidate.cloudFailoverRecoveryThreshold, 3);
  assert.equal(candidate.cloudFailoverLocalAttempts, 3);
  assert.equal(candidate.cloudFailoverMaxPromptChars, 24_000);
  assert.equal(candidate.cloudFailoverKeychainService, 'james-cloud-failover');
  assert.equal(candidate.cloudFailoverKeychainAccount, 'hmac-secret');
}
assert.deepEqual(defaults.automaticCommunicationBlocklist, []);
assert.equal(defaults.webReaderEnabled, true);
assert.equal(defaults.webReaderMaxUrls, 2);
assert.equal(defaults.audioTranscriptionCommand, '');
assert.deepEqual(defaults.audioTranscriptionArgs, ['{input}', 'zh-CN']);
assert.equal(example.webReaderEnabled, true);
assert.equal(example.webReaderMaxUrls, 2);

const fixture = await mkdtemp(join(tmpdir(), 'james-safe-setup-'));
await mkdir(join(fixture, 'scripts'), { recursive: true });
await mkdir(join(fixture, 'templates'), { recursive: true });
await mkdir(join(fixture, 'src'), { recursive: true });
await cp(join(root, 'scripts', 'setup.sh'), join(fixture, 'scripts', 'setup.sh'));
await cp(distributionPath, join(fixture, 'config.distribution.json'));
await cp(join(root, 'templates', 'PERSONA.example.md'), join(fixture, 'templates', 'PERSONA.example.md'));
await cp(join(root, 'templates', 'BIBLE.example.md'), join(fixture, 'templates', 'BIBLE.example.md'));
await cp(join(root, 'templates', 'knowledge-catalog.example.json'), join(fixture, 'templates', 'knowledge-catalog.example.json'));
await writeFile(join(fixture, 'requirements.txt'), '', 'utf8');
await writeFile(join(fixture, 'src', 'ai-runtime.mjs'), '', 'utf8');

const bin = join(fixture, 'stub-bin');
await mkdir(bin);
for (const executable of ['node', 'python3', 'pnpm']) {
  const target = join(bin, executable);
  await writeFile(target, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(target, 0o755);
}
const result = spawnSync('/bin/zsh', [join(fixture, 'scripts', 'setup.sh')], {
  cwd: fixture,
  env: {
    HOME: join(fixture, 'home'),
    PATH: `${bin}:/usr/bin:/bin`,
    JAMES_CONFIG_TEMPLATE: join(fixture, 'config.distribution.json'),
  },
  encoding: 'utf8',
});
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
const installed = JSON.parse(await readFile(join(fixture, 'config.local.json'), 'utf8'));
assert.equal(installed.feishuEnabled, false);
assert.equal(installed.dingtalkEnabled, true);
assert.equal(installed.dingtalkTransport, 'event-stream');
assert.equal(installed.allowAllChats, false);
assert.deepEqual(
  JSON.parse(await readFile(join(fixture, 'knowledge-catalog.json'), 'utf8')),
  { documents: [] },
);

console.log('DISTRIBUTION_DEFAULTS_TEST_OK');
