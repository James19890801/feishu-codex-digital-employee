import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

const ROOT_FILES = new Set([
  'AI_CODING_INSTALL.md',
  'README.md',
  'config.distribution.json',
  'docs/CLOUD_FAILOVER.md',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'requirements.txt',
]);

const SCRIPT_FILES = new Set([
  'scripts/check-config.mjs',
  'scripts/check-native.mjs',
  'scripts/check-python.mjs',
  'scripts/cloud-failover-smoke.mjs',
  'scripts/connector-deployment-policy.mjs',
  'scripts/health-check.mjs',
  'scripts/install-aicoding.mjs',
  'scripts/install-dashboard-service.sh',
  'scripts/install-service.sh',
  'scripts/runtime-smoke.mjs',
  'scripts/qoder-cloud-provision.mjs',
  'scripts/setup.sh',
  'scripts/wechat-poc-health.mjs',
  'scripts/wechat-poc-ui.jxa',
  'scripts/wechat-poc-vision.swift',
]);

const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.git(\/|$)/u,
  /(^|\/)node_modules(\/|$)/u,
  /(^|\/)dist(\/|$)/u,
  /(^|\/)data(\/|$)/u,
  /(^|\/)docs\/(?!CLOUD_FAILOVER\.md$)/u,
  /(^|\/)config\.local\.json$/u,
  /(^|\/)\.dev\.vars$/u,
  /(^|\/)PERSONA\.md$/u,
  /(^|\/)BIBLE\.md$/u,
  /(^|\/)knowledge-(?:catalog|source-manifest)\.json$/u,
  /\.test\.[cm]?[jt]s$/u,
  /\.(?:sqlite|sqlite-wal|sqlite-shm|log)$/iu,
  /(?:recovery|founder-recovery|\.james-license)/iu,
];

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}/iu,
  /\bAKID[A-Za-z0-9]{12,}\b/u,
  /\b(?:QODER_PAT|AIPROS_HMAC_SECRET|ENTERPRISE_CHAT_CLIENT_SECRET|CLOUDFLARE_CONSOLE_PASSWORD)[ \t]*=[ \t]*[^\s#]{8,}/u,
];

const PUBLIC_DEVELOPER_IDENTIFIERS = new Set([
  '阿充',
  'James',
  'James Feng',
  'Achong',
]);

function portablePath(root, target) {
  return relative(root, target).split(sep).join('/');
}

function isProductionFile(path) {
  if (ROOT_FILES.has(path)) return true;
  if (SCRIPT_FILES.has(path)) return true;
  if (path.startsWith('src/')) return !/\.test\.[cm]?[jt]s$/u.test(path);
  if (path.startsWith('dashboard/')) return !/\.test\.[cm]?[jt]s$/u.test(path);
  if (path.startsWith('templates/')) return /\.example\.(?:md|json)$/u.test(path);
  if (path.startsWith('cloud-failover/')) {
    return !/\.test\.[cm]?[jt]s$/u.test(path) && !/(^|\/)\.dev\.vars$/u.test(path);
  }
  return false;
}

async function walk(root, { includeForbidden = false } = {}) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const target = join(directory, entry.name);
      const path = portablePath(root, target);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!includeForbidden && FORBIDDEN_PATH_PATTERNS.some(pattern => pattern.test(path))) continue;
        await visit(target);
      } else if (entry.isFile()) {
        output.push({ path, target });
      }
    }
  }
  await visit(root);
  return output;
}

export async function distributionFileList(root) {
  const resolvedRoot = resolve(root);
  const files = await walk(resolvedRoot);
  return files.map(item => item.path).filter(isProductionFile).sort();
}

function violation(path, code) {
  return { path, code };
}

export async function scanDistribution(root, { forbiddenValues = [] } = {}) {
  const resolvedRoot = resolve(root);
  const violations = [];
  const sensitiveValues = [...new Set(
    (Array.isArray(forbiddenValues) ? forbiddenValues : [])
      .map(value => String(value || '').trim())
      .filter(value => value.length >= 4),
  )];
  for (const file of await walk(resolvedRoot, { includeForbidden: true })) {
    if (FORBIDDEN_PATH_PATTERNS.some(pattern => pattern.test(file.path))) {
      violations.push(violation(file.path, 'FORBIDDEN_PATH'));
      continue;
    }
    const info = await stat(file.target);
    if (info.size > 8 * 1024 * 1024) continue;
    const content = await readFile(file.target, 'utf8');
    if (SECRET_PATTERNS.some(pattern => pattern.test(content))) {
      violations.push(violation(file.path, 'SECRET_PATTERN'));
    }
    if (/\/Users\/[A-Za-z0-9._-]+\//u.test(content)) {
      violations.push(violation(file.path, 'PERSONAL_ABSOLUTE_PATH'));
    }
    if (sensitiveValues.some(value => content.includes(value))) {
      violations.push(violation(file.path, 'LOCAL_VALUE'));
    }
  }
  return { ok: violations.length === 0, violations };
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function manifestEntries(directory) {
  const entries = [];
  for (const file of await walk(directory)) {
    const info = await stat(file.target);
    entries.push({
      path: file.path,
      bytes: info.size,
      sha256: await sha256File(file.target),
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

async function localForbiddenValues(root) {
  try {
    const local = JSON.parse(await readFile(join(root, 'config.local.json'), 'utf8'));
    const sensitiveKeys = new Set([
      'ownerDisplayName', 'ownerAliases', 'digitalHumanBrand',
      'feishuAppId', 'ownerOpenId', 'authorizedChatIds', 'ownerContactPhone',
      'actionItemDocumentToken', 'enterpriseChatProfile', 'enterpriseChatChannel',
      'enterpriseChatOwnerOpenId', 'wecomBotId', 'geweAppId',
      'gewePublicCallbackBaseUrl', 'geweMentionNames', 'multicaDefaultWorkspaceId',
      'multicaOwnerSquad', 'codexProxyUrl', 'licensingServiceUrl', 'licensingPublicKey',
    ]);
    const values = [];
    const append = value => {
      const normalized = String(value || '').trim();
      if (normalized.length < 4 || PUBLIC_DEVELOPER_IDENTIFIERS.has(normalized)) return;
      values.push(normalized);
    };
    for (const [key, value] of Object.entries(local)) {
      if (!sensitiveKeys.has(key)) continue;
      if (typeof value === 'string') append(value);
      if (Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string') append(item);
      }
    }
    return values;
  } catch {
    return [];
  }
}

export async function buildDistribution({ root, outputDir, version }) {
  const sourceRoot = resolve(root);
  const targetRoot = resolve(outputDir);
  const packageMetadata = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  const developer = String(packageMetadata.author || '').trim();
  if (developer !== '阿充') {
    throw new Error('Distribution developer must be 阿充');
  }
  const normalizedVersion = String(version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u.test(normalizedVersion)) {
    throw new Error('Distribution version must be a semantic version');
  }
  const packageName = `personal-digital-human-${normalizedVersion}`;
  const directory = join(targetRoot, packageName);
  const archive = `${directory}.zip`;
  await mkdir(targetRoot, { recursive: true });
  await rm(directory, { recursive: true, force: true });
  await rm(archive, { force: true });
  await mkdir(join(directory, 'payload'), { recursive: true });

  const files = await distributionFileList(sourceRoot);
  for (const path of files) {
    const target = join(directory, 'payload', path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(sourceRoot, path), target);
  }
  for (const path of ['AI_CODING_INSTALL.md', 'install.mjs', 'install.command']) {
    try {
      const source = join(sourceRoot, path);
      if (!(await lstat(source)).isFile()) continue;
      await copyFile(source, join(directory, path));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  const forbiddenValues = await localForbiddenValues(sourceRoot);
  const payloadScan = await scanDistribution(join(directory, 'payload'), { forbiddenValues });
  if (!payloadScan.ok) {
    await rm(directory, { recursive: true, force: true });
    const summary = payloadScan.violations.map(item => `${item.code}:${item.path}`).join(', ');
    throw new Error(`Distribution privacy scan failed: ${summary}`);
  }

  const payloadEntries = await manifestEntries(join(directory, 'payload'));
  const bytes = payloadEntries.reduce((sum, item) => sum + item.bytes, 0);
  const releaseManifest = {
    formatVersion: 1,
    product: 'Personal Digital Human',
    developers: [developer],
    version: normalizedVersion,
    fileCount: payloadEntries.length,
    bytes,
    files: payloadEntries.map(item => ({ ...item, path: `payload/${item.path}` })),
  };
  await writeFile(
    join(directory, 'release-manifest.json'),
    `${JSON.stringify(releaseManifest, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(directory, 'SHA256SUMS'),
    `${releaseManifest.files.map(item => `${item.sha256}  ${item.path}`).join('\n')}\n`,
    'utf8',
  );

  const finalScan = await scanDistribution(directory, { forbiddenValues });
  if (!finalScan.ok) {
    await rm(directory, { recursive: true, force: true });
    const summary = finalScan.violations.map(item => `${item.code}:${item.path}`).join(', ');
    throw new Error(`Final distribution privacy scan failed: ${summary}`);
  }
  const ditto = spawnSync('/usr/bin/ditto', [
    '-c', '-k', '--sequesterRsrc', '--keepParent', directory, archive,
  ], { encoding: 'utf8' });
  if (ditto.status !== 0) {
    throw new Error(`ZIP creation failed: ${String(ditto.stderr || ditto.stdout).trim()}`);
  }
  return {
    directory,
    archive,
    sha256: await sha256File(archive),
    fileCount: payloadEntries.length,
    bytes,
  };
}
