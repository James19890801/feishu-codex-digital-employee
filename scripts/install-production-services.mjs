#!/usr/bin/env node

import { execFile as execFileCallback } from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import path, { join, resolve } from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFile = promisify(execFileCallback);
const PRODUCTION_LABELS = Object.freeze([
  'com.local.aipro-main',
  'com.local.aipro-cloudflare-tunnel',
  'com.local.aipro-wechat-reliability',
  'com.local.aipro-dashboard',
]);
const LEGACY_LABELS = Object.freeze([
  'com.local.feishu-codex-digital-employee',
  'com.local.feishu-codex-dashboard',
  'com.local.aipro-gewe-tunnel',
  'com.local.aipro-wechat-tunnel',
]);

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plist({ label, args, workdir, environment, stdoutPath, stderrPath }) {
  const argumentsXml = args.map(value => `      <string>${xml(value)}</string>`).join('\n');
  const environmentXml = Object.entries(environment)
    .map(([name, value]) => `      <key>${xml(name)}</key>\n      <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(workdir)}</string>
    <key>EnvironmentVariables</key>
    <dict>
${environmentXml}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${xml(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(stderrPath)}</string>
  </dict>
</plist>
`;
}

async function validateRelease(supportRoot) {
  const root = resolve(supportRoot);
  const currentPath = join(root, 'current');
  const realRoot = await realpath(root);
  const releasePath = await realpath(currentPath);
  const releasesRoot = `${join(realRoot, 'releases')}${path.sep}`;
  if (!releasePath.startsWith(releasesRoot) || releasePath.includes('.worktrees')) {
    throw new Error('Production current release must be inside the isolated releases directory');
  }
  const manifest = JSON.parse(await readFile(join(releasePath, 'release-manifest.json'), 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(String(manifest?.gitSha || '')) || !Array.isArray(manifest?.files)) {
    throw new Error('Production release manifest is missing or invalid');
  }
  if ((await stat(releasePath)).mode & 0o222) {
    throw new Error('Production release must be read-only before service installation');
  }
  for (const required of [
    'src/index.mjs',
    'src/dashboard-server.mjs',
    'scripts/cloudflare-named-tunnel-supervisor.mjs',
    'scripts/wechat-reliability-supervisor.mjs',
  ]) {
    await stat(join(releasePath, required));
  }
  return { root, currentPath, releasePath, manifest };
}

export async function buildProductionServiceDefinitions({
  supportRoot,
  userHome,
  nodePath,
  cloudflaredPath,
  tunnelKeychainService,
  tunnelKeychainAccount,
}) {
  if (!tunnelKeychainService || !tunnelKeychainAccount) {
    throw new Error('Named Tunnel Keychain service and account are required');
  }
  const validated = await validateRelease(supportRoot);
  const launchAgents = join(resolve(userHome), 'Library', 'LaunchAgents');
  const configRoot = join(validated.root, 'config');
  const configPath = join(configRoot, 'config.local.json');
  await stat(configPath);
  const logs = join(validated.root, 'logs');
  const commonEnvironment = {
    AIPRO_HOME: validated.root,
    AIPRO_RESOURCE_ROOT: validated.currentPath,
    AIPRO_CURRENT_PATH: validated.currentPath,
    AIPRO_RUNTIME_ROOT: validated.root,
    AIPRO_CONFIG_ROOT: configRoot,
    DIGITAL_EMPLOYEE_CONFIG: configPath,
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
  };
  const specifications = [
    {
      label: PRODUCTION_LABELS[0],
      args: ['/usr/bin/caffeinate', '-s', nodePath, join(validated.currentPath, 'src', 'index.mjs')],
      environment: commonEnvironment,
      logName: 'main',
    },
    {
      label: PRODUCTION_LABELS[1],
      args: [nodePath, join(validated.currentPath, 'scripts', 'cloudflare-named-tunnel-supervisor.mjs')],
      environment: {
        ...commonEnvironment,
        CLOUDFLARED_PATH: cloudflaredPath,
        CLOUDFLARED_METRICS_ADDRESS: '127.0.0.1:17657',
        CLOUDFLARED_TUNNEL_KEYCHAIN_SERVICE: tunnelKeychainService,
        CLOUDFLARED_TUNNEL_KEYCHAIN_ACCOUNT: tunnelKeychainAccount,
      },
      logName: 'cloudflare-tunnel',
    },
    {
      label: PRODUCTION_LABELS[2],
      args: [nodePath, join(validated.currentPath, 'scripts', 'wechat-reliability-supervisor.mjs')],
      environment: {
        ...commonEnvironment,
        CLOUDFLARED_METRICS_URL: 'http://127.0.0.1:17657',
        AIPRO_WECHAT_RELIABILITY_INTERVAL_MS: '15000',
      },
      logName: 'wechat-reliability',
    },
    {
      label: PRODUCTION_LABELS[3],
      args: [nodePath, join(validated.currentPath, 'src', 'dashboard-server.mjs')],
      environment: {
        ...commonEnvironment,
        AIPRO_MAIN_SERVICE_LABEL: PRODUCTION_LABELS[0],
      },
      logName: 'dashboard',
    },
  ];
  return specifications.map(specification => {
    const plistPath = join(launchAgents, `${specification.label}.plist`);
    return {
      label: specification.label,
      plistPath,
      plist: plist({
        label: specification.label,
        args: specification.args,
        workdir: validated.currentPath,
        environment: specification.environment,
        stdoutPath: join(logs, `${specification.logName}.stdout.log`),
        stderrPath: join(logs, `${specification.logName}.stderr.log`),
      }),
    };
  });
}

async function atomicWrite(pathname, content) {
  const temporary = `${pathname}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o600, flag: 'w' });
  await rename(temporary, pathname);
  await chmod(pathname, 0o600);
}

async function defaultLaunchctl(args) {
  return execFile('/bin/launchctl', args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 128 * 1024,
  });
}

export async function installProductionServices({
  supportRoot,
  userHome,
  nodePath,
  cloudflaredPath,
  tunnelKeychainService,
  tunnelKeychainAccount,
  uid = process.getuid(),
  now = Date.now,
  runLaunchctl,
  testMode = process.env.AIPRO_INSTALL_TEST_MODE === 'true',
}) {
  if (testMode && typeof runLaunchctl !== 'function') {
    throw new Error('Production installer test mode requires an injected launchctl adapter');
  }
  const launchctl = runLaunchctl || defaultLaunchctl;
  const definitions = await buildProductionServiceDefinitions({
    supportRoot,
    userHome,
    nodePath,
    cloudflaredPath,
    tunnelKeychainService,
    tunnelKeychainAccount,
  });
  const launchAgents = join(resolve(userHome), 'Library', 'LaunchAgents');
  await Promise.all([
    mkdir(launchAgents, { recursive: true, mode: 0o700 }),
    mkdir(join(resolve(supportRoot), 'logs'), { recursive: true, mode: 0o700 }),
    mkdir(join(resolve(supportRoot), 'data'), { recursive: true, mode: 0o700 }),
  ]);
  for (const legacyLabel of LEGACY_LABELS) {
    const legacyPath = join(launchAgents, `${legacyLabel}.plist`);
    try {
      await rename(legacyPath, `${legacyPath}.legacy-${now()}`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  for (const definition of definitions) await atomicWrite(definition.plistPath, definition.plist);
  for (const definition of definitions) {
    const domain = `gui/${uid}/${definition.label}`;
    await launchctl(['bootout', domain]).catch(() => {});
    await launchctl(['bootstrap', `gui/${uid}`, definition.plistPath]);
  }
  return { definitions, archivedLegacyLabels: [...LEGACY_LABELS] };
}

async function main() {
  await installProductionServices({
    supportRoot: process.env.AIPRO_HOME
      || join(process.env.HOME || '', 'Library', 'Application Support', 'AIPRO'),
    userHome: process.env.HOME || '',
    nodePath: process.env.AIPRO_NODE_PATH || process.execPath,
    cloudflaredPath: process.env.CLOUDFLARED_PATH
      || join(process.env.HOME || '', '.local', 'bin', 'cloudflared'),
    tunnelKeychainService: process.env.CLOUDFLARED_TUNNEL_KEYCHAIN_SERVICE,
    tunnelKeychainAccount: process.env.CLOUDFLARED_TUNNEL_KEYCHAIN_ACCOUNT,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[production-services] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
