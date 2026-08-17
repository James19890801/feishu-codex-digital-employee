import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDingTalkReadiness } from './dingtalk-readiness.mjs';
import { assertInstallationAttestation } from './installation-attestation.mjs';

const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const root = resolve(process.env.ACHONG_VERIFY_ROOT || defaultRoot);
const offline = process.argv.includes('--offline') || process.env.ACHONG_VERIFY_OFFLINE === '1';

async function executableExists(path) {
  if (!path) return false;
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

for (const relativePath of [
  'package.json',
  'src/index.mjs',
  'src/dashboard-server.mjs',
]) {
  await access(join(root, relativePath));
}

const localConfigPath = join(root, 'config.local.json');
const configSource = await fileExists(localConfigPath)
  ? 'config.local.json'
  : offline
    ? 'config.distribution.json'
    : '';
if (!configSource) throw new Error('VERIFY_INSTALL_ERROR config.local.json is missing');
await access(join(root, configSource));

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
if (nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
  throw new Error('VERIFY_INSTALL_ERROR Node.js 22.13+ is required');
}
const sqlite = new DatabaseSync(':memory:');
try {
  sqlite.exec('CREATE TABLE verify_install (ready INTEGER NOT NULL); INSERT INTO verify_install VALUES (1);');
  const row = sqlite.prepare('SELECT ready FROM verify_install').get();
  if (row?.ready !== 1) throw new Error('VERIFY_INSTALL_ERROR SQLite self-test failed');
} finally {
  sqlite.close();
}

const config = JSON.parse(await readFile(join(root, configSource), 'utf8'));
const pythonReady = await executableExists(String(config.pythonBin || ''));
const dingtalk = inspectDingTalkReadiness({
  dwsBin: config.enterpriseChatBin,
  profile: config.enterpriseChatProfile,
  channelCode: config.enterpriseChatChannel,
  env: config.enterpriseChatChannel ? { DWS_CHANNEL: config.enterpriseChatChannel } : {},
});

if (!offline) {
  const dashboardPort = Number(config.dashboardPort || 17655);
  const response = await fetch(`http://127.0.0.1:${dashboardPort}/api/status`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) {
    throw new Error(`VERIFY_INSTALL_ERROR Dashboard returned HTTP ${response.status}`);
  }
  const status = await response.json();
  assertInstallationAttestation(status, {
    id: config.installationId,
    buildSha: config.installationBuildSha,
    root: config.installationRoot,
  });
}

console.log(`NODE_READY=true`);
console.log(`SQLITE_READY=true`);
console.log(`CONFIG_SOURCE=${configSource}`);
console.log(`PYTHON_READY=${pythonReady}`);
console.log(`DINGTALK_DWS_INSTALLED=${dingtalk.installed}`);
console.log(`DINGTALK_AUTHENTICATED=${dingtalk.authenticated}`);
console.log(`DINGTALK_PROFILE_CONFIGURED=${dingtalk.profileConfigured}`);
console.log(`DINGTALK_CHANNEL_CODE_CONFIGURED=${dingtalk.channelCodeConfigured}`);
console.log(`DINGTALK_CONNECTOR_READY=${dingtalk.connectorReady}`);
console.log(`DASHBOARD_READY=${!offline}`);
console.log('VERIFY_INSTALL_OK');
