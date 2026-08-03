import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = join(root, 'data', 'wechat-poc');

async function readJson(name) {
  try {
    return JSON.parse(await readFile(join(directory, name), 'utf8'));
  } catch {
    return null;
  }
}

const [control, status] = await Promise.all([
  readJson('control.json'),
  readJson('status.json'),
]);
const payload = {
  ok: true,
  installed: Boolean(status),
  enabled: control?.enabled === true,
  state: status?.state || 'not_installed',
  processAlive: status?.processAlive === true,
  permissionState: status?.permissionState || 'unknown',
  lastTickAt: status?.lastTickAt || '',
  lastError: status?.lastError || null,
};
if (process.argv.includes('--json')) console.log(JSON.stringify(payload));
else console.log(`WeChat POC: ${payload.state}; enabled=${payload.enabled}; process=${payload.processAlive}`);
