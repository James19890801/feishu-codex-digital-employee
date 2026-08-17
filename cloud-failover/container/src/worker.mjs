import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudReply, evaluateCloudMessage, messageDigest, normalizeConnectorMessage,
  ownerHandoffReply, stableMessageUuid, validateContainerEnvironment,
} from './policy.mjs';
import { RailwayFailoverRuntime } from './runtime.mjs';

function isConnectorAuthenticated(value) {
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
      else reject(Object.assign(new Error(`connector command failed with code ${code}`), { result }));
    });
    child.stdin.end(input);
  });
}

const MAX_CLOUD_IMAGE_BYTES = 4 * 1024 * 1024;

function imageMime(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (buffer.subarray(0, 6).toString('ascii') === 'GIF87a' || buffer.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw Object.assign(new Error('Downloaded EnterpriseChat image has an unsupported format'), { code: 'unsupported_image' });
}

function startConnectorEventConsumer(bin, args, onMessage, { env = process.env } = {}) {
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
            .then(result => console.log('connector_event_processed', {
              sent: result?.sent === true,
              outcomeCode: String(result?.outcomeCode || ''),
              skipped: String(result?.skipped || ''),
            }))
            .catch(error => console.error('connector_event_processing_failed', {
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
      if (!ready) reject(new Error(`CONNECTOR event consumer exited before ready (${code})`));
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
  vision(input) { return this.call('/internal/runtime/vision', input); }
}

export class StandbyConnectorWorker {
  constructor({
    env, runner = safeProcess, coordinator, now = () => Date.now(), bin = 'connector',
    eventConsumer = startConnectorEventConsumer,
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
    this.connectorHome = String(env.AIPROS_CONNECTOR_HOME || '/data/connector-home');
    this.authBootstrapMarker = join(this.connectorHome, '.aipros-auth-bootstrap-complete');
  }

  commonArgs() {
    const clientId = String(this.env.ENTERPRISE_CHAT_CLIENT_ID || '').trim();
    const clientSecret = String(this.env.ENTERPRISE_CHAT_CLIENT_SECRET || '').trim();
    return clientId && clientSecret
      ? ['--client-id', clientId, '--client-secret', clientSecret]
      : [];
  }

  connectorOptions() {
    return {
      env: {
        ...process.env,
        HOME: this.connectorHome,
        CONNECTOR_CHANNEL: String(this.env.AIPROS_CLOUD_CONNECTOR_CHANNEL).trim(),
      },
    };
  }

  async hasPersistentConnectorState() {
    for (const path of [join(this.connectorHome, '.connector'), join(this.connectorHome, '.local', 'share', 'connector-cli')]) {
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
    ], this.connectorOptions());
    const parsed = JSON.parse(status.stdout);
    if (!isConnectorAuthenticated(parsed)) throw new Error('CONNECTOR auth status is not authenticated');
    return parsed;
  }

  async authenticate() {
    await mkdir(this.connectorHome, { recursive: true, mode: 0o700 });
    if (!await this.hasAuthBootstrapMarker()) {
      if (await this.hasPersistentConnectorState()) {
        await this.readAuthStatus();
      } else {
        const dir = await mkdtemp(join(tmpdir(), 'aipros-connector-auth-'));
        const bundlePath = join(dir, 'auth.b64');
        try {
          await writeFile(bundlePath, this.env.ENTERPRISE_CHAT_CONNECTOR_AUTH_BUNDLE_B64, { mode: 0o600 });
          await chmod(bundlePath, 0o600);
          await this.runner(this.bin, [
            'auth', 'import', '-i', bundlePath, '--base64', '--force', ...this.commonArgs(),
          ], this.connectorOptions());
          await this.readAuthStatus();
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }
      await writeFile(this.authBootstrapMarker, 'connector-1.0.56\n', { mode: 0o600, flag: 'wx' });
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
          'message.mention.received', 'message.direct.received',
          '--flatten', '--ephemeral', '--format', 'ndjson',
          ...this.commonArgs(),
        ], message => this.processMessage(message), this.connectorOptions());
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
    const message = normalizeConnectorMessage(raw);
    const decision = evaluateCloudMessage(message, {
      ...this.policy, generation, expectedGeneration: this.activeGeneration, now: this.now(),
    });
    if (!decision.allowed) return { skipped: decision.reason };
    const digest = messageDigest(message.messageId);
    const claim = await this.coordinator.claim({ generation, messageDigest: digest });
    if (!claim.accepted) return { skipped: 'duplicate' };
    let outcomeCode = 'failed';
    try {
      let prompt = message.text;
      if (message.messageType === 'image') {
        const visionText = await this.describeImage(message, generation);
        prompt = [
          '用户发送了一张图片。以下是云端视觉模型对该图片的受限识别结果：',
          visionText,
          `用户随图文字：${message.text || '未提供'}`,
          '请只根据识别结果自然回复；不要声称看到了识别结果之外的内容。',
        ].join('\n');
      }
      const reply = decision.handoff
        ? ownerHandoffReply()
        : cloudReply((await this.coordinator.qoder({
            generation, level: decision.level, prompt,
            digest: messageDigest(prompt), bytes: Buffer.byteLength(prompt, 'utf8'),
            purpose: 'whole_host_reply',
          })).result.text);
      const sent = await this.runner(this.bin, [
        'chat', 'message', 'send', '--group', message.chatId, '--text', reply,
        '--uuid', stableMessageUuid('enterpriseChat', message.messageId), '--yes', '--format', 'json',
        ...this.commonArgs(),
      ], this.connectorOptions());
      let sendResult = {};
      try { sendResult = JSON.parse(sent.stdout); } catch { sendResult = {}; }
      const sendRoot = sendResult.result || sendResult.data || sendResult;
      const deliveryTaskId = String(sendRoot.deliveryTaskId || sendRoot.delivery_task_id || '').trim();
      if (!deliveryTaskId) throw new Error('CONNECTOR send did not return deliveryTaskId');
      let deliveryStatus = '';
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const status = await this.runner(this.bin, [
          'chat', 'message', 'delivery-status', '--delivery-task-id', deliveryTaskId,
          '--format', 'json', ...this.commonArgs(),
        ], this.connectorOptions());
        let parsed = {};
        try { parsed = JSON.parse(status.stdout); } catch { parsed = {}; }
        const root = parsed.result || parsed.data || parsed;
        deliveryStatus = String(root.deliveryStatus || root.delivery_status || root.status || '').toUpperCase();
        if (deliveryStatus === 'SUCCESS') break;
        if (['FAILED', 'FAIL', 'ERROR'].includes(deliveryStatus)) {
          throw new Error(`CONNECTOR send failed with terminal status ${deliveryStatus}`);
        }
        if (attempt < 4) await this.delay(500 * (attempt + 1));
      }
      if (deliveryStatus !== 'SUCCESS') throw new Error('CONNECTOR send did not reach SUCCESS');
      outcomeCode = decision.handoff ? 'owner_handoff_sent' : 'reply_sent';
      return { sent: true, outcomeCode };
    } finally {
      await this.coordinator.complete({ generation, messageDigest: digest, outcomeCode });
    }
  }

  async describeImage(message, generation) {
    const media = message.media;
    if (!media?.resourceId || !media.messageId || !media.conversationId) {
      throw Object.assign(new Error('EnterpriseChat image metadata is incomplete'), { code: 'image_metadata_missing' });
    }
    const dir = await mkdtemp(join(tmpdir(), 'aipros-cloud-image-'));
    const outputPath = join(dir, 'image');
    try {
      await this.runner(this.bin, [
        'chat', 'message', 'download-media', '--type', 'mediaId',
        '--resource-id', media.resourceId,
        '--message-id', media.messageId,
        '--open-conversation-id', media.conversationId,
        '--output', outputPath, '--yes', '--format', 'json',
        ...this.commonArgs(),
      ], { ...this.connectorOptions(), timeoutMs: 60_000 });
      const info = await lstat(outputPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_CLOUD_IMAGE_BYTES) {
        throw Object.assign(new Error('Downloaded EnterpriseChat image failed file validation'), { code: 'invalid_image_file' });
      }
      const bytes = await readFile(outputPath);
      const mime = imageMime(bytes);
      const result = await this.coordinator.vision({
        generation,
        image: `data:${mime};base64,${bytes.toString('base64')}`,
        digest: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.byteLength,
      });
      const text = String(result.text || '').trim();
      if (!text) throw Object.assign(new Error('Cloud vision returned an empty result'), { code: 'vision_empty' });
      return text.slice(0, 8_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async backfill(generation) {
    const end = new Date(this.now()).toISOString();
    const start = new Date(this.now() - 3 * 60_000).toISOString();
    const result = await this.runner(this.bin, [
      'chat', 'message', 'list-mentions',
      '--start', start, '--end', end, '--limit', '100', '--cursor', '0',
      '--format', 'json', ...this.commonArgs(),
    ], this.connectorOptions());
    let parsed = {};
    try { parsed = JSON.parse(result.stdout); } catch { parsed = {}; }
    const root = parsed.result || parsed.data || parsed;
    if (root.hasMore === true) throw new Error('CONNECTOR mention backfill exceeded one page');
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
  const worker = new StandbyConnectorWorker({ env: process.env, coordinator });
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
