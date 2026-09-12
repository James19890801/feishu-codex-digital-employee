#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

function normalizedRelayOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Relay origin must be an HTTPS origin');
  }
  return url.origin;
}

function normalizedLocalWebhook(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || !/^\/webhooks\/gewe\/[A-Za-z0-9_-]{24,128}$/.test(url.pathname)) {
    throw new Error('Local webhook URL must use a loopback host and secret callback path');
  }
  return url.href;
}

export function backoffDelayMs(failures, random = Math.random) {
  const exponent = Math.max(0, Math.min(10, Number(failures) || 0));
  const base = Math.min(60_000, 1_000 * (2 ** exponent));
  return Math.min(60_000, base + Math.floor(base * 0.25 * Math.max(0, Math.min(1, Number(random()) || 0))));
}

export async function deliverLeaseBatch({
  events,
  localWebhookUrl,
  deliver,
  acknowledge,
}) {
  const accepted = [];
  let failed = 0;
  for (const event of Array.isArray(events) ? events : []) {
    try {
      const response = await deliver(event, normalizedLocalWebhook(localWebhookUrl));
      if (response?.status === 202) accepted.push(String(event.id));
      else failed += 1;
    } catch {
      failed += 1;
    }
  }
  let acked = 0;
  if (accepted.length) {
    const result = await acknowledge(accepted);
    acked = Number(result?.acked) || 0;
  }
  return {
    leased: Array.isArray(events) ? events.length : 0,
    delivered: accepted.length,
    failed,
    acked,
  };
}

export async function pollRelayOnce({
  relayOrigin,
  relayToken,
  localWebhookUrl,
  fetchImpl = globalThis.fetch,
  leaseMs = 30_000,
  limit = 10,
}) {
  const origin = normalizedRelayOrigin(relayOrigin);
  const token = String(relayToken || '');
  if (token.length < 24) throw new Error('Relay token is invalid');
  const authorization = `Bearer ${token}`;
  const leaseResponse = await fetchImpl(`${origin}/relay/lease`, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ leaseMs, limit }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!leaseResponse.ok) throw new Error(`Relay lease failed with HTTP ${leaseResponse.status}`);
  const lease = await leaseResponse.json();
  return deliverLeaseBatch({
    events: lease.events,
    localWebhookUrl,
    deliver: (event, url) => fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: String(event.body || ''),
      signal: AbortSignal.timeout(5_000),
    }),
    acknowledge: async ids => {
      const response = await fetchImpl(`${origin}/relay/ack`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Relay ACK failed with HTTP ${response.status}`);
      return response.json();
    },
  });
}

async function readKeychain(service, account) {
  if (!/^[A-Za-z0-9_.:@/-]{1,200}$/.test(service) || !/^[A-Za-z0-9_.:@/-]{1,200}$/.test(account)) {
    throw new Error('Keychain credential name is invalid');
  }
  const result = await execFileAsync('/usr/bin/security', [
    'find-generic-password', '-w', '-s', service, '-a', account,
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 });
  return String(result.stdout || '').trim();
}

async function saveStatus(pathname, payload) {
  const temporary = `${pathname}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, pathname);
}

async function wait(milliseconds, signal) {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('stopped'));
    }, { once: true });
  });
}

export async function runRelayAgent({
  relayOrigin,
  relayToken,
  localWebhookUrl,
  statusPath,
  fetchImpl = globalThis.fetch,
  signal,
  random = Math.random,
}) {
  let failures = 0;
  while (!signal?.aborted) {
    try {
      const result = await pollRelayOnce({ relayOrigin, relayToken, localWebhookUrl, fetchImpl });
      failures = 0;
      await saveStatus(statusPath, { ok: true, checkedAt: new Date().toISOString(), ...result });
      await wait(result.leased ? 100 : 1_000, signal);
    } catch {
      failures += 1;
      await saveStatus(statusPath, {
        ok: false,
        checkedAt: new Date().toISOString(),
        failures,
        errorCode: 'relay_unavailable',
      }).catch(() => {});
      await wait(backoffDelayMs(failures - 1, random), signal);
    }
  }
}

async function main() {
  const home = process.env.AIPRO_HOME || path.join(process.env.HOME || '', 'Library', 'Application Support', 'AIPRO');
  const configPath = process.env.DIGITAL_EMPLOYEE_CONFIG || path.join(home, 'config', 'config.local.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const [relayToken, callbackSecret] = await Promise.all([
    readKeychain(
      process.env.AIPRO_RELAY_KEYCHAIN_SERVICE || 'com.local.aipro.wechat-edge-relay',
      process.env.AIPRO_RELAY_KEYCHAIN_ACCOUNT || 'production',
    ),
    readKeychain(String(config.geweKeychainService), `${String(config.geweAppId)}:callback`),
  ]);
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort(new Error('SIGTERM')));
  process.once('SIGINT', () => controller.abort(new Error('SIGINT')));
  await runRelayAgent({
    relayOrigin: process.env.AIPRO_RELAY_ORIGIN,
    relayToken,
    localWebhookUrl: `http://127.0.0.1:${Number(config.geweCallbackPort || 17656)}/webhooks/gewe/${callbackSecret}`,
    statusPath: path.join(home, 'data', 'wechat-edge-relay.json'),
    signal: controller.signal,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error('[wechat-edge-relay] fatal relay error');
    process.exitCode = 1;
  });
}
