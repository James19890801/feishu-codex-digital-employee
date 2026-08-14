import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CloudFailoverClient } from '../src/cloud-failover-client.mjs';
import { config } from '../src/config.mjs';

const DEFAULT_STATUS_URL = 'http://127.0.0.1:17655/api/status';

export function buildHeartbeatSnapshot(status, {
  sequence,
  at,
  serviceStartId,
} = {}) {
  const dingtalk = status?.channels?.dingtalk || {};
  return {
    sequence: Number(sequence),
    at: String(at),
    serviceStartId: String(serviceStartId),
    dwsConnected: dingtalk.authenticated === true && dingtalk.connected === true,
    runtimeHealthy: status?.healthy === true
      && status?.process?.alive === true
      && status?.aiRuntime?.healthy === true,
    lastMessageDigest: '',
    appVersion: '1.0.0-sidecar',
    protocolVersion: '1',
  };
}

export async function runHeartbeatOnce({
  client,
  fetchImpl = globalThis.fetch,
  statusUrl = DEFAULT_STATUS_URL,
  sequence,
  serviceStartId,
  now = () => new Date(),
} = {}) {
  const response = await fetchImpl(statusUrl, {
    headers: { accept: 'application/json', 'cache-control': 'no-store' },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Local health endpoint failed with HTTP ${response.status}`);
  const status = await response.json();
  return client.heartbeat(buildHeartbeatSnapshot(status, {
    sequence,
    at: now().toISOString(),
    serviceStartId,
  }));
}

function keychainSecret() {
  return execFileSync('/usr/bin/security', [
    'find-generic-password', '-a', config.cloudFailoverKeychainAccount,
    '-s', config.cloudFailoverKeychainService, '-w',
  ], { encoding: 'utf8', timeout: 10_000 }).trim();
}

async function delay(ms, signal) {
  await new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

export async function runSidecar({ signal } = {}) {
  if (!config.cloudFailoverEnabled) throw new Error('cloudFailoverEnabled must be true');
  const client = new CloudFailoverClient({
    baseUrl: config.cloudFailoverBaseUrl,
    nodeId: config.cloudFailoverNodeId,
    secret: keychainSecret(),
    timeoutMs: 10_000,
  });
  const serviceStartId = `sidecar-${randomBytes(12).toString('hex')}`;
  const statusUrl = process.env.AIPROS_LOCAL_STATUS_URL
    || `http://127.0.0.1:${Number(config.dashboardPort || 17655)}/api/status`;
  let sequence = 0;
  let lastState = '';
  while (!signal?.aborted) {
    sequence += 1;
    try {
      const result = await runHeartbeatOnce({
        client, statusUrl, sequence, serviceStartId,
      });
      if (result.state !== lastState) {
        console.log('cloud_failover_sidecar_state', {
          state: result.state,
          generation: Number(result.generation || 0),
        });
        lastState = result.state;
      }
    } catch (error) {
      console.error('cloud_failover_sidecar_error', {
        code: String(error?.code || error?.name || 'sidecar_error').slice(0, 64),
        message: String(error?.message || error).slice(0, 160),
      });
    }
    await delay(config.cloudFailoverHeartbeatMs, signal);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  await runSidecar({ signal: controller.signal });
}
