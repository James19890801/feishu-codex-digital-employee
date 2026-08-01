import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AiRuntimeClient, discoverAiRuntimes, selectAiRuntime } from '../ai-runtime.mjs';
import { acquireSingletonLock } from '../singleton-lock.mjs';
import { WeChatPocBridge } from './bridge-core.mjs';
import { WeChatPocControlStore } from './control-store.mjs';
import { MacOsWeChatUiAdapter } from './macos-ui-adapter.mjs';
import { WeChatPocResponder } from './responder.mjs';
import { WeChatPocState } from './state.mjs';

async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx',
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export class WeChatPocWorker {
  constructor({
    bridge,
    controlStore,
    state,
    statusPath,
    now = () => new Date().toISOString(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  }) {
    if (!bridge || !controlStore || !state || !statusPath) {
      throw new Error('WeChat POC worker dependencies are required');
    }
    this.bridge = bridge;
    this.controlStore = controlStore;
    this.channelState = state;
    this.statusPath = statusPath;
    this.now = now;
    this.sleep = sleep;
    this.runningTick = null;
    this.stopping = false;
    this.startedAt = '';
    this.lastTickAt = '';
    this.lastError = null;
    this.lastAction = 'worker_created';
    this.clientRunning = false;
    this.permissionState = 'unknown';
    this.lastReceiveAt = '';
    this.lastReplyAt = '';
  }

  async snapshot() {
    const control = await this.controlStore.read();
    return {
      version: 1,
      pid: process.pid,
      processAlive: !this.stopping,
      state: control.enabled ? (this.lastError ? 'degraded' : 'online') : 'disabled',
      control,
      queue: this.channelState.statusCounts(),
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      lastAction: this.lastAction,
      clientRunning: this.clientRunning,
      permissionState: this.permissionState,
      lastReceiveAt: this.lastReceiveAt,
      lastReplyAt: this.lastReplyAt,
      updatedAt: this.now(),
    };
  }

  async writeStatus() {
    const snapshot = await this.snapshot();
    await atomicJson(this.statusPath, snapshot);
    return snapshot;
  }

  async initialize() {
    const control = await this.bridge.initialize();
    this.startedAt = this.now();
    this.lastAction = 'worker_start';
    this.lastError = null;
    await this.writeStatus();
    return control;
  }

  async performTick() {
    try {
      const result = await this.bridge.tick();
      this.lastTickAt = this.now();
      if (result?.probe) {
        this.clientRunning = result.probe.clientRunning === true;
        this.permissionState = result.probe.permissionGranted === true
          ? 'granted'
          : result.probe.permissionGranted === false ? 'missing' : 'unknown';
      }
      if (Number(result?.accepted || 0) > 0) this.lastReceiveAt = this.lastTickAt;
      if (result?.results?.some?.(item => item?.status === 'completed')) this.lastReplyAt = this.lastTickAt;
      this.lastAction = result?.disabled
        ? 'switch_disabled'
        : result?.degraded || result?.error ? 'tick_degraded' : 'tick_completed';
      this.lastError = result?.degraded || result?.error
        ? { at: this.lastTickAt, error: String(result.degraded || result.error).slice(0, 500) }
        : null;
      await this.writeStatus();
      return {
        scanned: Number(result?.scanned || 0),
        accepted: Number(result?.accepted || 0),
        resultCount: Array.isArray(result?.results) ? result.results.length : 0,
      };
    } catch (error) {
      this.lastTickAt = this.now();
      this.lastAction = 'tick_failed';
      this.lastError = { at: this.lastTickAt, error: String(error?.message || error).slice(0, 500) };
      await this.writeStatus();
      return { error: this.lastError.error };
    }
  }

  runOnce() {
    if (this.runningTick) return Promise.resolve({ skipped: 'tick_in_progress' });
    this.runningTick = this.performTick().finally(() => {
      this.runningTick = null;
    });
    return this.runningTick;
  }

  async run() {
    await this.initialize();
    while (!this.stopping) {
      await this.runOnce();
      const control = await this.controlStore.read();
      await this.sleep(control.enabled ? 1_000 : 3_000);
    }
  }

  async shutdown(reason = 'worker_stop') {
    if (this.stopping) return;
    this.stopping = true;
    if (this.runningTick) await this.runningTick.catch(() => {});
    await this.bridge.stop(reason);
    this.lastAction = reason;
    this.lastError = null;
    await this.writeStatus();
  }
}

async function createDefaultWorker() {
  const { config } = await import('../config.mjs');
  const dataDirectory = join(config.workdir, 'data', 'wechat-poc');
  const runtimeDirectory = join(dataDirectory, 'codex-runtime');
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  const [personaText, bibleText] = await Promise.all([
    readFile(join(config.workdir, 'PERSONA.md'), 'utf8'),
    readFile(join(config.workdir, 'BIBLE.md'), 'utf8'),
  ]);
  const runtimes = discoverAiRuntimes({ configuredCodexBin: config.codexBin });
  const runtime = selectAiRuntime(runtimes, config.aiRuntime);
  const runtimeClient = new AiRuntimeClient({ runtime, env: process.env });
  const controlStore = new WeChatPocControlStore({ directory: dataDirectory });
  const state = new WeChatPocState(join(dataDirectory, 'state.sqlite'));
  const ui = new MacOsWeChatUiAdapter({
    scriptPath: join(config.workdir, 'scripts', 'wechat-poc-ui.jxa'),
  });
  const responder = new WeChatPocResponder({
    runtimeClient,
    state,
    personaText,
    bibleText,
    cwd: runtimeDirectory,
    model: runtime.id === 'codex' ? config.codexModel : '',
    timeoutMs: config.codexTimeoutMs,
  });
  const bridge = new WeChatPocBridge({ controlStore, state, ui, responder });
  return {
    worker: new WeChatPocWorker({
      bridge,
      controlStore,
      state,
      statusPath: join(dataDirectory, 'status.json'),
    }),
    state,
    lockPath: join(dataDirectory, 'worker.lock'),
  };
}

async function main() {
  const { worker, state, lockPath } = await createDefaultWorker();
  const lock = await acquireSingletonLock(lockPath);
  const stop = signal => worker.shutdown(signal).catch(error => {
    console.error('[wechat-poc-shutdown-error]', error);
  });
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  try {
    await worker.run();
  } finally {
    state.close();
    await lock.release();
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invokedPath === import.meta.url) {
  main().catch(error => {
    console.error('[wechat-poc-fatal]', error);
    process.exitCode = 1;
  });
}
