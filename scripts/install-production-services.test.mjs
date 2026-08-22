import assert from 'node:assert/strict';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bootstrapProductionLaunchAgent,
  buildProductionServiceDefinitions,
  installProductionServices,
} from './install-production-services.mjs';

{
  let bootstrapAttempts = 0;
  const waits = [];
  await bootstrapProductionLaunchAgent({
    uid: 501,
    definition: { label: 'com.local.aipro-main', plistPath: '/tmp/main.plist' },
    launchctl: async args => {
      if (args[0] === 'bootstrap' && ++bootstrapAttempts < 8) {
        throw new Error('Bootstrap failed: 5: Input/output error');
      }
    },
    sleep: async milliseconds => { waits.push(milliseconds); },
  });
  assert.equal(bootstrapAttempts, 8);
  assert.deepEqual(waits, [250, 500, 1_000, 1_500, 2_000, 2_500, 3_000]);
}

const root = await mkdtemp(join(tmpdir(), 'aipro-production-services-'));
const userHome = join(root, 'user');
const supportRoot = join(userHome, 'Library', 'Application Support', 'AIPRO');
const releasePath = join(supportRoot, 'releases', 'release-a');
await mkdir(join(releasePath, 'src'), { recursive: true });
await mkdir(join(releasePath, 'scripts'), { recursive: true });
await mkdir(join(supportRoot, 'config'), { recursive: true });
await writeFile(join(releasePath, 'src', 'index.mjs'), '', 'utf8');
await writeFile(join(releasePath, 'src', 'dashboard-server.mjs'), '', 'utf8');
await writeFile(join(releasePath, 'scripts', 'cloudflare-named-tunnel-supervisor.mjs'), '', 'utf8');
await writeFile(join(releasePath, 'scripts', 'gewe-tunnel-supervisor.mjs'), '', 'utf8');
await writeFile(join(releasePath, 'scripts', 'wechat-reliability-supervisor.mjs'), '', 'utf8');
await writeFile(join(releasePath, 'release-manifest.json'), JSON.stringify({
  gitSha: 'a'.repeat(40), files: [],
}), 'utf8');
await writeFile(join(supportRoot, 'config', 'config.local.json'), '{}\n', 'utf8');
await chmod(join(releasePath, 'src', 'index.mjs'), 0o444);
await chmod(join(releasePath, 'src', 'dashboard-server.mjs'), 0o444);
await chmod(join(releasePath, 'scripts', 'cloudflare-named-tunnel-supervisor.mjs'), 0o444);
await chmod(join(releasePath, 'scripts', 'gewe-tunnel-supervisor.mjs'), 0o444);
await chmod(join(releasePath, 'scripts', 'wechat-reliability-supervisor.mjs'), 0o444);
await chmod(join(releasePath, 'release-manifest.json'), 0o444);
await chmod(join(releasePath, 'src'), 0o555);
await chmod(join(releasePath, 'scripts'), 0o555);
await chmod(releasePath, 0o555);
await symlink(releasePath, join(supportRoot, 'current'));

const definitions = await buildProductionServiceDefinitions({
  supportRoot,
  userHome,
  nodePath: '/usr/local/bin/node',
  cloudflaredPath: '/usr/local/bin/cloudflared',
  tunnelKeychainService: 'com.example.aipro.tunnel',
  tunnelKeychainAccount: 'production',
});
assert.deepEqual(definitions.map(definition => definition.label), [
  'com.local.aipro-main',
  'com.local.aipro-cloudflare-tunnel',
  'com.local.aipro-wechat-reliability',
  'com.local.aipro-dashboard',
]);
for (const definition of definitions) {
  assert.equal(definition.plist.includes('.worktrees'), false);
  assert.equal(definition.plist.includes(`${supportRoot}/current`), true);
  assert.equal(definition.plist.includes(`${supportRoot}/logs`), true);
  assert.equal(definition.plist.includes('<key>AIPRO_HOME</key>'), true);
}
assert.match(definitions[0].plist, /<string>\/usr\/bin\/caffeinate<\/string>[\s\S]*<string>-s<\/string>/);
assert.equal(definitions[0].plist.includes('<key>DIGITAL_EMPLOYEE_CONFIG</key>'), true);
assert.equal(definitions[1].plist.includes('127.0.0.1:17657'), true);
assert.equal(definitions[1].plist.includes('TUNNEL_TOKEN'), false);
assert.equal(definitions[1].plist.includes('CLOUDFLARED_TUNNEL_KEYCHAIN_CHUNKS'), true);
assert.equal(definitions[3].plist.includes('<key>AIPRO_MAIN_SERVICE_LABEL</key>'), true);

const emergencyDefinitions = await buildProductionServiceDefinitions({
  supportRoot,
  userHome,
  nodePath: '/usr/local/bin/node',
  cloudflaredPath: '/usr/local/bin/cloudflared',
  tunnelKeychainService: 'com.example.aipro.tunnel',
  tunnelKeychainAccount: 'production',
  tunnelMode: 'quick-emergency',
});
assert.equal(emergencyDefinitions[1].plist.includes('gewe-tunnel-supervisor.mjs'), true);
assert.equal(emergencyDefinitions[1].plist.includes('AIPRO_ALLOW_QUICK_TUNNEL_FALLBACK'), true);
assert.equal(emergencyDefinitions[1].plist.includes('AIPRO_RELIABILITY_SERVICE_LABEL'), true);
assert.equal(emergencyDefinitions[1].plist.includes('127.0.0.1:17657'), true);

await assert.rejects(
  buildProductionServiceDefinitions({
    supportRoot,
    userHome,
    nodePath: '/usr/local/bin/node',
    cloudflaredPath: '/usr/local/bin/cloudflared',
    tunnelKeychainService: '',
    tunnelKeychainAccount: '',
  }),
  /Keychain service and account/i,
);

const launchAgents = join(userHome, 'Library', 'LaunchAgents');
await mkdir(launchAgents, { recursive: true });
const legacyPath = join(launchAgents, 'com.local.feishu-codex-digital-employee.plist');
await writeFile(legacyPath, '<plist/>\n', 'utf8');
const calls = [];
await installProductionServices({
  supportRoot,
  userHome,
  nodePath: '/usr/local/bin/node',
  cloudflaredPath: '/usr/local/bin/cloudflared',
  tunnelKeychainService: 'com.example.aipro.tunnel',
  tunnelKeychainAccount: 'production',
  uid: 501,
  now: () => Date.parse('2026-08-22T12:00:00.000Z'),
  runLaunchctl: async args => { calls.push(args); },
});
for (const definition of definitions) {
  const installedPath = join(launchAgents, `${definition.label}.plist`);
  assert.equal((await stat(installedPath)).mode & 0o777, 0o600);
  assert.equal((await readFile(installedPath, 'utf8')).includes(definition.label), true);
}
assert.deepEqual(
  calls.filter(args => args[0] === 'bootstrap').map(args => args.at(-1).split('/').at(-1)),
  definitions.map(definition => `${definition.label}.plist`),
);
assert.equal(calls.some(args => (
  args[0] === 'bootout'
  && args[1] === 'gui/501/com.local.feishu-codex-digital-employee'
)), true);
const launchAgentFiles = await readdir(launchAgents);
assert.equal(launchAgentFiles.includes('com.local.feishu-codex-digital-employee.plist'), false);
assert.equal(
  launchAgentFiles.some(name => name.startsWith('com.local.feishu-codex-digital-employee.plist.legacy-')),
  true,
);

await assert.rejects(
  installProductionServices({
    supportRoot,
    userHome,
    nodePath: '/usr/local/bin/node',
    cloudflaredPath: '/usr/local/bin/cloudflared',
    tunnelKeychainService: 'com.example.aipro.tunnel',
    tunnelKeychainAccount: 'production',
    uid: 501,
    testMode: true,
  }),
  /injected launchctl/i,
);

const writableRoot = await mkdtemp(join(tmpdir(), 'aipro-writable-release-'));
await mkdir(join(writableRoot, 'releases', 'bad'), { recursive: true });
await writeFile(join(writableRoot, 'releases', 'bad', 'release-manifest.json'), '{}\n');
await symlink(join(writableRoot, 'releases', 'bad'), join(writableRoot, 'current'));
await assert.rejects(
  buildProductionServiceDefinitions({
    supportRoot: writableRoot,
    userHome,
    nodePath: '/usr/local/bin/node',
    cloudflaredPath: '/usr/local/bin/cloudflared',
    tunnelKeychainService: 'com.example.aipro.tunnel',
    tunnelKeychainAccount: 'production',
  }),
  /read-only|manifest/i,
);

console.log('INSTALL_PRODUCTION_SERVICES_TEST_OK');
