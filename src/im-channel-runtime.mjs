import { WSClient } from '@wecom/aibot-node-sdk';
import {
  buildDingTalkConsumerArgs,
  buildDingTalkSendArgs,
  normalizeDingTalkEvent,
  normalizeWeComFrame,
} from './im-channels.mjs';

function errorState(error) {
  return {
    at: new Date().toISOString(),
    error: String(error?.message || error || 'unknown error').slice(0, 1000),
  };
}

export class DingTalkChannel {
  constructor({
    bin,
    profile = '',
    run,
    onStatus = () => {},
  }) {
    this.bin = bin;
    this.profile = profile;
    this.run = run;
    this.onStatus = onStatus;
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
    const payload = normalizeDingTalkEvent(event);
    if (!payload) return false;
    onMessage(payload);
    return true;
  }

  async send(target, text, uuid = '') {
    const args = [
      ...(this.profile ? ['--profile', this.profile] : []),
      ...buildDingTalkSendArgs(target, text, uuid),
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
