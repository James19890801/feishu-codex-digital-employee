import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  access,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { resolveStandaloneDws } from './dws-deployment-policy.mjs';

const packageRoot = resolve(process.argv[2] || '.');
const payloadRoot = join(packageRoot, 'payload');
const installHome = resolve(process.env.ACHONG_INSTALL_HOME || process.env.HOME || '');
const installRoot = resolve(
  process.env.ACHONG_INSTALL_ROOT
    || join(installHome, 'Library', 'Application Support', 'AchongDigitalHuman'),
);
const skipDependencies = process.env.ACHONG_SKIP_DEPENDENCIES === '1';
const skipOpen = process.env.ACHONG_SKIP_OPEN === '1';

function assertSafeInstallRoot(path) {
  if (!path || path === '/' || path === installHome || dirname(path) === path) {
    throw new Error('Unsafe installation root');
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function sha256(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyChecksums() {
  const lines = (await readFile(join(packageRoot, 'SHA256SUMS'), 'utf8'))
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('Checksum manifest is empty');
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64})  (payload\/.+)$/u);
    if (!match) throw new Error('Checksum manifest contains an invalid entry');
    const target = resolve(packageRoot, match[2]);
    if (!target.startsWith(`${payloadRoot}${sep}`)) throw new Error('Checksum path escapes payload');
    if (await sha256(target) !== match[1]) {
      throw new Error(`Checksum mismatch: ${match[2]}`);
    }
  }
}

function run(command, args, { cwd = installRoot, env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ''}`);
  }
  return result;
}

async function copyUserState(sourceRoot, stageRoot) {
  for (const name of ['config.local.json', 'PERSONA.md', 'BIBLE.md', 'data']) {
    const source = join(sourceRoot, name);
    if (!(await exists(source))) continue;
    const target = join(stageRoot, name);
    await rm(target, { recursive: true, force: true });
    await cp(source, target, { recursive: true, preserveTimestamps: true });
  }
}

async function initializeUserState(stageRoot) {
  let createdConfig = false;
  const configPath = join(stageRoot, 'config.local.json');
  if (!(await exists(configPath))) {
    await copyFile(join(stageRoot, 'config.distribution.json'), configPath);
    createdConfig = true;
  }
  for (const [target, template] of [
    ['PERSONA.md', 'PERSONA.example.md'],
    ['BIBLE.md', 'BIBLE.example.md'],
    ['knowledge-catalog.json', 'knowledge-catalog.example.json'],
  ]) {
    const targetPath = join(stageRoot, target);
    if (!(await exists(targetPath))) {
      await copyFile(join(stageRoot, 'templates', template), targetPath);
    }
  }
  await mkdir(join(stageRoot, 'data'), { recursive: true });
  if (createdConfig) {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    config.nodeBin = dirname(process.execPath);
    config.pythonBin = join(installRoot, '.venv', 'bin', 'python3');
    config.dingtalkBin = await resolveStandaloneDws({
      explicitPath: process.env.JAMES_DWS_BIN || '',
      home: installHome,
    });
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
}

function installDependencies(stageRoot) {
  if (skipDependencies) return;
  const pnpm = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v pnpm'], { encoding: 'utf8' });
  if (pnpm.status === 0 && pnpm.stdout.trim()) {
    run(pnpm.stdout.trim(), [
      'install', '--prod', '--filter', 'feishu-codex-digital-employee', '--frozen-lockfile',
    ], { cwd: stageRoot });
  } else {
    const corepack = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v corepack'], { encoding: 'utf8' });
    if (corepack.status !== 0 || !corepack.stdout.trim()) {
      throw new Error('pnpm or Corepack is required');
    }
    run(corepack.stdout.trim(), [
      'pnpm', 'install', '--prod', '--filter',
      'feishu-codex-digital-employee', '--frozen-lockfile',
    ], { cwd: stageRoot });
  }
  const python = spawnSync('/usr/bin/env', ['sh', '-c', 'command -v python3'], { encoding: 'utf8' });
  if (python.status !== 0 || !python.stdout.trim()) throw new Error('Python 3 is required');
  run(python.stdout.trim(), ['-m', 'venv', join(stageRoot, '.venv')], { cwd: stageRoot });
  run(join(stageRoot, '.venv', 'bin', 'python3'), [
    '-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(stageRoot, 'requirements.txt'),
  ], { cwd: stageRoot });
}

function installServices() {
  const serviceEnv = {
    ...process.env,
    HOME: installHome,
    ACHONG_INSTALL_HOME: installHome,
  };
  run('/bin/zsh', [join(installRoot, 'scripts', 'install-service.sh')], {
    cwd: installRoot,
    env: serviceEnv,
  });
  run('/bin/zsh', [join(installRoot, 'scripts', 'install-dashboard-service.sh')], {
    cwd: installRoot,
    env: serviceEnv,
  });
}

async function verifyDashboard() {
  if (skipDependencies) return;
  const config = JSON.parse(await readFile(join(installRoot, 'config.local.json'), 'utf8'));
  const url = `http://127.0.0.1:${Number(config.dashboardPort || 17655)}/api/status`;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Dashboard health check failed: ${String(lastError?.message || lastError)}`);
}

assertSafeInstallRoot(installRoot);
await verifyChecksums();
await mkdir(dirname(installRoot), { recursive: true });
const stageRoot = await mkdtemp(join(dirname(installRoot), '.james-stage-'));
const backupRoot = `${installRoot}.previous-${process.pid}`;
let previousExists = false;
let switched = false;

try {
  await cp(payloadRoot, stageRoot, { recursive: true, preserveTimestamps: true });
  previousExists = await exists(installRoot);
  if (previousExists) await copyUserState(installRoot, stageRoot);
  await initializeUserState(stageRoot);
  installDependencies(stageRoot);

  await rm(backupRoot, { recursive: true, force: true });
  if (previousExists) await rename(installRoot, backupRoot);
  await rename(stageRoot, installRoot);
  switched = true;
  installServices();
  await verifyDashboard();
  await rm(backupRoot, { recursive: true, force: true });
  if (!skipOpen) run('/usr/bin/open', ['http://127.0.0.1:17655/'], { cwd: installRoot });
  console.log('INSTALL_OK');
  console.log(`INSTALL_ROOT=${installRoot}`);
  console.log('DASHBOARD_URL=http://127.0.0.1:17655/');
  console.log('NEXT_STEP=Open the local Dashboard and complete your own channel authorization.');
} catch (error) {
  if (switched) {
    await rm(installRoot, { recursive: true, force: true });
    if (previousExists && await exists(backupRoot)) await rename(backupRoot, installRoot);
    console.error(`INSTALL_ROLLBACK ${String(error?.message || error)}`);
  } else {
    await rm(stageRoot, { recursive: true, force: true });
    console.error(`INSTALL_ERROR ${String(error?.message || error)}`);
  }
  process.exitCode = 1;
}
