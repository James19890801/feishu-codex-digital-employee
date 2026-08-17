import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildDistribution,
  distributionFileList,
  scanDistribution,
} from './distribution-package.mjs';

async function put(root, relativePath, content = '') {
  const target = join(root, relativePath);
  await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, content, 'utf8');
}

const fixture = await mkdtemp(join(tmpdir(), 'james-package-source-'));
await put(fixture, 'src/index.mjs', 'export const ready = true;\n');
await put(fixture, 'src/index.test.mjs', 'private fixture data\n');
await put(fixture, 'src/__pycache__/extract.cpython-312.pyc', 'compiled local path /Users/private/project\n');
await put(fixture, 'dashboard/index.html', '<h1>Personal Digital Human</h1>\n');
await put(fixture, 'scripts/setup.sh', '#!/bin/zsh\n');
await put(fixture, 'templates/PERSONA.example.md', '# Persona\n');
await put(fixture, 'templates/BIBLE.example.md', '# Bible\n');
await put(fixture, 'templates/knowledge-catalog.example.json', '{"documents":[]}\n');
await put(fixture, 'AI_CODING_INSTALL.md', '# Install\n');
await put(fixture, 'README.md', '# Project\nDeveloper: 阿充 (James Feng / Achong)\n');
await put(fixture, 'config.distribution.json', '{"feishuEnabled":false}\n');
await put(fixture, 'package.json', '{"name":"fixture","version":"1.0.0","author":"阿充"}\n');
await put(fixture, 'pnpm-lock.yaml', 'lockfileVersion: 9\n');
await put(fixture, 'pnpm-workspace.yaml', 'packages: []\n');
await put(fixture, 'requirements.txt', 'pypdf==6.6.2\n');
await put(fixture, 'cloud-failover/worker/src/index.mjs', 'export default {};\n');
await put(fixture, 'cloud-failover/worker/src/index.test.mjs', 'private test\n');
await put(fixture, 'cloud-failover/container/Dockerfile', 'FROM node:24\nUSER node\n');
await put(fixture, 'cloud-failover/worker/.dev.vars', 'QODER_PAT=secret-value\n');
await put(fixture, 'config.local.json', JSON.stringify({
  ownerDisplayName: '阿充',
  ownerAliases: ['James', 'James Feng', 'Achong'],
  ownerOpenId: 'private-open-id-123',
}) + '\n');
await put(fixture, 'PERSONA.md', 'private persona\n');
await put(fixture, 'knowledge-catalog.json', '{"documents":["private"]}\n');
await put(fixture, 'data/state.sqlite', 'private state\n');
await put(fixture, 'docs/private.md', 'private docs\n');
await put(fixture, '.git/config', 'private git\n');

const files = await distributionFileList(fixture);
assert.equal(files.includes('src/index.mjs'), true);
assert.equal(files.includes('dashboard/index.html'), true);
assert.equal(files.includes('README.md'), true);
assert.equal(files.includes('cloud-failover/worker/src/index.mjs'), true);
assert.equal(files.includes('cloud-failover/container/Dockerfile'), true);
for (const forbidden of [
  'src/index.test.mjs', 'src/__pycache__/extract.cpython-312.pyc',
  'config.local.json', 'PERSONA.md', 'knowledge-catalog.json',
  'data/state.sqlite', 'docs/private.md', '.git/config',
  'cloud-failover/worker/src/index.test.mjs', 'cloud-failover/worker/.dev.vars',
]) {
  assert.equal(files.includes(forbidden), false, `${forbidden} must not be distributed`);
}

const dirty = await mkdtemp(join(tmpdir(), 'james-package-dirty-'));
await put(dirty, 'payload/src/secret.mjs', 'const token = "sk-abcdefghijklmnopqrstuvwxyz123456";\n');
const dirtyScan = await scanDistribution(dirty);
assert.equal(dirtyScan.ok, false);
assert.equal(dirtyScan.violations.some(item => item.code === 'SECRET_PATTERN'), true);
assert.equal(JSON.stringify(dirtyScan).includes('sk-abcdefghijklmnopqrstuvwxyz123456'), false);

const consoleSecret = await mkdtemp(join(tmpdir(), 'james-package-console-secret-'));
await put(consoleSecret, 'payload/.env', 'CLOUDFLARE_CONSOLE_PASSWORD=do-not-package-this\n');
const consoleSecretScan = await scanDistribution(consoleSecret);
assert.equal(consoleSecretScan.ok, false);
assert.equal(consoleSecretScan.violations.some(item => item.code === 'SECRET_PATTERN'), true);
assert.equal(JSON.stringify(consoleSecretScan).includes('do-not-package-this'), false);

const outputDir = await mkdtemp(join(tmpdir(), 'james-package-output-'));
const built = await buildDistribution({ root: fixture, outputDir, version: '1.2.3' });
assert.equal(built.fileCount > 0, true);
assert.match(built.sha256, /^[a-f0-9]{64}$/);
const manifest = JSON.parse(await readFile(join(built.directory, 'release-manifest.json'), 'utf8'));
assert.deepEqual(manifest.developers, ['阿充']);
assert.deepEqual(
  [...manifest.files].map(item => item.path),
  [...manifest.files].map(item => item.path).sort((left, right) => left.localeCompare(right)),
);

const unpackagedOutput = await mkdtemp(join(tmpdir(), 'james-package-no-archive-'));
const unpackaged = await buildDistribution({
  root: fixture,
  outputDir: unpackagedOutput,
  version: '1.2.3',
  createArchive: false,
});
assert.equal(unpackaged.archive, null);

const archiveList = spawnSync('/usr/bin/unzip', ['-Z1', built.archive], { encoding: 'utf8' });
assert.equal(archiveList.status, 0, archiveList.stderr);
for (const pattern of [
  /\.git\//, /config\.local\.json$/, /PERSONA\.md$/, /(^|\/)BIBLE\.md$/,
  /knowledge-catalog\.json$/, /\.test\.mjs$/, /(^|\/)docs\//, /(^|\/)data\//,
  /\.log$/, /recovery/i,
]) {
  assert.doesNotMatch(archiveList.stdout, pattern);
}

console.log('DISTRIBUTION_PACKAGE_TEST_OK');
