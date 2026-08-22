import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { distributionFileList } from './distribution-package.mjs';

const execFile = promisify(execFileCallback);

function releaseError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function git(source, args) {
  return execFile('/usr/bin/git', ['-C', source, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

export async function inspectGitSource({ source }) {
  const root = resolve(String(source || ''));
  const { stdout: statusText } = await git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (statusText.trim()) {
    throw releaseError('Production release source must be a clean Git worktree', 'RELEASE_SOURCE_DIRTY');
  }
  const [{ stdout: shaText }, { stdout: branchText }] = await Promise.all([
    git(root, ['rev-parse', 'HEAD']),
    git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(() => ({ stdout: '' })),
  ]);
  const sha = shaText.trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw releaseError('Production release source has no valid Git commit', 'RELEASE_SOURCE_INVALID');
  }
  return { source: root, sha, branch: branchText.trim(), detached: !branchText.trim() };
}

function safeTag(value) {
  return String(value || 'release')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'release';
}

export function createReleaseVersion({ sha, tag, nowMs }) {
  const timestamp = new Date(Number(nowMs)).toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${timestamp}-${safeTag(tag)}-${String(sha).slice(0, 12)}`;
}

async function walkFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(root);
  return files;
}

function portable(root, target) {
  return relative(root, target).split(sep).join('/');
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function makeReadOnly(root) {
  const visit = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(target);
        await chmod(target, 0o555);
      } else if (entry.isFile()) {
        const mode = (await stat(target)).mode;
        await chmod(target, mode & 0o111 ? 0o555 : 0o444);
      }
    }
  };
  await visit(root);
  await chmod(root, 0o555);
}

async function defaultInstallDependencies(releasePath) {
  await execFile('/usr/bin/env', ['npm', 'ci', '--omit=dev', '--ignore-scripts', '--no-audit'], {
    cwd: releasePath,
    encoding: 'utf8',
    timeout: 5 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

export async function buildProductionRelease({
  source,
  supportRoot,
  tag = 'production',
  now = Date.now,
  installDependencies = defaultInstallDependencies,
}) {
  const inspected = await inspectGitSource({ source });
  const version = createReleaseVersion({ sha: inspected.sha, tag, nowMs: now() });
  const releasesRoot = join(resolve(supportRoot), 'releases');
  const releasePath = join(releasesRoot, version);
  await mkdir(releasesRoot, { recursive: true, mode: 0o700 });
  try {
    await lstat(releasePath);
    throw releaseError('Production release version already exists', 'RELEASE_EXISTS');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await mkdir(releasePath, { mode: 0o700 });
  const files = await distributionFileList(inspected.source);
  for (const file of files) {
    const target = join(releasePath, file);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(join(inspected.source, file), target);
  }
  await installDependencies(releasePath);
  const manifestFiles = [];
  for (const target of await walkFiles(releasePath)) {
    const info = await stat(target);
    manifestFiles.push({
      path: portable(releasePath, target),
      bytes: info.size,
      sha256: await sha256(target),
    });
  }
  manifestFiles.sort((left, right) => left.path.localeCompare(right.path));
  const manifest = {
    formatVersion: 1,
    version,
    gitSha: inspected.sha,
    gitBranch: inspected.branch,
    builtAt: new Date(Number(now())).toISOString(),
    files: manifestFiles,
  };
  await writeFile(
    join(releasePath, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  await makeReadOnly(releasePath);
  return { path: releasePath, version, sha: inspected.sha, manifest };
}

async function readLinkIfPresent(path) {
  try {
    return await readlink(path);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EINVAL') return null;
    throw error;
  }
}

async function atomicSymlink(target, linkPath) {
  const temporary = join(dirname(linkPath), `.${basename(linkPath)}.tmp-${process.pid}`);
  try {
    await symlink(target, temporary);
    await rename(temporary, linkPath);
  } catch (error) {
    try { await unlink(temporary); } catch {}
    throw error;
  }
}

export async function switchProductionRelease({ supportRoot, releasePath, validate }) {
  const root = resolve(supportRoot);
  const candidate = resolve(releasePath);
  const info = await stat(candidate);
  if (!info.isDirectory()) throw releaseError('Release candidate is not a directory', 'RELEASE_INVALID');
  if (typeof validate !== 'function') throw new TypeError('Release validation is required');
  await validate(candidate);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const currentLink = join(root, 'current');
  const previousLink = join(root, 'previous');
  const oldCurrent = await readLinkIfPresent(currentLink);
  if (oldCurrent && oldCurrent !== candidate) await atomicSymlink(oldCurrent, previousLink);
  await atomicSymlink(candidate, currentLink);
  return { current: candidate, previous: oldCurrent && oldCurrent !== candidate ? oldCurrent : null };
}

export async function rollbackProductionRelease({ supportRoot, validate = async () => {} }) {
  const root = resolve(supportRoot);
  const currentLink = join(root, 'current');
  const previousLink = join(root, 'previous');
  const [current, previous] = await Promise.all([
    readLinkIfPresent(currentLink),
    readLinkIfPresent(previousLink),
  ]);
  if (!previous) throw releaseError('No previous production release is available', 'RELEASE_ROLLBACK_MISSING');
  await validate(previous);
  await atomicSymlink(previous, currentLink);
  if (current && current !== previous) await atomicSymlink(current, previousLink);
  return { current: previous, previous: current };
}

export async function activateProductionRelease({
  supportRoot,
  releasePath,
  validateCandidate,
  restartServices,
  verifyHealth,
}) {
  if (typeof restartServices !== 'function' || typeof verifyHealth !== 'function') {
    throw new TypeError('Release activation requires restart and health verification operations');
  }
  let switched = false;
  try {
    const links = await switchProductionRelease({
      supportRoot,
      releasePath,
      validate: validateCandidate,
    });
    switched = true;
    await restartServices({ phase: 'candidate', releasePath: links.current });
    await verifyHealth({ phase: 'candidate', releasePath: links.current });
    return { ...links, rolledBack: false };
  } catch {
    if (!switched) throw releaseError(
      'Production release candidate validation failed',
      'RELEASE_VALIDATION_FAILED',
    );
    try {
      const links = await rollbackProductionRelease({ supportRoot });
      await restartServices({ phase: 'rollback', releasePath: links.current });
      await verifyHealth({ phase: 'rollback', releasePath: links.current });
    } catch {
      throw releaseError('Production release rollback failed', 'RELEASE_ROLLBACK_FAILED');
    }
    throw releaseError(
      'Production release failed health verification and was rolled back',
      'RELEASE_HEALTH_FAILED',
    );
  }
}
