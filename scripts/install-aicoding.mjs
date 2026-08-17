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
import { resolveStandaloneConnector } from './connector-deployment-policy.mjs';

const packageRoot = resolve(process.argv[2] || '.');
const payloadRoot = join(packageRoot, 'payload');
const installPlatform = String(process.env.JAMES_INSTALL_PLATFORM || process.platform).trim();
const installHome = resolve(
  process.env.ACHONG_INSTALL_HOME
    || process.env.HOME
    || process.env.USERPROFILE
    || '.',
);
const defaultInstallRoot = installPlatform === 'darwin'
  ? join(installHome, 'Library', 'Application Support', 'JamesDigitalHuman')
  : installPlatform === 'win32'
    ? join(process.env.LOCALAPPDATA || installHome, 'JamesDigitalHuman')
    : join(process.env.XDG_DATA_HOME || join(installHome, '.local', 'share'), 'JamesDigitalHuman');
const installRoot = resolve(
  process.env.ACHONG_INSTALL_ROOT
    || defaultInstallRoot,
);
const skipDependencies = process.env.ACHONG_SKIP_DEPENDENCIES === '1';
const skipServices = process.env.ACHONG_SKIP_SERVICES === '1';
const skipOpen = process.env.ACHONG_SKIP_OPEN === '1';

if (!['darwin', 'win32', 'linux'].includes(installPlatform)) {
  throw new Error(`Unsupported installation platform: ${installPlatform}`);
}

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
  const windowsCommand = installPlatform === 'win32' && /\.(?:cmd|bat)$/iu.test(command);
  const executable = windowsCommand ? (process.env.ComSpec || 'cmd.exe') : command;
  const commandArgs = windowsCommand ? ['/d', '/s', '/c', command, ...args] : args;
  const result = spawnSync(executable, commandArgs, { cwd, env, encoding: 'utf8' });
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
    config.pythonBin = installPlatform === 'win32'
      ? join(installRoot, '.venv', 'Scripts', 'python.exe')
      : join(installRoot, '.venv', 'bin', 'python3');
    const explicitConnector = String(process.env.JAMES_CONNECTOR_BIN || '').trim();
    config.enterpriseChatBin = explicitConnector
      ? await resolveStandaloneConnector({ explicitPath: explicitConnector, home: installHome })
      : '';
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }
}

function installDependencies(stageRoot) {
  if (skipDependencies) return;
  const locator = installPlatform === 'win32' ? 'where.exe' : '/usr/bin/env';
  const locate = command => spawnSync(
    locator,
    installPlatform === 'win32' ? [command] : ['sh', '-c', `command -v ${command}`],
    { encoding: 'utf8' },
  );
  const pnpm = locate(installPlatform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  if (pnpm.status === 0 && pnpm.stdout.trim()) {
    run(pnpm.stdout.trim().split(/\r?\n/u)[0], [
      'install', '--prod', '--filter', 'james-local-digital-human', '--frozen-lockfile',
    ], { cwd: stageRoot });
  } else {
    const corepack = locate(installPlatform === 'win32' ? 'corepack.cmd' : 'corepack');
    if (corepack.status !== 0 || !corepack.stdout.trim()) {
      throw new Error('pnpm or Corepack is required');
    }
    run(corepack.stdout.trim().split(/\r?\n/u)[0], [
      'pnpm', 'install', '--prod', '--filter',
      'james-local-digital-human', '--frozen-lockfile',
    ], { cwd: stageRoot });
  }
  const pythonCandidates = installPlatform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  const python = pythonCandidates.map(locate).find(result => result.status === 0 && result.stdout.trim());
  if (!python) throw new Error('Python 3 is required');
  run(python.stdout.trim().split(/\r?\n/u)[0], ['-m', 'venv', join(stageRoot, '.venv')], { cwd: stageRoot });
  const venvPython = installPlatform === 'win32'
    ? join(stageRoot, '.venv', 'Scripts', 'python.exe')
    : join(stageRoot, '.venv', 'bin', 'python3');
  run(venvPython, [
    '-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(stageRoot, 'requirements.txt'),
  ], { cwd: stageRoot });
}

function quotedSystemdPath(path) {
  return `"${String(path).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

async function installServices() {
  if (skipServices) return;
  const serviceEnv = {
    ...process.env,
    HOME: installHome,
    ACHONG_INSTALL_HOME: installHome,
  };
  if (installPlatform === 'darwin') {
    run('/bin/zsh', [join(installRoot, 'scripts', 'install-service.sh')], {
      cwd: installRoot,
      env: serviceEnv,
    });
    run('/bin/zsh', [join(installRoot, 'scripts', 'install-dashboard-service.sh')], {
      cwd: installRoot,
      env: serviceEnv,
    });
    return;
  }
  if (installPlatform === 'linux') {
    const unitRoot = join(installHome, '.config', 'systemd', 'user');
    await mkdir(unitRoot, { recursive: true });
    const units = [
      ['james-digital-human.service', 'src/index.mjs'],
      ['james-digital-human-dashboard.service', 'src/dashboard-server.mjs'],
    ];
    for (const [name, entry] of units) {
      await writeFile(join(unitRoot, name), [
        '[Unit]',
        'Description=James Local Digital Human',
        'After=network.target',
        '',
        '[Service]',
        `WorkingDirectory=${quotedSystemdPath(installRoot)}`,
        `ExecStart=${quotedSystemdPath(process.execPath)} ${quotedSystemdPath(join(installRoot, entry))}`,
        'Restart=on-failure',
        'RestartSec=3',
        '',
        '[Install]',
        'WantedBy=default.target',
        '',
      ].join('\n'), 'utf8');
    }
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', ...units.map(([name]) => name)]);
    return;
  }
  const tasks = [
    ['James Digital Human', join(installRoot, 'src', 'index.mjs')],
    ['James Digital Human Dashboard', join(installRoot, 'src', 'dashboard-server.mjs')],
  ];
  for (const [name, entry] of tasks) {
    const command = `"${process.execPath}" "${entry}"`;
    run('schtasks.exe', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', name, '/TR', command]);
    run('schtasks.exe', ['/Run', '/TN', name]);
  }
}

function openDashboard() {
  if (skipOpen) return;
  const url = 'http://127.0.0.1:17655/';
  if (installPlatform === 'darwin') run('/usr/bin/open', [url], { cwd: installRoot });
  else if (installPlatform === 'win32') run('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { cwd: installRoot });
  else run('xdg-open', [url], { cwd: installRoot });
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
  await installServices();
  await verifyDashboard();
  await rm(backupRoot, { recursive: true, force: true });
  openDashboard();
  console.log('INSTALL_OK');
  console.log(`INSTALL_PLATFORM=${installPlatform}`);
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
