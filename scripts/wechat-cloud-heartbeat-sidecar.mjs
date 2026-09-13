import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AliyunControlClient } from '../src/aliyun-control-client.mjs';
import { CloudParitySync } from '../src/cloud-parity-sync.mjs';
import { collectParityManifest } from '../src/cloud-parity-collector.mjs';

const DEFAULT_ROOT = join(homedir(), 'Library', 'Application Support', 'AIPRO');
const DEFAULT_ORIGIN = 'https://wxrelay.e2eskill.cn';
const DEFAULT_STATUS_URL = 'http://127.0.0.1:17655/api/status';

function keychainSecret(service, account) {
  return execFileSync('/usr/bin/security', ['find-generic-password', '-s', service,
    '-a', account, '-w'], { encoding: 'utf8', timeout: 10_000 }).trim();
}

export function evaluateMainWechatReadiness(status) {
  const channel = status?.channels?.wechat || {};
  return status?.healthy === true && status?.process?.alive === true
    && status?.aiRuntime?.healthy === true && channel.enabled === true
    && channel.authenticated === true && channel.connected === true
    && channel.callbackListening === true && channel.callbackRegistered === true;
}

export async function runWechatHeartbeatOnce({ paritySync, controlClient, fetchImpl = fetch,
  statusUrl = DEFAULT_STATUS_URL, bootId } = {}) {
  const response = await fetchImpl(statusUrl, { headers: { accept: 'application/json',
    'cache-control': 'no-store' }, signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error(`main_status_http_${response.status}`);
  const status = await response.json();
  const parity = await paritySync.reconcile();
  if (!/^[a-f0-9]{64}$/.test(String(parity?.digest || ''))
    || !Number.isSafeInteger(parity?.workerSequence) || parity.workerSequence < 1) {
    throw new Error('cloud_parity_unacknowledged');
  }
  const generation = await controlClient.localGeneration();
  return controlClient.heartbeat({ generation, bootId, policyDigest: parity.digest,
    criticalStateSequence: parity.workerSequence,
    channels: { wechat: evaluateMainWechatReadiness(status), dingtalk: false } });
}

async function delay(ms, signal) {
  await new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export async function runSidecar({ signal, root = process.env.AIPRO_HOME || DEFAULT_ROOT,
  origin = process.env.AIPRO_WECHAT_CLOUD_ORIGIN || DEFAULT_ORIGIN,
  statusUrl = process.env.AIPRO_LOCAL_STATUS_URL || DEFAULT_STATUS_URL } = {}) {
  const [parityToken, controlToken] = [keychainSecret('ai.aipro.cloud-parity', 'token'),
    keychainSecret('ai.aipro.cloud-control', 'token')];
  const paritySync = new CloudParitySync({ baseUrl: origin, token: parityToken, workerId: 'mac',
    manifestSource: () => collectParityManifest({ root }) });
  const controlClient = new AliyunControlClient({ baseUrl: origin,
    tokenSupplier: async () => controlToken });
  const bootId = `sidecar_${randomBytes(12).toString('hex')}`;
  let previous = '';
  while (!signal?.aborted) {
    try {
      const result = await runWechatHeartbeatOnce({ paritySync, controlClient, statusUrl, bootId });
      const state = `ok:g${result.generation}`;
      if (state !== previous) process.stdout.write(`wechat_cloud_heartbeat ${state}\n`);
      previous = state;
    } catch (error) {
      const state = `error:${String(error?.code || error?.message || error).slice(0, 120)}`;
      if (state !== previous) process.stderr.write(`wechat_cloud_heartbeat ${state}\n`);
      previous = state;
    }
    await delay(15_000, signal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  await runSidecar({ signal: controller.signal });
}
