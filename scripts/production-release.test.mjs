import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  activateProductionRelease,
  buildProductionRelease,
  inspectGitSource,
  rollbackProductionRelease,
  switchProductionRelease,
} from './production-release.mjs';
import { parseProductionReleaseArgs } from './build-production-release.mjs';

assert.deepEqual(parseProductionReleaseArgs([
  '--source', '/tmp/source',
  '--support-root', '/tmp/support',
  '--tag', 'v1',
  '--dry-run',
]), {
  source: '/tmp/source',
  supportRoot: '/tmp/support',
  tag: 'v1',
  dryRun: true,
});
assert.throws(() => parseProductionReleaseArgs(['--source', '/tmp/source']), /support-root/i);

const execFile = promisify(execFileCallback);

async function put(root, relativePath, content = '') {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

const source = await mkdtemp(join(tmpdir(), 'aipro-release-source-'));
const supportRoot = await mkdtemp(join(tmpdir(), 'aipro-release-support-'));
await put(source, 'package.json', '{"name":"aipro-test","version":"1.0.0","type":"module","dependencies":{}}\n');
await put(source, 'package-lock.json', '{"name":"aipro-test","version":"1.0.0","lockfileVersion":3,"packages":{"":{"name":"aipro-test","version":"1.0.0"}}}\n');
await put(source, 'src/index.mjs', 'export const ready = true;\n');
await put(source, 'src/index.test.mjs', 'private test fixture\n');
await put(source, 'scripts/wechat-reliability-supervisor.mjs', 'export const supervisor = true;\n');
await put(source, 'dashboard/index.html', '<h1>AIPRO</h1>\n');
await put(source, 'config.local.json', '{"token":"private"}\n');
await put(source, 'data/state.sqlite', 'private data\n');
await put(source, 'outputs/report.md', 'private output\n');
await put(source, 'security-reports/private.json', '{}\n');
await execFile('/usr/bin/git', ['init'], { cwd: source });
await execFile('/usr/bin/git', ['config', 'user.email', 'test@example.com'], { cwd: source });
await execFile('/usr/bin/git', ['config', 'user.name', 'Test'], { cwd: source });

await assert.rejects(
  inspectGitSource({ source }),
  error => error?.code === 'RELEASE_SOURCE_DIRTY',
);

await execFile('/usr/bin/git', ['add', '-A'], { cwd: source });
await execFile('/usr/bin/git', ['commit', '-m', 'fixture'], { cwd: source });
await execFile('/usr/bin/git', ['checkout', '--detach'], { cwd: source });
const inspected = await inspectGitSource({ source });
assert.match(inspected.sha, /^[a-f0-9]{40}$/);
assert.equal(inspected.detached, true);

const built = await buildProductionRelease({
  source,
  supportRoot,
  tag: 'prod-test',
  now: () => Date.parse('2026-08-22T12:00:00.000Z'),
  installDependencies: async () => {},
});
assert.equal(built.version.includes(inspected.sha.slice(0, 12)), true);
assert.equal(built.version.includes('prod-test'), true);
const manifest = JSON.parse(await readFile(join(built.path, 'release-manifest.json'), 'utf8'));
const manifestPaths = manifest.files.map(file => file.path);
for (const included of [
  'package.json',
  'package-lock.json',
  'src/index.mjs',
  'scripts/wechat-reliability-supervisor.mjs',
  'dashboard/index.html',
]) {
  assert.equal(manifestPaths.includes(included), true, included);
}
for (const excluded of [
  'src/index.test.mjs', 'config.local.json', 'data/state.sqlite',
  'outputs/report.md', 'security-reports/private.json',
]) {
  assert.equal(manifestPaths.includes(excluded), false, excluded);
}
assert.equal((await stat(join(built.path, 'src/index.mjs'))).mode & 0o222, 0);
assert.equal((await stat(built.path)).mode & 0o222, 0);

const first = await switchProductionRelease({
  supportRoot,
  releasePath: built.path,
  validate: async releasePath => assert.equal(releasePath, built.path),
});
assert.equal(first.current, built.path);
assert.equal(await readlink(join(supportRoot, 'current')), built.path);

const secondPath = join(supportRoot, 'releases', 'second-release');
await mkdir(secondPath, { recursive: true });
await chmod(secondPath, 0o555);
const second = await switchProductionRelease({
  supportRoot,
  releasePath: secondPath,
  validate: async () => {},
});
assert.equal(second.previous, built.path);
assert.equal(await readlink(join(supportRoot, 'current')), secondPath);
assert.equal(await readlink(join(supportRoot, 'previous')), built.path);

await assert.rejects(
  switchProductionRelease({
    supportRoot,
    releasePath: built.path,
    validate: async () => { throw new Error('candidate unhealthy'); },
  }),
  /candidate unhealthy/,
);
assert.equal(await readlink(join(supportRoot, 'current')), secondPath);
assert.equal(await readlink(join(supportRoot, 'previous')), built.path);

const rolledBack = await rollbackProductionRelease({ supportRoot });
assert.equal(rolledBack.current, built.path);
assert.equal(await readlink(join(supportRoot, 'current')), built.path);
assert.equal((await lstat(join(supportRoot, 'current'))).isSymbolicLink(), true);

const unhealthyPath = join(supportRoot, 'releases', 'unhealthy-release');
await mkdir(unhealthyPath, { recursive: true });
await chmod(unhealthyPath, 0o555);
const activationCalls = [];
await assert.rejects(
  activateProductionRelease({
    supportRoot,
    releasePath: unhealthyPath,
    validateCandidate: async () => {},
    restartServices: async context => { activationCalls.push(`restart:${context.phase}`); },
    verifyHealth: async context => {
      activationCalls.push(`verify:${context.phase}`);
      if (context.phase === 'candidate') throw new Error('private endpoint detail');
    },
  }),
  error => error?.code === 'RELEASE_HEALTH_FAILED'
    && !String(error?.message).includes('private endpoint detail'),
);
assert.equal(await readlink(join(supportRoot, 'current')), built.path);
assert.deepEqual(activationCalls, [
  'restart:candidate',
  'verify:candidate',
  'restart:rollback',
  'verify:rollback',
]);

console.log('PRODUCTION_RELEASE_TEST_OK');
