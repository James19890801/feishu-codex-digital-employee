import { WSClient } from '@wecom/aibot-node-sdk';
import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  buildDingTalkConsumerArgs,
  buildDingTalkSendArgs,
  normalizeGeWeWebhook,
  normalizeDingTalkEvent,
  normalizeWeComFrame,
} from './im-channels.mjs';

function validateHttpsBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:') throw new Error('GeWe API base URL must use HTTPS');
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('GeWe API base URL cannot contain credentials, query, or fragment');
  }
  return url.origin;
}

function errorState(error) {
  return {
    at: new Date().toISOString(),
    error: String(error?.message || error || 'unknown error').slice(0, 1000),
  };
}

function nestedMessageId(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return '';
  for (const key of ['messageId', 'message_id', 'openMessageId', 'open_message_id']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    const found = nestedMessageId(child, depth + 1);
    if (found) return found;
  }
  return '';
}

export class DingTalkChannel {
  constructor({
    bin,
    profile = '',
    transport = 'event-stream',
    run,
    onStatus = () => {},
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    sendStatusAttempts = 8,
    sendStatusDelayMs = 500,
    ownerIds = [],
  }) {
    this.bin = bin;
    this.profile = profile;
    this.transport = transport;
    this.run = run;
    this.onStatus = onStatus;
    this.sleep = sleep;
    this.sendStatusAttempts = Math.max(1, Number(sendStatusAttempts) || 1);
    this.sendStatusDelayMs = Math.max(0, Number(sendStatusDelayMs) || 0);
    this.ownerIds = Array.isArray(ownerIds) ? ownerIds : [ownerIds];
  }

  consumerArgs() {
    return buildDingTalkConsumerArgs(this.profile);
  }

  handleStderr(text) {
    if (!String(text || '').includes('[event] ready')) return false;
    this.onStatus({
      authenticated: true,
      connected: true,
      lastReadyAt: new Date().toISOString(),
      lastError: null,
    });
    return true;
  }

  handleLine(line, onMessage) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    const payload = normalizeDingTalkEvent(event, { ownerIds: this.ownerIds });
    if (!payload) return false;
    onMessage(payload);
    return true;
  }

  async send(target, text, uuid = '', options = {}) {
    const args = [
      ...(this.transport === 'event-stream' && this.profile ? ['--profile', this.profile] : []),
      ...buildDingTalkSendArgs(target, text, uuid, {
        ...options,
        transport: this.transport,
      }),
    ];
    const result = await this.run(this.bin, args);
    let payload;
    try {
      payload = JSON.parse(result.stdout || '{}');
    } catch {
      throw new Error(`dws returned invalid JSON: ${(result.stderr || result.stdout || '').slice(-500)}`);
    }
    if (payload.success === false || payload.error) {
      throw new Error(`dws send failed: ${JSON.stringify(payload.error || payload).slice(0, 800)}`);
    }
    if (this.transport === 'wukong-polling' && !payload?.result?.openTaskId) {
      throw new Error(`dws send returned no openTaskId: ${JSON.stringify(payload).slice(0, 800)}`);
    }
    const openTaskId = String(payload?.result?.openTaskId || '').trim();
    if (this.transport === 'event-stream' && !nestedMessageId(payload) && !openTaskId) {
      throw new Error(`dws send returned no messageId or openTaskId: ${JSON.stringify(payload).slice(0, 800)}`);
    }
    if (this.transport === 'event-stream' && openTaskId) {
      let lastStatusPayload = null;
      for (let attempt = 0; attempt < this.sendStatusAttempts; attempt += 1) {
        const statusResult = await this.run(this.bin, [
          ...(this.profile ? ['--profile', this.profile] : []),
          'chat', 'message', 'query-send-status',
          '--open-task-id', openTaskId,
          '--format', 'json',
        ]);
        try {
          lastStatusPayload = JSON.parse(statusResult.stdout || '{}');
        } catch {
          throw new Error(`dws returned invalid send-status JSON: ${(statusResult.stderr || statusResult.stdout || '').slice(-500)}`);
        }
        if (lastStatusPayload.success === false || lastStatusPayload.error) {
          throw new Error(`dws send-status query failed: ${JSON.stringify(lastStatusPayload.error || lastStatusPayload).slice(0, 800)}`);
        }
        const sendStatus = String(
          lastStatusPayload?.result?.sendStatus || lastStatusPayload?.sendStatus || '',
        ).trim().toUpperCase();
        const messageId = nestedMessageId(lastStatusPayload);
        if (sendStatus === 'SUCCESS' && messageId) {
          return {
            ...payload,
            result: {
              ...(payload.result || {}),
              ...(lastStatusPayload.result || {}),
              messageId,
            },
          };
        }
        if (sendStatus.includes('FAIL') || sendStatus === 'ERROR') {
          throw new Error(`dws send failed with terminal status ${sendStatus}: ${JSON.stringify(lastStatusPayload).slice(0, 800)}`);
        }
        if (attempt + 1 < this.sendStatusAttempts) {
          await this.sleep(this.sendStatusDelayMs);
        }
      }
      throw new Error(`dws send did not return terminal SUCCESS with messageId: ${JSON.stringify(lastStatusPayload).slice(0, 800)}`);
    }
    return payload;
  }

  reportError(error) {
    this.onStatus({
      connected: false,
      lastError: errorState(error),
    });
  }
}

export class WeComChannel {
  constructor({
    botId,
    secret,
    websocketUrl,
    ClientClass = WSClient,
    onStatus = () => {},
    logger = null,
  }) {
    this.botId = botId;
    this.secret = secret;
    this.websocketUrl = websocketUrl;
    this.ClientClass = ClientClass;
    this.onStatus = onStatus;
    this.logger = logger;
    this.client = null;
  }

  start(onMessage) {
    if (this.client) throw new Error('WeCom channel is already started');
    const options = {
      botId: this.botId,
      secret: this.secret,
      wsUrl: this.websocketUrl,
      maxReconnectAttempts: -1,
      heartbeatInterval: 30_000,
      ...(this.logger ? { logger: this.logger } : {}),
    };
    const client = new this.ClientClass(options);
    this.client = client;
    client.on('connected', () => {
      this.onStatus({ connected: false, lastError: null });
    });
    client.on('authenticated', () => {
      this.onStatus({
        authenticated: true,
        connected: true,
        lastReadyAt: new Date().toISOString(),
        lastError: null,
      });
    });
    client.on('disconnected', reason => {
      this.onStatus({
        connected: false,
        lastError: reason ? errorState(reason) : null,
      });
    });
    client.on('reconnecting', attempt => {
      this.onStatus({
        connected: false,
        reconnectAttempt: Number(attempt || 0),
      });
    });
    client.on('error', error => {
      this.onStatus({
        connected: false,
        lastError: errorState(error),
      });
    });
    client.on('message', frame => {
      try {
        const payload = normalizeWeComFrame(frame);
        if (payload) onMessage(payload);
      } catch (error) {
        this.onStatus({ lastError: errorState(error) });
      }
    });
    client.connect();
    return client;
  }

  async send(target, text) {
    if (target?.channel !== 'wecom') {
      throw new Error('WeCom sender received a non-WeCom target');
    }
    if (!this.client?.isConnected) throw new Error('WeCom WebSocket is not connected');
    return this.client.sendMessage(target.id, {
      msgtype: 'markdown',
      markdown: { content: String(text || '') },
    });
  }

  stop() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    client.removeAllListeners?.();
    client.disconnect();
  }
}

export class GeWeChannel {
  constructor({
    appId,
    token,
    apiBaseUrl = 'https://api.geweapi.com',
    fetchImpl = globalThis.fetch,
    onStatus = () => {},
    now = Date.now,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    minSendIntervalMs = 1_000,
    mentionNames = [],
  }) {
    this.appId = String(appId || '').trim();
    this.token = String(token || '').trim();
    this.apiBaseUrl = String(apiBaseUrl || '');
    this.fetchImpl = fetchImpl;
    this.onStatus = onStatus;
    this.now = now;
    this.sleep = sleep;
    this.minSendIntervalMs = Math.max(1_000, Number(minSendIntervalMs) || 1_000);
    this.mentionNames = mentionNames;
    this.lastSentAt = 0;
    this.sendTail = Promise.resolve();
  }

  endpoint(path) {
    return `${validateHttpsBaseUrl(this.apiBaseUrl)}${path}`;
  }

  async request(path, body) {
    if (!this.appId) throw new Error('GeWe appId is required');
    if (!this.token) throw new Error('GeWe token is required');
    const response = await this.fetchImpl(this.endpoint(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GEWE-TOKEN': this.token,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`GeWe returned invalid JSON (HTTP ${response.status})`);
    }
    if (!response.ok || Number(payload?.ret) !== 200) {
      throw new Error(`GeWe API failed (HTTP ${response.status}, ret ${payload?.ret ?? 'unknown'}): ${String(payload?.msg || 'unknown error').slice(0, 500)}`);
    }
    return payload;
  }

  async checkOnline() {
    try {
      const result = await this.request('/gewe/v2/api/login/checkOnline', {
        appId: this.appId,
      });
      const online = result.data === true;
      this.onStatus({
        authenticated: true,
        connected: online,
        ...(online ? { lastReadyAt: new Date().toISOString() } : {}),
        lastError: online ? null : errorState('GeWe WeChat account is offline'),
      });
      return online;
    } catch (error) {
      this.onStatus({ authenticated: false, connected: false, lastError: errorState(error) });
      throw error;
    }
  }

  async setCallback(callbackUrl) {
    const parsed = new URL(String(callbackUrl || ''));
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      throw new Error('GeWe public callback URL must use HTTPS without embedded credentials');
    }
    return this.request('/gewe/v2/api/login/setCallback', {
      token: this.token,
      callbackUrl: parsed.href,
    });
  }

  normalizeWebhook(event) {
    return normalizeGeWeWebhook(event, { mentionNames: this.mentionNames });
  }

  async sendNow(target, text) {
    if (target?.channel !== 'wechat') {
      throw new Error('GeWe sender received a non-WeChat target');
    }
    const waitMs = Math.max(0, this.lastSentAt + this.minSendIntervalMs - this.now());
    if (waitMs) await this.sleep(waitMs);
    const result = await this.request('/gewe/v2/api/message/postText', {
      appId: this.appId,
      toWxid: target.id,
      content: String(text || ''),
    });
    this.lastSentAt = this.now();
    this.onStatus({ lastError: null, lastSendAt: new Date().toISOString() });
    return result;
  }

  send(target, text) {
    const operation = this.sendTail.then(() => this.sendNow(target, text));
    this.sendTail = operation.catch(() => {});
    return operation.catch(error => {
      this.onStatus({ lastError: errorState(error) });
      throw error;
    });
  }
}

function callbackPathMatches(actual, expected) {
  const actualBytes = Buffer.from(String(actual || ''));
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

function writeJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

export class GeWeWebhookServer {
  constructor({
    channel,
    callbackSecret,
    port,
    host = '127.0.0.1',
    onMessage = () => {},
    onStatus = () => {},
    maxBodyBytes = 1024 * 1024,
  }) {
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(String(callbackSecret || ''))) {
      throw new Error('GeWe callback secret must contain 24 to 128 URL-safe characters');
    }
    this.channel = channel;
    this.callbackSecret = callbackSecret;
    this.port = Number(port);
    this.host = host;
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    this.maxBodyBytes = maxBodyBytes;
    this.server = null;
  }

  path() {
    return `/webhooks/gewe/${this.callbackSecret}`;
  }

  address() {
    return this.server?.address() || null;
  }

  handle(request, response) {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (!callbackPathMatches(pathname, this.path())) {
      writeJson(response, 404, { ok: false });
      return;
    }
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      writeJson(response, 405, { ok: false });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) {
      writeJson(response, 415, { ok: false });
      return;
    }
    const declaredLength = Number(request.headers['content-length'] || 0);
    if (declaredLength > this.maxBodyBytes) {
      writeJson(response, 413, { ok: false });
      request.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > this.maxBodyBytes) {
        writeJson(response, 413, { ok: false });
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (response.writableEnded) return;
      let event;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        writeJson(response, 400, { ok: false });
        return;
      }
      try {
        const payload = this.channel.normalizeWebhook(event);
        if (payload) this.onMessage(payload);
        this.onStatus({
          callbackListening: true,
          lastWebhookAt: new Date().toISOString(),
          lastError: null,
        });
        writeJson(response, 202, { ok: true, accepted: Boolean(payload) });
      } catch (error) {
        this.onStatus({ lastError: errorState(error) });
        writeJson(response, 202, { ok: true, accepted: false });
      }
    });
    request.on('error', error => {
      this.onStatus({ lastError: errorState(error) });
      if (!response.writableEnded) writeJson(response, 400, { ok: false });
    });
  }

  start() {
    if (this.server) throw new Error('GeWe webhook server is already started');
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => this.handle(request, response));
      this.server = server;
      server.requestTimeout = 3_000;
      server.headersTimeout = 5_000;
      server.keepAliveTimeout = 5_000;
      server.once('error', error => {
        this.onStatus({
          callbackListening: false,
          connected: false,
          lastError: errorState(error),
        });
        reject(error);
      });
      server.listen(this.port, this.host, () => {
        this.onStatus({
          callbackListening: true,
          callbackHost: this.host,
          callbackPort: this.address()?.port || this.port,
          lastError: null,
        });
        resolve(this.address());
      });
    });
  }

  stop() {
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    return new Promise(resolve => {
      server.close(() => {
        this.onStatus({ callbackListening: false, connected: false });
        resolve();
      });
      server.closeAllConnections?.();
    });
  }
}
