import { spawn } from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudReply, evaluateCloudMessage, messageDigest, normalizeDwsMessage,
  ownerHandoffReply, stableMessageUuid, validateContainerEnvironment,
} from './policy.mjs';

function isDwsAuthenticated(value) {
  const candidate = value?.data || value;
  return candidate?.authenticated === true
    || candidate?.loggedIn === true
    || candidate?.isLoggedIn === true
    || ['authenticated', 'logged_in', '已登录'].includes(String(candidate?.status || ''));
}

function safeProcess(bin, args, { input = '', timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
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

function startDwsEventConsumer(bin, args, onMessage) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
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
        try { onMessage(JSON.parse(line)).catch(() => {}); } catch { /* ignore malformed metadata */ }
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
    this.baseUrl = baseUrl.replace(/\/$/, ''); this.token = token; this.fetchImpl = fetchImpl;
  }
  async call(path, body) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST', body: JSON.stringify(body),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
    });
    const result = await response.json();
    if (!response.ok || result.ok !== true) throw new Error(result.error?.code || 'coordinator_failed');
    return result;
  }
  ready(generation) { return this.call('/internal/container/ready', { generation }); }
  claim(input) { return this.call('/internal/container/claim', input); }
  complete(input) { return this.call('/internal/container/complete', input); }
  qoder(input) { return this.call('/internal/container/qoder', input); }
}

export class StandbyDwsWorker {
  constructor({
    env, runner = safeProcess, coordinator, now = () => Date.now(), bin = 'dws',
    eventConsumer = startDwsEventConsumer,
  } = {}) {
    this.env = env;
    this.policy = validateContainerEnvironment(env);
    this.runner = runner;
    this.coordinator = coordinator;
    this.now = now;
    this.bin = bin;
    this.eventConsumer = eventConsumer;
    this.generation = Number(env.AIPROS_GENERATION || 0);
    this.authenticated = false;
  }

  commonArgs() {
    return ['--client-id', this.env.DINGTALK_CLIENT_ID, '--client-secret', this.env.DINGTALK_CLIENT_SECRET];
  }

  async authenticate() {
    const dir = await mkdtemp(join(tmpdir(), 'aipros-dws-auth-'));
    const bundlePath = join(dir, 'auth.b64');
    try {
      await writeFile(bundlePath, this.env.DINGTALK_DWS_AUTH_BUNDLE_B64, { mode: 0o600 });
      await chmod(bundlePath, 0o600);
      await this.runner(this.bin, ['auth', 'import', '-i', bundlePath, '--base64', '--force', ...this.commonArgs()]);
      const status = await this.runner(this.bin, ['auth', 'status', '--format', 'json', ...this.commonArgs()]);
      const parsed = JSON.parse(status.stdout);
      if (!isDwsAuthenticated(parsed)) {
        throw new Error('DWS auth status is not authenticated');
      }
      this.authenticated = true;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async processMessage(raw) {
    const message = normalizeDwsMessage(raw);
    const decision = evaluateCloudMessage(message, {
      ...this.policy, generation: this.generation, expectedGeneration: this.generation, now: this.now(),
    });
    if (!decision.allowed) return { skipped: decision.reason };
    const digest = messageDigest(message.messageId);
    const claim = await this.coordinator.claim({ generation: this.generation, messageDigest: digest });
    if (!claim.accepted) return { skipped: 'duplicate' };
    let outcomeCode = 'failed';
    try {
      const reply = decision.handoff
        ? ownerHandoffReply()
        : cloudReply((await this.coordinator.qoder({
            generation: this.generation, level: decision.level, prompt: message.text,
            digest: messageDigest(message.text), bytes: Buffer.byteLength(message.text, 'utf8'),
            purpose: 'whole_host_reply',
          })).result.text);
      await this.runner(this.bin, [
        'chat', 'message', 'send', '--group', message.chatId, '--text', reply,
        '--uuid', stableMessageUuid('dingtalk', message.messageId), '--yes', ...this.commonArgs(),
      ]);
      outcomeCode = decision.handoff ? 'owner_handoff_sent' : 'reply_sent';
      return { sent: true, outcomeCode };
    } finally {
      await this.coordinator.complete({ generation: this.generation, messageDigest: digest, outcomeCode });
    }
  }

  async bootstrap(generation) {
    this.generation = Number(generation);
    if (!this.authenticated) await this.authenticate();
    this.eventChild = await this.eventConsumer(this.bin, [
      'event', 'consume', '--flatten', '--ephemeral', '--format', 'ndjson',
      ...this.commonArgs(),
    ], message => this.processMessage(message));
    this.eventChild?.once?.('exit', () => { this.authenticated = false; });
    await this.coordinator.ready(this.generation);
    const cutoff = new Date(this.now() - 3 * 60_000).toISOString().replace('T', ' ').slice(0, 19);
    for (const chatId of this.policy.allowedChatIds) {
      const result = await this.runner(this.bin, [
        'chat', 'message', 'list', '--group', chatId, '--time', cutoff,
        '--direction', 'newer', '--limit', '100', '--format', 'json', ...this.commonArgs(),
      ]);
      let parsed = {};
      try { parsed = JSON.parse(result.stdout); } catch { parsed = {}; }
      const items = parsed.items || parsed.messages || parsed.data?.items || [];
      for (const message of items) await this.processMessage(message);
    }
    return { ready: true, generation: this.generation };
  }
}

export function createHealthServer(worker, port = 8788) {
  return createServer(async (request, response) => {
    try {
      if (request.url === '/health') {
        response.writeHead(worker.authenticated ? 200 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: worker.authenticated, generation: worker.generation }));
        return;
      }
      if (request.url === '/generation' && request.method === 'POST') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const result = await worker.bootstrap(JSON.parse(Buffer.concat(chunks).toString()).generation);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
        return;
      }
      response.writeHead(404); response.end();
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: String(error?.message || error).slice(0, 120) }));
    }
  }).listen(port, '0.0.0.0');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const coordinator = new CoordinatorClient({
    baseUrl: process.env.AIPROS_COORDINATOR_URL,
    token: process.env.AIPROS_CONTAINER_TOKEN,
  });
  const worker = new StandbyDwsWorker({ env: process.env, coordinator });
  const server = createHealthServer(worker);
  process.once('SIGTERM', () => server.close(() => process.exit(0)));
}
