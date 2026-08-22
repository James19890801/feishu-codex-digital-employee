import assert from 'node:assert/strict';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import {
  buildProductionServiceLayout,
  createLaunchAgentReconcileOperation,
  createThrottledCallbackAlignment,
  createProductionWechatReliabilitySupervisor,
  WechatReliabilitySupervisor,
  runSupervisorMain,
} from './wechat-reliability-supervisor.mjs';
import { emptyWechatReliabilityState } from '../src/wechat-reliability-policy.mjs';

const layerNames = [
  'local_service',
  'tunnel',
  'public_callback',
  'provider',
  'callback_registration',
];

function sample(failedLayer = null, errorCode = 'unavailable') {
  return {
    layers: Object.fromEntries(layerNames.map(name => [name, {
      ok: name !== failedLayer,
      errorCode: name === failedLayer ? errorCode : null,
      durationMs: 1,
    }])),
  };
}

function fakeStore(initial = emptyWechatReliabilityState()) {
  return {
    state: structuredClone(initial),
    saved: [],
    events: [],
    async load() { return structuredClone(this.state); },
    async save(state) {
      this.state = structuredClone(state);
      this.saved.push(structuredClone(state));
    },
    async appendEvent(event) { this.events.push(structuredClone(event)); },
  };
}

function operations(calls, overrides = {}) {
  return {
    reconcileMain: async () => { calls.push('reconcile_main_service'); },
    waitMainReady: async () => { calls.push('wait_main_ready'); },
    reconcileTunnel: async () => { calls.push('reconcile_tunnel'); },
    waitTunnelReady: async () => { calls.push('wait_tunnel_ready'); },
    alignCallback: async () => { calls.push('align_callback'); },
    verifyPublicCanary: async () => { calls.push('verify_public_canary'); },
    ...overrides,
  };
}

{
  let nowMs = 1_000;
  let calls = 0;
  const align = createThrottledCallbackAlignment({
    align: async () => { calls += 1; },
    now: () => nowMs,
    intervalMs: 300_000,
  });
  await align();
  await align();
  assert.equal(calls, 1);
  nowMs += 300_001;
  await align();
  assert.equal(calls, 2);
}

async function runFailure(failedLayer, { store = fakeStore(), operationOverrides } = {}) {
  const calls = [];
  let nowMs = 1_000;
  const supervisor = new WechatReliabilitySupervisor({
    collectSample: async () => sample(failedLayer),
    store,
    operations: operations(calls, operationOverrides),
    now: () => nowMs,
    random: () => 0,
  });
  for (let index = 0; index < 3; index += 1) {
    await supervisor.tick();
    nowMs += 1_000;
  }
  return { calls, store, supervisor };
}

{
  const { calls } = await runFailure('tunnel');
  assert.deepEqual(calls, [
    'reconcile_tunnel',
    'wait_tunnel_ready',
    'align_callback',
    'verify_public_canary',
  ]);
  assert.equal(calls.includes('reconcile_main_service'), false);
}

{
  const { calls } = await runFailure('public_callback');
  assert.deepEqual(calls, [
    'reconcile_tunnel',
    'wait_tunnel_ready',
    'align_callback',
    'verify_public_canary',
  ]);
}

{
  const { calls } = await runFailure('local_service');
  assert.deepEqual(calls, ['reconcile_main_service', 'wait_main_ready']);
}

{
  const provider = await runFailure('provider');
  assert.deepEqual(provider.calls, []);
  assert.equal(provider.store.state.state, 'provider_down');

  const callback = await runFailure('callback_registration');
  assert.deepEqual(callback.calls, ['align_callback']);
}

{
  const calls = [];
  let releases;
  const store = fakeStore();
  const supervisor = new WechatReliabilitySupervisor({
    collectSample: async () => sample('tunnel'),
    store,
    operations: operations(calls, {
      reconcileTunnel: async () => {
        calls.push('reconcile_tunnel');
        await new Promise(resolve => { releases = resolve; });
      },
    }),
    now: () => 3_000,
    random: () => 0,
  });
  store.state = {
    ...emptyWechatReliabilityState(),
    layers: Object.fromEntries(layerNames.map(name => [name, {
      ok: name !== 'tunnel',
      lastSuccessAtMs: null,
      lastFailureAtMs: 2_000,
      durationMs: 1,
      consecutiveSuccesses: name === 'tunnel' ? 0 : 2,
      consecutiveFailures: name === 'tunnel' ? 2 : 0,
      errorCode: name === 'tunnel' ? 'unavailable' : null,
    }])),
  };
  const first = supervisor.tick();
  const second = supervisor.tick();
  await waitImmediate();
  assert.deepEqual(calls, ['reconcile_tunnel']);
  releases();
  await Promise.all([first, second]);
  assert.equal(calls.filter(value => value === 'reconcile_tunnel').length, 1);
}

{
  const circuit = emptyWechatReliabilityState();
  circuit.state = 'circuit_open';
  circuit.circuitOpenUntilMs = 100_000;
  circuit.layers.tunnel.consecutiveFailures = 3;
  const store = fakeStore(circuit);
  const calls = [];
  let probes = 0;
  const supervisor = new WechatReliabilitySupervisor({
    collectSample: async () => { probes += 1; return sample('tunnel'); },
    store,
    operations: operations(calls),
    now: () => 10_000,
    random: () => 0,
  });
  await supervisor.tick();
  assert.equal(probes, 1);
  assert.deepEqual(calls, []);
  assert.equal(store.state.state, 'circuit_open');
}

{
  const failure = await runFailure('tunnel', {
    operationOverrides: {
      reconcileTunnel: async () => { throw new Error('launchctl leaked private detail'); },
    },
  });
  assert.equal(failure.store.events.at(-1).result, 'failed');
  assert.equal(JSON.stringify(failure.store.events).includes('private detail'), false);
  assert.equal(failure.store.state.lastRecoveryErrorCode, 'recovery_failed');
}

{
  const controller = new AbortController();
  let receivedSignal;
  const store = fakeStore();
  store.state.layers.tunnel.consecutiveFailures = 2;
  const supervisor = new WechatReliabilitySupervisor({
    collectSample: async () => sample('tunnel'),
    store,
    operations: operations([], {
      reconcileTunnel: async ({ signal }) => {
        receivedSignal = signal;
        await new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    }),
    now: () => 3_000,
    random: () => 0,
  });
  const pending = supervisor.tick({ signal: controller.signal });
  await waitImmediate();
  controller.abort(new Error('stop requested'));
  await pending;
  assert.equal(receivedSignal.aborted, true);
}

{
  const processLike = { exitCode: 0 };
  const logs = [];
  await runSupervisorMain({
    createSupervisor: async () => ({ run: async () => { throw new Error('fatal secret detail'); } }),
    processLike,
    logger: { error: text => logs.push(String(text)) },
  });
  assert.equal(processLike.exitCode, 1);
  assert.equal(logs.join('').includes('secret detail'), false);
}

{
  const credentialReads = [];
  const channelCalls = [];
  const collectCalls = [];
  class FakeChannel {
    constructor(options) {
      assert.equal(options.token, 'provider-token-from-keychain');
    }
    async checkOnline() { channelCalls.push('check_online'); return true; }
    async setCallback(url) { channelCalls.push(['set_callback', url]); }
  }
  const store = fakeStore();
  const supervisor = await createProductionWechatReliabilitySupervisor({
    configuration: {
      geweAppId: 'device-a',
      geweKeychainService: 'aipro-gewe',
      geweApiBaseUrl: 'https://api.geweapi.com',
      gewePublicCallbackBaseUrl: 'https://wechat.example.com',
      geweCallbackPort: 17656,
    },
    home: '/tmp/aipro-production-test',
    metricsUrl: 'http://127.0.0.1:17657',
    readCredential: async target => {
      credentialReads.push(target);
      if (target.account === 'device-a') return 'provider-token-from-keychain';
      if (target.account === 'device-a:callback') return 'callback_secret_1234567890123456';
      if (target.account === 'device-a:canary') return 'canary_secret_12345678901234567890';
      throw new Error('unexpected credential');
    },
    ChannelClass: FakeChannel,
    store,
    collectSampleImpl: async options => {
      collectCalls.push(options);
      assert.equal(await options.provider.checkOnline(), true);
      await options.provider.alignCallback();
      return sample();
    },
    operations: operations([]),
    now: () => Date.parse('2026-08-22T12:00:00.000Z'),
    random: () => 0,
  });
  await supervisor.tick();
  assert.deepEqual(credentialReads.map(target => target.account), [
    'device-a',
    'device-a:callback',
    'device-a:canary',
  ]);
  assert.equal(collectCalls[0].localUrl, 'http://127.0.0.1:17656');
  assert.equal(collectCalls[0].publicBaseUrl, 'https://wechat.example.com');
  assert.deepEqual(channelCalls, [
    'check_online',
    ['set_callback', 'https://wechat.example.com/webhooks/gewe/callback_secret_1234567890123456'],
  ]);
  assert.equal(JSON.stringify(collectCalls).includes('provider-token-from-keychain'), false);
}

{
  const calls = [];
  let verified = 0;
  const reconcile = createLaunchAgentReconcileOperation({
    uid: 501,
    label: 'com.local.aipro.tunnel',
    expected: {
      plistPath: '/Users/operator/Library/LaunchAgents/com.local.aipro.tunnel.plist',
      workdir: '/Applications/AIPRO/current',
      entrypoint: '/Applications/AIPRO/current/scripts/cloudflare-named-tunnel-supervisor.mjs',
    },
    run: async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === 'print') {
        return { stdout: `gui/501/com.local.aipro.tunnel = {
          path = /Users/operator/Library/LaunchAgents/com.local.aipro.tunnel.plist
          arguments = {
            /usr/local/bin/node
            /Applications/AIPRO/current/scripts/cloudflare-named-tunnel-supervisor.mjs
          }
          working directory = /Applications/AIPRO/current
          pid = 4321
        }` };
      }
      return { stdout: '' };
    },
    verify: async () => { verified += 1; },
  });
  const result = await reconcile();
  assert.equal(result.action, 'kickstart');
  assert.deepEqual(calls.map(call => call.slice(0, 4)), [
    ['/bin/launchctl', 'print', 'gui/501/com.local.aipro.tunnel'],
    ['/bin/launchctl', 'kickstart', '-k', 'gui/501/com.local.aipro.tunnel'],
  ]);
  assert.equal(verified, 1);
}

{
  const layout = buildProductionServiceLayout({
    currentPath: '/Users/operator/Library/Application Support/AIPRO/current',
    userHome: '/Users/operator',
  });
  assert.equal(layout.main.expected.workdir, '/Users/operator/Library/Application Support/AIPRO/current');
  assert.equal(layout.main.expected.entrypoint.endsWith('/src/index.mjs'), true);
  assert.equal(layout.tunnel.expected.entrypoint.endsWith('/scripts/cloudflare-named-tunnel-supervisor.mjs'), true);
  assert.equal(layout.main.expected.entrypoint.includes('.worktrees'), false);
  assert.equal(layout.main.plistPath.endsWith('/com.local.aipro-main.plist'), true);
  assert.equal(layout.tunnel.plistPath.endsWith('/com.local.aipro-cloudflare-tunnel.plist'), true);
}

console.log('WECHAT_RELIABILITY_SUPERVISOR_TEST_OK');
