import { createHash, randomUUID } from 'node:crypto';
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
import {
  bundledDwsPath,
  resolveStandaloneDws,
} from './connector-deployment-policy.mjs';
import { assertInstallationAttestation } from './installation-attestation.mjs';

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
const skipPython = process.env.ACHONG_SKIP_PYTHON === '1';
const skipServices = process.env.ACHONG_SKIP_SERVICES === '1';
const skipOpen = process.env.ACHONG_SKIP_OPEN === '1';
const skipDingTalkSetup = process.env.ACHONG_SKIP_DINGTALK_SETUP === '1'
  || skipDependencies
  || skipServices;
let expectedInstallation = null;

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
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (createdConfig) {
    config.nodeBin = dirname(process.execPath);
    config.pythonBin = skipPython
      ? ''
      : installPlatform === 'win32'
        ? join(installRoot, '.venv', 'Scripts', 'python.exe')
        : join(installRoot, '.venv', 'bin', 'python3');
    const explicitConnector = String(
      process.env.JAMES_DWS_BIN || process.env.JAMES_CONNECTOR_BIN || '',
    ).trim();
    config.enterpriseChatBin = explicitConnector
      ? await resolveStandaloneDws({ explicitPath: explicitConnector, home: installHome })
      : bundledDwsPath(installRoot, installPlatform);
  }
  config.installationId = /^[A-Za-z0-9-]{8,128}$/u.test(String(config.installationId || ''))
    ? config.installationId
    : randomUUID();
  config.installationBuildSha = await sha256(join(packageRoot, 'release-manifest.json'));
  config.installationRoot = installRoot;
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    id: config.installationId,
    buildSha: config.installationBuildSha,
    root: config.installationRoot,
  };
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
  if (skipPython) {
    console.log('OPTIONAL_CAPABILITY_PYTHON=skipped');
    return;
  }
  const pythonCandidates = installPlatform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python'];
  const python = pythonCandidates.map(locate).find(result => result.status === 0 && result.stdout.trim());
  if (!python) {
    console.log('OPTIONAL_CAPABILITY_PYTHON=unavailable');
    return;
  }
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

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function launchAgentPlist({ label, entry, stdout, stderr }) {
  const path = [
    installRoot,
    join(installRoot, 'node_modules', '.bin'),
    join(installHome, '.npm-global', 'bin'),
    join(installHome, '.local', 'bin'),
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(join(installRoot, entry))}</string></array>
<key>WorkingDirectory</key><string>${xml(installRoot)}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ProcessType</key><string>Interactive</string><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(installRoot, stdout))}</string>
<key>StandardErrorPath</key><string>${xml(join(installRoot, stderr))}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(installHome)}</string><key>PATH</key><string>${xml(path)}</string></dict>
</dict></plist>
`;
}

async function installServices() {
  if (skipServices) return;
  const serviceEnv = {
    ...process.env,
    HOME: installHome,
    ACHONG_INSTALL_HOME: installHome,
  };
  if (installPlatform === 'darwin') {
    const agentRoot = join(installHome, 'Library', 'LaunchAgents');
    await mkdir(agentRoot, { recursive: true });
    const agents = [
      ['com.local.feishu-codex-digital-employee', 'src/index.mjs', 'bridge.log', 'bridge-error.log'],
      ['com.local.feishu-codex-dashboard', 'src/dashboard-server.mjs', 'dashboard.log', 'dashboard-error.log'],
    ];
    for (const [label, entry, stdout, stderr] of agents) {
      const plist = join(agentRoot, `${label}.plist`);
      await writeFile(plist, launchAgentPlist({ label, entry, stdout, stderr }), {
        encoding: 'utf8',
        mode: 0o600,
      });
      const service = `gui/${process.getuid()}/${label}`;
      spawnSync(process.env.ACHONG_LAUNCHCTL || '/bin/launchctl', ['bootout', service], {
        cwd: installRoot,
        env: serviceEnv,
        encoding: 'utf8',
      });
      run(process.env.ACHONG_LAUNCHCTL || '/bin/launchctl', [
        'bootstrap', `gui/${process.getuid()}`, plist,
      ], { cwd: installRoot, env: serviceEnv });
    }
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
  const url = 'http://127.0.0.1:17655/?setup=dingtalk';
  if (installPlatform === 'darwin') run('/usr/bin/open', [url], { cwd: installRoot });
  else if (installPlatform === 'win32') run('cmd.exe', ['/d', '/s', '/c', 'start', '', url], { cwd: installRoot });
  else run('xdg-open', [url], { cwd: installRoot });
}

function setupDingTalk() {
  if (skipDingTalkSetup) return false;
  console.log('DINGTALK_SETUP=starting');
  const result = spawnSync(process.execPath, [join(installRoot, 'scripts', 'setup-dingtalk.mjs')], {
    cwd: installRoot,
    env: { ...process.env, HOME: installHome },
    stdio: 'inherit',
  });
  if (result.status === 0) return true;
  console.error('DINGTALK_SETUP_PENDING=安装已完成，钉钉授权尚未完成。');
  console.error(`DINGTALK_SETUP_COMMAND=${process.execPath} ${join(installRoot, 'scripts', 'setup-dingtalk.mjs')}`);
  return false;
}

async function verifyDashboard() {
  if (skipDependencies || skipServices) return;
  const config = JSON.parse(await readFile(join(installRoot, 'config.local.json'), 'utf8'));
  const url = `http://127.0.0.1:${Number(config.dashboardPort || 17655)}/api/status`;
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (!response.ok) {
        lastError = new Error(`HTTP ${response.status}`);
      } else {
        const status = await response.json();
        assertInstallationAttestation(status, expectedInstallation);
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(`Dashboard health check failed: ${String(lastError?.message || lastError)}`);
}

function verifyInstalledFiles() {
  const args = [join(installRoot, 'scripts', 'verify-install.mjs')];
  if (skipDependencies || skipServices) args.push('--offline');
  const result = run(process.execPath, args, { cwd: installRoot });
  const output = String(result.stdout || '').trim();
  if (output) console.log(output);
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
  expectedInstallation = await initializeUserState(stageRoot);
  installDependencies(stageRoot);

  await rm(backupRoot, { recursive: true, force: true });
  if (previousExists) await rename(installRoot, backupRoot);
  await rename(stageRoot, installRoot);
  switched = true;
  await installServices();
  await verifyDashboard();
  verifyInstalledFiles();
  const dingtalkReady = setupDingTalk();
  await rm(backupRoot, { recursive: true, force: true });
  openDashboard();
  console.log('INSTALL_OK');
  console.log(`INSTALL_PLATFORM=${installPlatform}`);
  console.log(`INSTALL_ROOT=${installRoot}`);
  console.log('DASHBOARD_URL=http://127.0.0.1:17655/?setup=dingtalk');
  console.log(`DINGTALK_SETUP_READY=${dingtalkReady}`);
  console.log(dingtalkReady
    ? 'NEXT_STEP=请让另一个受控钉钉账号发私聊，或在受控测试群 @ 你；不要用自己发给自己的消息验收。'
    : 'NEXT_STEP=完成钉钉 DWS 授权，然后在钉钉里给自己发一条测试消息。');
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
