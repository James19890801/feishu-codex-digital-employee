#!/usr/bin/env node

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readKeychainCredential } from '../src/channel-credentials.mjs';
import { GeWeChannel } from '../src/im-channel-runtime.mjs';
import { runBufferedProcess } from '../src/process-runner.mjs';
import {
  parseLaunchctlPrint,
  reconcileLaunchAgent,
  waitForServiceCondition,
} from '../src/service-reconciler.mjs';
import { evaluateWechatReliability } from '../src/wechat-reliability-policy.mjs';
import { canaryCredentialAccount } from '../src/wechat-reliability-canary.mjs';
import {
  collectWechatReliabilitySample,
  probeLocalCanary,
  probePublicCanary,
  probeTunnel,
} from '../src/wechat-reliability-probes.mjs';
import { WechatReliabilityStore } from '../src/wechat-reliability-store.mjs';

function boundedInterval(value) {
  const intervalMs = Number(value ?? 15_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 300_000) {
    throw new Error('WeChat reliability interval must be between 10000 and 300000 milliseconds');
  }
  return intervalMs;
}

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error('Reliability supervisor stopped'));
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('Reliability supervisor stopped'));
    }, { once: true });
  });
}

export function createLaunchAgentReconcileOperation({
  uid,
  label,
  expected,
  run = runBufferedProcess,
  verify,
}) {
  const numericUid = Number(uid);
  const safeLabel = String(label || '');
  if (!Number.isInteger(numericUid) || numericUid < 1 || !/^[A-Za-z0-9.-]{3,200}$/.test(safeLabel)) {
    throw new Error('LaunchAgent service domain is invalid');
  }
  if (typeof verify !== 'function') throw new TypeError('LaunchAgent verification is required');
  const domain = `gui/${numericUid}/${safeLabel}`;
  const userDomain = `gui/${numericUid}`;
  const options = {
    timeoutMs: 20_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  };
  return ({ signal } = {}) => reconcileLaunchAgent({
    expected,
    inspect: async () => {
      try {
        const { stdout } = await run('/bin/launchctl', ['print', domain], options);
        return parseLaunchctlPrint(stdout);
      } catch (error) {
        if (error?.code === 'PROCESS_EXIT') return null;
        throw error;
      }
    },
    bootout: () => run('/bin/launchctl', ['bootout', domain], options),
    bootstrap: () => run('/bin/launchctl', ['bootstrap', userDomain, expected.plistPath], options),
    kickstart: () => run('/bin/launchctl', ['kickstart', '-k', domain], options),
    verify: context => verify({ ...context, signal }),
  });
}

export function buildProductionServiceLayout({ currentPath, userHome }) {
  const releasePath = path.resolve(String(currentPath || ''));
  const launchAgentsPath = path.join(String(userHome || ''), 'Library', 'LaunchAgents');
  const create = (label, entrypoint) => {
    const plistPath = path.join(launchAgentsPath, `${label}.plist`);
    return {
      label,
      plistPath,
      expected: {
        plistPath,
        workdir: releasePath,
        entrypoint: path.join(releasePath, entrypoint),
      },
    };
  };
  return {
    main: create('com.local.aipro-main', 'src/index.mjs'),
    tunnel: create('com.local.aipro-cloudflare-tunnel', 'scripts/cloudflare-named-tunnel-supervisor.mjs'),
  };
}

async function call(operation, signal) {
  if (typeof operation !== 'function') throw new Error('Reliability recovery operation is missing');
  return operation({ signal });
}

export class WechatReliabilitySupervisor {
  constructor({
    collectSample,
    store,
    operations,
    now = Date.now,
    random = Math.random,
    intervalMs = 15_000,
    sleep = wait,
  }) {
    if (typeof collectSample !== 'function') throw new TypeError('collectSample is required');
    if (!store || typeof store.load !== 'function' || typeof store.save !== 'function') {
      throw new TypeError('reliability store is required');
    }
    this.collectSample = collectSample;
    this.store = store;
    this.operations = operations || {};
    this.now = now;
    this.random = random;
    this.intervalMs = boundedInterval(intervalMs);
    this.sleep = sleep;
    this.tickInFlight = null;
  }

  async executeRecovery(recovery, { signal } = {}) {
    switch (recovery?.action) {
      case 'reconcile_main_service':
        await call(this.operations.reconcileMain, signal);
        await call(this.operations.waitMainReady, signal);
        break;
      case 'reconcile_tunnel':
      case 'restart_tunnel':
        await call(this.operations.reconcileTunnel, signal);
        await call(this.operations.waitTunnelReady, signal);
        await call(this.operations.alignCallback, signal);
        await call(this.operations.verifyPublicCanary, signal);
        break;
      case 'align_callback':
        await call(this.operations.alignCallback, signal);
        break;
      default:
        break;
    }
  }

  tick({ signal } = {}) {
    if (this.tickInFlight) return this.tickInFlight;
    const operation = this.#tick({ signal }).finally(() => {
      if (this.tickInFlight === operation) this.tickInFlight = null;
    });
    this.tickInFlight = operation;
    return operation;
  }

  async #tick({ signal } = {}) {
    if (signal?.aborted) return null;
    const previous = await this.store.load();
    const sample = await this.collectSample({ signal });
    const checkedAtMs = Number(this.now());
    const evaluated = evaluateWechatReliability({
      previous,
      sample,
      nowMs: checkedAtMs,
      random: this.random,
    });
    await this.store.save(evaluated);
    if (!evaluated.recovery) return evaluated;

    const startedAt = Number(this.now());
    try {
      await this.executeRecovery(evaluated.recovery, { signal });
      const recovering = {
        ...evaluated,
        state: 'recovering',
        lastRecoveryAtMs: Number(this.now()),
        lastRecoveryErrorCode: null,
      };
      await this.store.save(recovering);
      await this.store.appendEvent?.({
        at: new Date(Number(this.now())).toISOString(),
        layer: evaluated.failureLayer,
        action: evaluated.recovery.action,
        elapsedMs: Math.max(0, Number(this.now()) - startedAt),
        result: 'ok',
        errorCode: null,
      });
      return recovering;
    } catch {
      const failed = {
        ...evaluated,
        state: evaluated.state === 'circuit_open' ? 'circuit_open' : 'degraded',
        lastRecoveryAtMs: Number(this.now()),
        lastRecoveryErrorCode: 'recovery_failed',
      };
      await this.store.save(failed);
      await this.store.appendEvent?.({
        at: new Date(Number(this.now())).toISOString(),
        layer: evaluated.failureLayer,
        action: evaluated.recovery.action,
        elapsedMs: Math.max(0, Number(this.now()) - startedAt),
        result: 'failed',
        errorCode: 'recovery_failed',
      });
      return failed;
    }
  }

  async run({ signal } = {}) {
    while (!signal?.aborted) {
      await this.tick({ signal });
      if (signal?.aborted) break;
      try {
        await this.sleep(this.intervalMs, signal);
      } catch {
        if (!signal?.aborted) throw new Error('Reliability supervisor sleep failed');
      }
    }
  }
}

export function createThrottledCallbackAlignment({
  align,
  now = Date.now,
  intervalMs = 5 * 60_000,
}) {
  if (typeof align !== 'function') throw new TypeError('Callback alignment operation is required');
  const boundedMs = Math.max(60_000, Math.min(60 * 60_000, Number(intervalMs) || 5 * 60_000));
  let lastSuccessAtMs = Number.NEGATIVE_INFINITY;
  let inFlight = null;
  return async () => {
    if (Number(now()) - lastSuccessAtMs < boundedMs) return { skipped: true };
    if (inFlight) return inFlight;
    const operation = Promise.resolve()
      .then(() => align())
      .then(result => {
        lastSuccessAtMs = Number(now());
        return result;
      })
      .finally(() => {
        if (inFlight === operation) inFlight = null;
      });
    inFlight = operation;
    return operation;
  };
}

export async function createProductionWechatReliabilitySupervisor({
  configuration,
  home,
  metricsUrl = 'http://127.0.0.1:17657',
  readCredential = readKeychainCredential,
  ChannelClass = GeWeChannel,
  StoreClass = WechatReliabilityStore,
  store,
  collectSampleImpl = collectWechatReliabilitySample,
  operations,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  random = Math.random,
  intervalMs = 15_000,
} = {}) {
  const appId = String(configuration?.geweAppId || '').trim();
  const keychainService = String(configuration?.geweKeychainService || '').trim();
  if (!appId || !keychainService) {
    throw new Error('GeWe app ID and Keychain service are required for reliability supervision');
  }
  const publicUrl = new URL(String(configuration?.gewePublicCallbackBaseUrl || ''));
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password
    || publicUrl.search || publicUrl.hash) {
    throw new Error('GeWe reliability public callback base URL must use HTTPS');
  }
  const callbackPort = Number(configuration?.geweCallbackPort);
  if (!Number.isInteger(callbackPort) || callbackPort < 1_024 || callbackPort > 65_535) {
    throw new Error('GeWe reliability callback port is invalid');
  }
  const [token, callbackSecret, canarySecret] = await Promise.all([
    readCredential({ service: keychainService, account: appId }),
    readCredential({ service: keychainService, account: `${appId}:callback` }),
    readCredential({ service: keychainService, account: canaryCredentialAccount(appId) }),
  ]);
  const channel = new ChannelClass({
    appId,
    token,
    apiBaseUrl: configuration.geweApiBaseUrl,
    fetchImpl,
  });
  const publicBaseUrl = publicUrl.origin;
  const callbackUrl = `${publicBaseUrl}/webhooks/gewe/${callbackSecret}`;
  const forceCallbackAlignment = () => channel.setCallback(callbackUrl);
  const periodicCallbackAlignment = createThrottledCallbackAlignment({
    align: forceCallbackAlignment,
    now,
  });
  const effectiveStore = store || new StoreClass({ home, now });
  const effectiveOperations = typeof operations === 'function'
    ? await operations({
        alignCallback: forceCallbackAlignment,
        callbackPort,
        canarySecret,
        metricsUrl,
        publicBaseUrl,
      })
    : operations;
  return new WechatReliabilitySupervisor({
    collectSample: ({ signal: _signal } = {}) => collectSampleImpl({
      localUrl: `http://127.0.0.1:${callbackPort}`,
      metricsUrl,
      publicBaseUrl,
      canarySecret,
      provider: {
        checkOnline: () => channel.checkOnline(),
        alignCallback: periodicCallbackAlignment,
      },
      fetchImpl,
      now,
    }),
    store: effectiveStore,
    operations: effectiveOperations,
    now,
    random,
    intervalMs,
  });
}

export async function createDefaultProductionSupervisor() {
  const { config: configuration } = await import('../src/config.mjs');
  const userHome = process.env.HOME || '';
  const supportHome = process.env.AIPRO_HOME
    || path.join(userHome, 'Library', 'Application Support', 'AIPRO');
  const currentPath = process.env.AIPRO_CURRENT_PATH
    || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const metricsUrl = process.env.CLOUDFLARED_METRICS_URL || 'http://127.0.0.1:17657';
  const uid = process.getuid();
  const layout = buildProductionServiceLayout({ currentPath, userHome });
  return createProductionWechatReliabilitySupervisor({
    configuration,
    home: supportHome,
    metricsUrl,
    intervalMs: Number(process.env.AIPRO_WECHAT_RELIABILITY_INTERVAL_MS || 15_000),
    operations: async ({
      alignCallback,
      callbackPort,
      canarySecret,
      publicBaseUrl,
    }) => {
      const localHealthy = ({ signal } = {}) => waitForServiceCondition({
        probe: async () => (await probeLocalCanary({
          baseUrl: `http://127.0.0.1:${callbackPort}`,
          canarySecret,
        })).ok,
        timeoutMs: 35_000,
        intervalMs: 1_000,
        signal,
      });
      const tunnelHealthy = ({ signal } = {}) => waitForServiceCondition({
        probe: async () => (await probeTunnel({ metricsUrl })).ok,
        timeoutMs: 35_000,
        intervalMs: 1_000,
        signal,
      });
      const publicHealthy = ({ signal } = {}) => waitForServiceCondition({
        probe: async () => (await probePublicCanary({
          baseUrl: publicBaseUrl,
          canarySecret,
        })).ok,
        timeoutMs: 35_000,
        intervalMs: 1_000,
        signal,
      });
      return {
        reconcileMain: createLaunchAgentReconcileOperation({
          uid,
          label: layout.main.label,
          expected: layout.main.expected,
          verify: localHealthy,
        }),
        waitMainReady: localHealthy,
        reconcileTunnel: createLaunchAgentReconcileOperation({
          uid,
          label: layout.tunnel.label,
          expected: layout.tunnel.expected,
          verify: tunnelHealthy,
        }),
        waitTunnelReady: tunnelHealthy,
        alignCallback,
        verifyPublicCanary: publicHealthy,
      };
    },
  });
}

export async function runSupervisorMain({
  createSupervisor,
  processLike = process,
  logger = console,
}) {
  try {
    const supervisor = await createSupervisor();
    const controller = new AbortController();
    processLike.once?.('SIGTERM', () => controller.abort(new Error('SIGTERM')));
    processLike.once?.('SIGINT', () => controller.abort(new Error('SIGINT')));
    await supervisor.run({ signal: controller.signal });
  } catch {
    logger.error('[wechat-reliability] fatal supervisor error');
    processLike.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSupervisorMain({
    createSupervisor: createDefaultProductionSupervisor,
  });
}
