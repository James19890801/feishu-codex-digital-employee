import { spawn } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudReply, evaluateCloudMessage, messageDigest, normalizeDwsMessage,
  ownerHandoffReply, stableMessageUuid, validateContainerEnvironment,
} from './policy.mjs';
import { RailwayFailoverRuntime } from './runtime.mjs';

function isDwsAuthenticated(value) {
  const candidate = value?.data || value;
  return candidate?.authenticated === true
    || candidate?.loggedIn === true
    || candidate?.isLoggedIn === true
    || ['authenticated', 'logged_in', '已登录'].includes(String(candidate?.status || ''));
}

function safeProcess(bin, args, { input = '', timeoutMs = 30_000, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', code => {
      clearTimeout(timer);
      const result = { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
      if (code === 0) resolve(result);
      else reject(Object.assign(new Error(`dws command failed with code ${code}`), { result }));
    });
    child.stdin.end(input);
  });
}

function startDwsEventConsumer(bin, args, onMessage, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let ready = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        try {
          Promise.resolve(onMessage(JSON.parse(line)))
            .then(result => console.log('dws_event_processed', {
              sent: result?.sent === true,
              outcomeCode: String(result?.outcomeCode || ''),
              skipped: String(result?.skipped || ''),
            }))
            .catch(error => console.error('dws_event_processing_failed', {
              code: String(error?.code || error?.name || 'event_error').slice(0, 64),
              message: String(error?.message || error).slice(0, 160),
            }));
        } catch { /* ignore malformed metadata */ }
      }
    });
    child.stderr.on('data', chunk => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-2_000);
      if (!ready && /\[event\] ready/.test(stderrBuffer)) {
        ready = true;
        resolve(child);
      }
    });
    child.once('error', reject);
    child.once('exit', code => {
      if (!ready) reject(new Error(`DWS event consumer exited before ready (${code})`));
    });
  });
}

export class CoordinatorClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async call(path, body = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) {
      const code = String(result.error?.code || 'coordinator_failed').slice(0, 64);
      throw Object.assign(new Error(code), { code });
    }
    return result;
  }

  lease() { return this.call('/internal/runtime/lease'); }
  ready(generation) { return this.call('/internal/runtime/ready', { generation }); }
  claim(input) { return this.call('/internal/runtime/claim', input); }
  complete(input) { return this.call('/internal/runtime/complete', input); }
  qoder(input) { return this.call('/internal/runtime/qoder', input); }
}

export class StandbyDwsWorker {
  constructor({
    env, runner = safeProcess, coordinator, now = () => Date.now(), bin = 'dws',
    eventConsumer = startDwsEventConsumer,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    this.env = env;
    this.policy = validateContainerEnvironment(env);
    this.runner = runner;
    this.coordinator = coordinator;
    this.now = now;
    this.bin = bin;
    this.eventConsumer = eventConsumer;
    this.delay = delay;
    this.generation = 0;
    this.activeGeneration = 0;
    this.backfilledGeneration = 0;
    this.authenticated = false;
    this.eventChild = null;
    this.initializationPromise = null;
    this.dwsHome = String(env.AIPROS_DWS_HOME || '/data/dws-home');
    this.authBootstrapMarker = join(this.dwsHome, '.aipros-auth-bootstrap-complete');
  }

  commonArgs() {
    const clientId = String(this.env.DINGTALK_CLIENT_ID || '').trim();
    const clientSecret = String(this.env.DINGTALK_CLIENT_SECRET || '').trim();
    return clientId && clientSecret
      ? ['--client-id', clientId, '--client-secret', clientSecret]
      : [];
  }

  dwsOptions() {
    return {
      env: {
        ...process.env,
        HOME: this.dwsHome,
        DWS_CHANNEL: String(this.env.AIPROS_CLOUD_DWS_CHANNEL).trim(),
      },
    };
  }

  async hasPersistentDwsState() {
    for (const path of [join(this.dwsHome, '.dws'), join(this.dwsHome, '.local', 'share', 'dws-cli')]) {
      try { await access(path); return true; } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return false;
  }

  async hasAuthBootstrapMarker() {
    try {
      await access(this.authBootstrapMarker);
      return true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return false;
    }
  }

  async readAuthStatus() {
    const status = await this.runner(this.bin, [
      'auth', 'status', '--format', 'json', ...this.commonArgs(),
    ], this.dwsOptions());
    const parsed = JSON.parse(status.stdout);
    if (!isDwsAuthenticated(parsed)) throw new Error('DWS auth status is not authenticated');
    return parsed;
  }

  async authenticate() {
    await mkdir(this.dwsHome, { recursive: true, mode: 0o700 });
    if (!await this.hasAuthBootstrapMarker()) {
      if (await this.hasPersistentDwsState()) {
        await this.readAuthStatus();
      } else {
        const dir = await mkdtemp(join(tmpdir(), 'aipros-dws-auth-'));
        const bundlePath = join(dir, 'auth.b64');
        try {
          await writeFile(bundlePath, this.env.DINGTALK_DWS_AUTH_BUNDLE_B64, { mode: 0o600 });
          await chmod(bundlePath, 0o600);
          await this.runner(this.bin, [
            'auth', 'import', '-i', bundlePath, '--base64', '--force', ...this.commonArgs(),
          ], this.dwsOptions());
          await this.readAuthStatus();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      await writeFile(this.authBootstrapMarker, 'dws-1.0.56\n', { mode: 0o600, flag: 'wx' });
    } else {
      await this.readAuthStatus();
    }
    this.authenticated = true;
  }

  async initialize() {
    if (this.authenticated && this.eventChild) return { authenticated: true };
    if (this.initializationPromise) return this.initializationPromise;
    this.initializationPromise = (async () => {
      if (!this.authenticated) await this.authenticate();
      if (!this.eventChild) {
        const child = await this.eventConsumer(this.bin, [
          'event', 'consume',
          'user_im_message_receive_at', 'user_im_message_receive_o2o_all',
          '--flatten', '--ephemeral', '--format', 'ndjson',
          ...this.commonArgs(),
        ], message => this.processMessage(message), this.dwsOptions());
        this.eventChild = child;
        child?.once?.('exit', () => {
          if (this.eventChild === child) this.eventChild = null;
          this.authenticated = false;
          this.activeGeneration = 0;
          this.backfilledGeneration = 0;
        });
      }
      return { authenticated: true };
    })();
    try {
      return await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
  }

  async processMessage(raw) {
    const generation = this.activeGeneration;
    if (!generation) return { skipped: 'standby' };
    const message = normalizeDwsMessage(raw);
    const decision = evaluateCloudMessage(message, {
      ...this.policy, generation, expectedGeneration: this.activeGeneration, now: this.now(),
    });
    if (!decision.allowed) return { skipped: decision.reason };
    const digest = messageDigest(message.messageId);
    const claim = await this.coordinator.claim({ generation, messageDigest: digest });
    if (!claim.accepted) return { skipped: 'duplicate' };
    let outcomeCode = 'failed';
    try {
      const reply = decision.handoff
        ? ownerHandoffReply()
        : cloudReply((await this.coordinator.qoder({
            generation, level: decision.level, prompt: message.text,
            digest: messageDigest(message.text), bytes: Buffer.byteLength(message.text, 'utf8'),
            purpose: 'whole_host_reply',
          })).result.text);
      const sent = await this.runner(this.bin, [
        'chat', 'message', 'send', '--group', message.chatId, '--text', reply,
        '--uuid', stableMessageUuid('dingtalk', message.messageId), '--yes', '--format', 'json',
        ...this.commonArgs(),
      ], this.dwsOptions());
      let sendResult = {};
      try { sendResult = JSON.parse(sent.stdout); } catch { sendResult = {}; }
      const sendRoot = sendResult.result || sendResult.data || sendResult;
      const openTaskId = String(sendRoot.openTaskId || sendRoot.open_task_id || '').trim();
      if (!openTaskId) throw new Error('DWS send did not return openTaskId');
      let sendStatus = '';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const status = await this.runner(this.bin, [
          'chat', 'message', 'query-send-status', '--open-task-id', openTaskId,
          '--format', 'json', ...this.commonArgs(),
        ], this.dwsOptions());
        let parsed = {};
        try { parsed = JSON.parse(status.stdout); } catch { parsed = {}; }
        const root = parsed.result || parsed.data || parsed;
        sendStatus = String(root.sendStatus || root.send_status || root.status || '').toUpperCase();
        if (sendStatus === 'SUCCESS') break;
        if (['FAILED', 'FAIL', 'ERROR'].includes(sendStatus)) {
          throw new Error(`DWS send failed with terminal status ${sendStatus}`);
        }
        if (attempt < 4) await this.delay(500 * (attempt + 1));
      }
      if (sendStatus !== 'SUCCESS') throw new Error('DWS send did not reach SUCCESS');
      outcomeCode = decision.handoff ? 'owner_handoff_sent' : 'reply_sent';
      return { sent: true, outcomeCode };
    } finally {
      await this.coordinator.complete({ generation, messageDigest: digest, outcomeCode });
    }
  }

  async backfill(generation) {
    const end = new Date(this.now()).toISOString();
    const start = new Date(this.now() - 3 * 60_000).toISOString();
    const result = await this.runner(this.bin, [
      'chat', 'message', 'list-mentions',
      '--start', start, '--end', end, '--limit', '100', '--cursor', '0',
      '--format', 'json', ...this.commonArgs(),
    ], this.dwsOptions());
    let parsed = {};
    try { parsed = JSON.parse(result.stdout); } catch { parsed = {}; }
    const root = parsed.result || parsed.data || parsed;
    if (root.hasMore === true) throw new Error('DWS mention backfill exceeded one page');
    const conversations = Array.isArray(root.conversationMessagesList) ? root.conversationMessagesList : [];
    const items = conversations.flatMap(conversation => (
      Array.isArray(conversation.messages)
        ? conversation.messages.map(message => ({ ...message, openConversationId: conversation.openConversationId }))
        : []
    ));
    for (const message of items) await this.processMessage(message);
    this.backfilledGeneration = generation;
  }

  async activate(generation, { announceReady = true } = {}) {
    const nextGeneration = Number(generation);
    if (!Number.isInteger(nextGeneration) || nextGeneration <= 0) throw new Error('Invalid generation');
    await this.initialize();
    if (this.activeGeneration !== nextGeneration) {
      if (announceReady) await this.coordinator.ready(nextGeneration);
      this.generation = nextGeneration;
      this.activeGeneration = nextGeneration;
    }
    if (this.backfilledGeneration !== nextGeneration) await this.backfill(nextGeneration);
    return { ready: true, generation: nextGeneration };
  }

  deactivate() {
    this.activeGeneration = 0;
    return { active: false };
  }

  async bootstrap(generation) {
    return this.activate(generation);
  }
}

export function createHealthServer(worker, port = 8788) {
  return createServer((request, response) => {
    if (request.url === '/live') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === '/ready') {
      response.writeHead(worker.authenticated ? 200 : 503, {
        'content-type': 'application/json', 'cache-control': 'no-store',
      });
      response.end(JSON.stringify({ ok: worker.authenticated, active: worker.activeGeneration > 0 }));
      return;
    }
    response.writeHead(404, { 'cache-control': 'no-store' });
    response.end();
  }).listen(port, '0.0.0.0');
}

async function runStandalone() {
  const coordinator = new CoordinatorClient({
    baseUrl: process.env.AIPROS_COORDINATOR_URL,
    token: process.env.AIPROS_CONTAINER_TOKEN,
  });
  const worker = new StandbyDwsWorker({ env: process.env, coordinator });
  const runtime = new RailwayFailoverRuntime({ worker, coordinator });
  const abortController = new AbortController();
  const server = createHealthServer(worker, Number(process.env.PORT || 8788));
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    abortController.abort();
    worker.deactivate();
    server.close(() => { process.exitCode = 0; });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  await runtime.start({ signal: abortController.signal });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runStandalone().catch(error => {
    console.error('railway_failover_start_failed', {
      code: String(error?.code || error?.name || 'startup_error').slice(0, 64),
      message: String(error?.message || error).slice(0, 160),
    });
    process.exitCode = 1;
  });
}
