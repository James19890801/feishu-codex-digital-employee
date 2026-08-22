#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  activateProductionRelease,
  switchProductionRelease,
} from './production-release.mjs';
import { WechatReliabilitySupervisor } from './wechat-reliability-supervisor.mjs';
import { emptyWechatReliabilityState } from '../src/wechat-reliability-policy.mjs';

const PRODUCTION_LABELS = new Set([
  'com.local.aipro-main',
  'com.local.aipro-cloudflare-tunnel',
  'com.local.aipro-wechat-reliability',
  'com.local.aipro-dashboard',
]);
const LAYERS = [
  'local_service',
  'tunnel',
  'public_callback',
  'provider',
  'callback_registration',
];

export function parseWechatReliabilitySmokeArgs(argv) {
  const parsed = { isolatedRoot: '', controlledLive: false, confirmationToken: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--isolated-root') parsed.isolatedRoot = argv[++index] || '';
    else if (argument === '--controlled-live') parsed.controlledLive = true;
    else if (argument === '--confirmation-token') parsed.confirmationToken = argv[++index] || '';
    else throw new Error(`Unknown smoke argument: ${argument}`);
  }
  if (!parsed.isolatedRoot) throw new Error('--isolated-root is required');
  return parsed;
}

export function assertIsolatedSmokeScope({
  isolatedRoot,
  labels = [],
  controlledLive = false,
  confirmationToken = '',
  expectedConfirmationToken = process.env.AIPRO_CONTROLLED_LIVE_TOKEN || '',
}) {
  const root = resolve(String(isolatedRoot || ''));
  if (!root || root === '/' || root === resolve(process.env.HOME || '/nonexistent')) {
    throw new Error('Smoke isolated root is unsafe');
  }
  const hasProductionLabel = labels.some(label => PRODUCTION_LABELS.has(String(label)));
  if (hasProductionLabel && !controlledLive) {
    throw new Error('Smoke refuses a production label outside controlled-live mode');
  }
  if (hasProductionLabel && (!expectedConfirmationToken
    || confirmationToken !== expectedConfirmationToken)) {
    throw new Error('Controlled-live confirmation token is invalid');
  }
  return root;
}

function sample(failedLayer = null) {
  return {
    layers: Object.fromEntries(LAYERS.map(layer => [layer, {
      ok: layer !== failedLayer,
      errorCode: layer === failedLayer ? 'injected_unavailable' : null,
      durationMs: 1,
    }])),
  };
}

function memoryStore(initial = emptyWechatReliabilityState()) {
  return {
    state: structuredClone(initial),
    events: [],
    async load() { return structuredClone(this.state); },
    async save(next) { this.state = structuredClone(next); },
    async appendEvent(event) { this.events.push(structuredClone(event)); },
  };
}

function report(layer, action, startedAt, result = 'ok') {
  return {
    layer,
    action,
    elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    result,
  };
}

async function recoveryScenario(layer, expectedAction) {
  const startedAt = performance.now();
  let nowMs = 10_000;
  const calls = [];
  const store = memoryStore();
  const operations = {
    reconcileMain: async () => { calls.push('reconcile_main_service'); },
    waitMainReady: async () => {},
    reconcileTunnel: async () => { calls.push('reconcile_tunnel'); },
    waitTunnelReady: async () => {},
    alignCallback: async () => { calls.push('align_callback'); },
    verifyPublicCanary: async () => {},
  };
  const supervisor = new WechatReliabilitySupervisor({
    collectSample: async () => sample(layer),
    store,
    operations,
    now: () => nowMs,
    random: () => 0,
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await supervisor.tick();
    nowMs += 1_000;
  }
  assert.equal(calls.includes(expectedAction), true);
  return report(layer, expectedAction, startedAt);
}

async function circuitScenario() {
  const startedAt = performance.now();
  const initial = emptyWechatReliabilityState();
  initial.state = 'degraded';
  initial.layers.tunnel.consecutiveFailures = 2;
  initial.destructiveActionTimesMs = [500, 1_000, 1_500, 2_000, 2_500];
  const store = memoryStore(initial);
  const supervisor = new WechatReliabilitySupervisor({
    collectSample: async () => sample('tunnel'),
    store,
    operations: {},
    now: () => 4_000,
    random: () => 0,
  });
  await supervisor.tick();
  assert.equal(store.state.state, 'circuit_open');
  assert.equal(store.state.recovery, null);
  return report('tunnel', 'circuit_open', startedAt, 'bounded');
}

async function rollbackScenario(isolatedRoot) {
  const startedAt = performance.now();
  const supportRoot = join(isolatedRoot, 'release-fault');
  const knownGood = join(supportRoot, 'releases', 'known-good');
  const unhealthy = join(supportRoot, 'releases', 'unhealthy');
  await Promise.all([
    mkdir(knownGood, { recursive: true }),
    mkdir(unhealthy, { recursive: true }),
  ]);
  await switchProductionRelease({
    supportRoot,
    releasePath: knownGood,
    validate: async () => {},
  });
  await assert.rejects(
    activateProductionRelease({
      supportRoot,
      releasePath: unhealthy,
      validateCandidate: async () => {},
      restartServices: async () => {},
      verifyHealth: async ({ phase }) => {
        if (phase === 'candidate') throw new Error('injected unhealthy release');
      },
    }),
    error => error?.code === 'RELEASE_HEALTH_FAILED',
  );
  return report('release', 'rollback_release', startedAt);
}

async function healthyTransitionScenario() {
  const startedAt = performance.now();
  let nowMs = 20_000;
  const initial = emptyWechatReliabilityState();
  initial.state = 'degraded';
  initial.failureLayer = 'tunnel';
  initial.layers.tunnel.consecutiveFailures = 3;
  const store = memoryStore(initial);
  const supervisor = new WechatReliabilitySupervisor({
    collectSample: async () => sample(),
    store,
    operations: {},
    now: () => nowMs,
    random: () => 0,
  });
  for (let success = 0; success < 3; success += 1) {
    await supervisor.tick();
    nowMs += 1_000;
  }
  assert.equal(store.state.state, 'healthy');
  assert.equal(store.state.consecutiveSuccesses, 3);
  return report('all', 'confirm_healthy', startedAt);
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const port = server.address().port;
  await new Promise((resolvePromise, reject) => server.close(error => (
    error ? reject(error) : resolvePromise()
  )));
  return port;
}

export async function runWechatReliabilitySmoke({
  isolatedRoot,
  labels = ['test.aipro.main', 'test.aipro.tunnel'],
  controlledLive = false,
  confirmationToken = '',
  expectedConfirmationToken,
} = {}) {
  const root = assertIsolatedSmokeScope({
    isolatedRoot,
    labels,
    controlledLive,
    confirmationToken,
    expectedConfirmationToken,
  });
  await mkdir(root, { recursive: true, mode: 0o700 });
  const [localPort, metricsPort] = await Promise.all([reservePort(), reservePort()]);
  const results = [];
  results.push(await recoveryScenario('local_service', 'reconcile_main_service'));
  results.push(await recoveryScenario('tunnel', 'reconcile_tunnel'));
  results.push(await recoveryScenario('public_callback', 'reconcile_tunnel'));
  results.push(await recoveryScenario('callback_registration', 'align_callback'));
  results.push(await circuitScenario());
  results.push(await rollbackScenario(root));
  results.push(await healthyTransitionScenario());
  return {
    ok: results.every(item => ['ok', 'bounded'].includes(item.result)),
    ports: { local: localPort, metrics: metricsPort },
    report: results,
  };
}

async function main() {
  const options = parseWechatReliabilitySmokeArgs(process.argv.slice(2));
  const result = await runWechatReliabilitySmoke(options);
  process.stdout.write(`${JSON.stringify({ ok: result.ok, report: result.report }, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[wechat-reliability-smoke] ${error?.message || error}`);
    process.exitCode = 1;
  });
}
