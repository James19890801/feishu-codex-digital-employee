import { WSClient } from '@wecom/aibot-node-sdk';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname } from 'node:path';
import {
  buildEnterpriseChatConsumerArgs,
  buildEnterpriseChatSendArgs,
  normalizeGeWeWebhook,
  normalizeEnterpriseChatEvent,
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

function parseJsonPreservingUnsafeIntegers(source) {
  const input = String(source || '');
  let output = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length;) {
    const char = input[index];
    if (inString) {
      output += char;
      index += 1;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      index += 1;
      continue;
    }
    if (char === '-' || /\d/.test(char)) {
      let end = index + 1;
      while (end < input.length && /[0-9eE+.\-]/.test(input[end])) end += 1;
      const token = input.slice(index, end);
      if (/^-?\d+$/.test(token) && !Number.isSafeInteger(Number(token))) {
        output += `"${token}"`;
      } else {
        output += token;
      }
      index = end;
      continue;
    }
    output += char;
    index += 1;
  }
  return JSON.parse(output);
}

function stringifyGeWeBody(body) {
  let output = JSON.stringify(body);
  for (const key of ['snsId', 'maxId']) {
    const value = body?.[key];
    if (typeof value !== 'string' || !/^\d{16,30}$/.test(value)) continue;
    output = output.replace(`"${key}":"${value}"`, `"${key}":${value}`);
  }
  return output;
}

export class EnterpriseChatChannel {
  constructor({
    bin,
    profile = '',
    transport = 'event-stream',
    run,
    onStatus = () => {},
  }) {
    this.bin = bin;
    this.profile = profile;
    this.transport = transport;
    this.run = run;
    this.onStatus = onStatus;
  }

  consumerArgs() {
    return buildEnterpriseChatConsumerArgs(this.profile);
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
    const payload = normalizeEnterpriseChatEvent(event);
    if (!payload) return false;
    onMessage(payload);
    return true;
  }

  async send(target, text, uuid = '', options = {}) {
    const args = [
      ...(this.transport === 'event-stream' && this.profile ? ['--profile', this.profile] : []),
      ...buildEnterpriseChatSendArgs(target, text, uuid, {
        ...options,
        transport: this.transport,
      }),
    ];
    const result = await this.run(this.bin, args);
    let payload;
    try {
      payload = JSON.parse(result.stdout || '{}');
    } catch {
      throw new Error(`connector returned invalid JSON: ${(result.stderr || result.stdout || '').slice(-500)}`);
    }
    if (payload.success === false || payload.error) {
      throw new Error(`connector send failed: ${JSON.stringify(payload.error || payload).slice(0, 800)}`);
    }
    if (this.transport === 'legacyBridge-polling' && !payload?.result?.deliveryTaskId) {
      throw new Error(`connector send returned no deliveryTaskId: ${JSON.stringify(payload).slice(0, 800)}`);
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
    requestTimeoutMs = 120_000,
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
    this.requestTimeoutMs = Math.max(15_000, Math.min(120_000, Number(requestTimeoutMs) || 120_000));
    this.mentionNames = mentionNames;
    this.lastSentAt = 0;
    this.sendTail = Promise.resolve();
    this.lastMomentWriteAt = 0;
    this.momentTail = Promise.resolve();
    this.chatroomMemberCache = new Map();
    this.chatroomMemberCacheTtlMs = 5 * 60_000;
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
      body: stringifyGeWeBody(body),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    let payload;
    try {
      payload = typeof response.text === 'function'
        ? parseJsonPreservingUnsafeIntegers(await response.text())
        : await response.json();
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

  async getProfile() {
    const result = await this.request('/gewe/v2/api/personal/getProfile', {
      appId: this.appId,
    });
    const wxid = String(result?.data?.wxid || '').trim().slice(0, 500);
    if (!wxid) throw new Error('GeWe profile returned no wxid');
    const nickName = String(result?.data?.nickName || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 100);
    return { wxid, nickName };
  }

  async getContactDetails(wxids = []) {
    const normalizedWxids = [...new Set((Array.isArray(wxids) ? wxids : [])
      .map(value => String(value || '').trim())
      .filter(Boolean))];
    if (!normalizedWxids.length || normalizedWxids.length > 20
      || normalizedWxids.some(value => value.length > 256 || /[\s\u0000-\u001f\u007f]/.test(value))) {
      throw new Error('GeWe contact identifiers are invalid');
    }
    const result = await this.request('/gewe/v2/api/contacts/getDetailInfo', {
      appId: this.appId,
      wxids: normalizedWxids,
    });
    const safeUrl = value => {
      try {
        const parsed = new URL(String(value || ''));
        return parsed.protocol === 'https:' && !parsed.username && !parsed.password ? parsed.href : '';
      } catch { return ''; }
    };
    return (Array.isArray(result?.data) ? result.data : []).slice(0, normalizedWxids.length)
      .map(contact => ({
        userName: String(contact?.userName || '').trim().slice(0, 256),
        nickName: String(contact?.nickName || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100),
        smallHeadImgUrl: safeUrl(contact?.smallHeadImgUrl),
        bigHeadImgUrl: safeUrl(contact?.bigHeadImgUrl),
      }))
      .filter(contact => normalizedWxids.includes(contact.userName));
  }

  async listMoments({ maxId = 0, firstPageMd5 = '' } = {}) {
    const normalizedMaxId = maxId === 0 ? 0 : String(maxId || '').trim();
    if (normalizedMaxId !== 0 && !/^\d{1,30}$/.test(normalizedMaxId)) {
      throw new Error('GeWe Moments maxId is invalid');
    }
    const normalizedMd5 = String(firstPageMd5 || '').trim();
    if (normalizedMd5 && !/^[a-f0-9]{8,64}$/i.test(normalizedMd5)) {
      throw new Error('GeWe Moments firstPageMd5 is invalid');
    }
    const result = await this.request('/gewe/v2/api/sns/snsList', {
      appId: this.appId,
      maxId: normalizedMaxId,
      decrypt: true,
      firstPageMd5: normalizedMd5,
    });
    const data = result?.data && typeof result.data === 'object' ? result.data : {};
    return {
      ...data,
      snsList: Array.isArray(data.snsList) ? data.snsList.slice(0, 50) : [],
    };
  }

  async getMomentDetails(snsId) {
    const normalizedSnsId = String(snsId || '').trim();
    if (!/^\d{1,30}$/.test(normalizedSnsId)) {
      throw new Error('GeWe snsId is invalid');
    }
    const result = await this.request('/gewe/v2/api/sns/snsDetails', {
      appId: this.appId,
      snsId: normalizedSnsId,
    });
    return result?.data && typeof result.data === 'object' ? result.data : {};
  }

  commentMoment({ snsId, wxid, commentId = 0, content } = {}) {
    const normalizedSnsId = String(snsId || '').trim();
    if (!/^\d{1,30}$/.test(normalizedSnsId)) {
      return Promise.reject(new Error('GeWe snsId is invalid'));
    }
    const normalizedWxid = String(wxid || '').trim();
    if (!normalizedWxid || normalizedWxid.length > 500
      || /[\s\u0000-\u001f\u007f]/.test(normalizedWxid)) {
      return Promise.reject(new Error('GeWe Moments wxid is invalid'));
    }
    const normalizedCommentId = Number(commentId || 0);
    if (!Number.isSafeInteger(normalizedCommentId) || normalizedCommentId < 0) {
      return Promise.reject(new Error('GeWe Moments commentId is invalid'));
    }
    const normalizedContent = String(content || '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!normalizedContent || normalizedContent.length > 200
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalizedContent)) {
      return Promise.reject(new Error('GeWe Moments comment content is invalid'));
    }
    const operation = this.momentTail.then(async () => {
      const waitMs = Math.max(0, this.lastMomentWriteAt + 3_000 - this.now());
      if (waitMs) await this.sleep(waitMs);
      const result = await this.request('/gewe/v2/api/sns/commentSns', {
        appId: this.appId,
        snsId: normalizedSnsId,
        operType: 1,
        wxid: normalizedWxid,
        commentId: normalizedCommentId,
        content: normalizedContent,
      });
      this.lastMomentWriteAt = this.now();
      return result;
    });
    this.momentTail = operation.catch(() => {});
    return operation;
  }

  likeMoment({ snsId, wxid } = {}) {
    const normalizedSnsId = String(snsId || '').trim();
    if (!/^\d{1,30}$/.test(normalizedSnsId)) {
      return Promise.reject(new Error('GeWe snsId is invalid'));
    }
    const normalizedWxid = String(wxid || '').trim();
    if (!normalizedWxid || normalizedWxid.length > 500
      || /[\s\u0000-\u001f\u007f]/.test(normalizedWxid)) {
      return Promise.reject(new Error('GeWe Moments wxid is invalid'));
    }
    const operation = this.momentTail.then(async () => {
      const waitMs = Math.max(0, this.lastMomentWriteAt + 3_000 - this.now());
      if (waitMs) await this.sleep(waitMs);
      const result = await this.request('/gewe/v2/api/sns/likeSns', {
        appId: this.appId,
        snsId: normalizedSnsId,
        operType: 1,
        wxid: normalizedWxid,
      });
      this.lastMomentWriteAt = this.now();
      return result;
    });
    this.momentTail = operation.catch(() => {});
    return operation;
  }

  publishTextMoment({ content } = {}) {
    const normalizedContent = String(content || '')
      .replace(/\r\n?/g, '\n')
      .trim();
    if (!normalizedContent || normalizedContent.length > 500
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalizedContent)) {
      return Promise.reject(new Error('GeWe Moments content is invalid'));
    }
    const operation = this.momentTail.then(async () => {
      const waitMs = Math.max(0, this.lastMomentWriteAt + 3_000 - this.now());
      if (waitMs) await this.sleep(waitMs);
      const result = await this.request('/gewe/v2/api/sns/sendTextSns', {
        appId: this.appId,
        allowWxIds: [],
        atWxIds: [],
        disableWxIds: [],
        content: normalizedContent,
        privacy: false,
        allowTagIds: [],
        disableTagIds: [],
      });
      this.lastMomentWriteAt = this.now();
      return result;
    });
    this.momentTail = operation.catch(() => {});
    return operation;
  }

  publishLinkMoment({ content, title, description = '', linkUrl, thumbUrl = '' } = {}) {
    const normalizedContent = String(content || '').replace(/\r\n?/g, '\n').trim();
    const normalizedTitle = String(title || '').replace(/\s+/g, ' ').trim();
    const normalizedDescription = String(description || '').replace(/\s+/g, ' ').trim();
    const unsafeText = value => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
    if (!normalizedContent || normalizedContent.length > 500 || unsafeText(normalizedContent)) {
      return Promise.reject(new Error('GeWe Moments link content is invalid'));
    }
    if (!normalizedTitle || normalizedTitle.length > 200 || unsafeText(normalizedTitle)) {
      return Promise.reject(new Error('GeWe Moments link title is invalid'));
    }
    if (normalizedDescription.length > 500 || unsafeText(normalizedDescription)) {
      return Promise.reject(new Error('GeWe Moments link description is invalid'));
    }
    let normalizedLinkUrl;
    try {
      const parsed = new URL(String(linkUrl || ''));
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid');
      normalizedLinkUrl = parsed.href;
    } catch {
      return Promise.reject(new Error('GeWe Moments link URL is invalid'));
    }
    let normalizedThumbUrl = '';
    if (String(thumbUrl || '').trim()) {
      try {
        const parsed = new URL(String(thumbUrl));
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('invalid');
        normalizedThumbUrl = parsed.href;
      } catch {
        return Promise.reject(new Error('GeWe Moments thumb URL is invalid'));
      }
    }
    const operation = this.momentTail.then(async () => {
      const waitMs = Math.max(0, this.lastMomentWriteAt + 3_000 - this.now());
      if (waitMs) await this.sleep(waitMs);
      const result = await this.request('/gewe/v2/api/sns/sendUrlSns', {
        appId: this.appId,
        allowWxIds: [],
        atWxIds: [],
        disableWxIds: [],
        content: normalizedContent,
        description: normalizedDescription,
        title: normalizedTitle,
        linkUrl: normalizedLinkUrl,
        thumbUrl: normalizedThumbUrl,
        privacy: false,
        allowTagIds: [],
        disableTagIds: [],
      });
      this.lastMomentWriteAt = this.now();
      return result;
    });
    this.momentTail = operation.catch(() => {});
    return operation;
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

  async downloadImage(xml, { type = 2 } = {}) {
    const imageXml = String(xml || '').trim();
    if (!imageXml) throw new Error('GeWe image XML is required');
    const result = await this.request('/gewe/v2/api/message/downloadImage', {
      appId: this.appId,
      xml: imageXml,
      type: Number(type),
    });
    const fileUrl = String(result?.data?.fileUrl || '').trim();
    if (!/^https?:\/\//i.test(fileUrl)) {
      throw new Error('GeWe image download returned no valid file URL');
    }
    return fileUrl;
  }

  async downloadVoice(xml, { msgId } = {}) {
    const voiceXml = String(xml || '').trim();
    const normalizedMsgId = String(msgId || '').trim();
    if (!voiceXml) throw new Error('GeWe voice XML is required');
    if (!/^\d{1,30}$/.test(normalizedMsgId)) throw new Error('GeWe voice msgId is invalid');
    const result = await this.request('/gewe/v2/api/message/downloadVoice', {
      appId: this.appId,
      msgId: normalizedMsgId,
      xml: voiceXml,
    });
    const fileUrl = String(result?.data?.fileUrl || '').trim();
    if (!/^https?:\/\//i.test(fileUrl)) {
      throw new Error('GeWe voice download returned no valid file URL');
    }
    return fileUrl;
  }

  async downloadFile(xml) {
    const fileXml = String(xml || '').trim();
    if (!fileXml) throw new Error('GeWe file XML is required');
    const result = await this.request('/gewe/v2/api/message/downloadFile', {
      appId: this.appId,
      xml: fileXml,
    });
    const fileUrl = String(result?.data?.fileUrl || '').trim();
    if (!/^https?:\/\//i.test(fileUrl)) {
      throw new Error('GeWe file download returned no valid file URL');
    }
    return fileUrl;
  }

  async getChatroomInfo(chatroomId) {
    const normalizedChatroomId = String(chatroomId || '').trim();
    if (!normalizedChatroomId.endsWith('@chatroom') || normalizedChatroomId.length > 500) {
      throw new Error('GeWe chatroom ID is invalid');
    }
    const result = await this.request('/gewe/v2/api/group/getChatroomInfo', {
      appId: this.appId,
      chatroomId: normalizedChatroomId,
    });
    const nickName = String(result?.data?.nickName || '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 200);
    return {
      chatroomId: normalizedChatroomId,
      nickName,
    };
  }

  async getChatroomMemberList(chatroomId) {
    const normalizedChatroomId = String(chatroomId || '').trim();
    if (!normalizedChatroomId.endsWith('@chatroom') || normalizedChatroomId.length > 500) {
      throw new Error('GeWe chatroom ID is invalid');
    }
    const result = await this.request('/gewe/v2/api/group/getChatroomMemberList', {
      appId: this.appId,
      chatroomId: normalizedChatroomId,
    });
    const members = Array.isArray(result?.data?.memberList) ? result.data.memberList : [];
    return members.slice(0, 5_000).flatMap(member => {
      const memberId = String(member?.wxid || '').trim().slice(0, 500);
      if (!memberId) return [];
      const displayName = String(member?.displayName || member?.nickName || '新朋友')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .trim()
        .slice(0, 100) || '新朋友';
      return [{ memberId, displayName }];
    });
  }

  async cachedChatroomMemberList(chatroomId, { forceRefresh = false } = {}) {
    const normalizedChatroomId = String(chatroomId || '').trim();
    const cached = this.chatroomMemberCache.get(normalizedChatroomId);
    if (!forceRefresh && cached && cached.expiresAt > this.now()) return cached.members;
    const members = await this.getChatroomMemberList(normalizedChatroomId);
    this.chatroomMemberCache.set(normalizedChatroomId, {
      members,
      expiresAt: this.now() + this.chatroomMemberCacheTtlMs,
    });
    return members;
  }

  async prepareGroupMention(target, text, { atWxids = [] } = {}) {
    if (target?.channel !== 'wechat' || target?.kind !== 'group') {
      throw new Error('GeWe group mention requires a personal WeChat group target');
    }
    const wxids = [...new Set((Array.isArray(atWxids) ? atWxids : [atWxids])
      .map(value => String(value || '').replace(/^wechat:/, '').trim())
      .filter(Boolean))].slice(0, 20);
    if (!wxids.length) throw new Error('GeWe group mention requires at least one member wxid');

    let members = await this.cachedChatroomMemberList(target.id);
    let memberById = new Map(members.map(member => [member.memberId, member]));
    if (wxids.some(wxid => !memberById.has(wxid))) {
      members = await this.cachedChatroomMemberList(target.id, { forceRefresh: true });
      memberById = new Map(members.map(member => [member.memberId, member]));
    }
    const missingWxid = wxids.find(wxid => !memberById.has(wxid));
    if (missingWxid) {
      throw new Error(`GeWe group member not found for required mention: ${missingWxid}`);
    }
    const labels = wxids.map(wxid => `@${memberById.get(wxid).displayName}`);
    return {
      content: `${labels.join(' ')}\n${String(text || '')}`,
      ats: wxids.join(','),
    };
  }

  normalizeWebhook(event) {
    return normalizeGeWeWebhook(event, { mentionNames: this.mentionNames });
  }

  async sendNow(target, text, { ats = '' } = {}) {
    if (target?.channel !== 'wechat') {
      throw new Error('GeWe sender received a non-WeChat target');
    }
    const normalizedAts = [...new Set(String(ats || '').split(',')
      .map(value => value.replace(/^wechat:/, '').trim())
      .filter(Boolean))].slice(0, 20).join(',');
    if (normalizedAts && target?.kind !== 'group') {
      throw new Error('GeWe mentions are only supported for group targets');
    }
    const content = String(text || '');
    if (normalizedAts && !/(?:^|\s)@[^\s]+/u.test(content)) {
      throw new Error('GeWe mention content must contain a visible @ label');
    }
    const waitMs = Math.max(0, this.lastSentAt + this.minSendIntervalMs - this.now());
    if (waitMs) await this.sleep(waitMs);
    const result = await this.request('/gewe/v2/api/message/postText', {
      appId: this.appId,
      toWxid: target.id,
      content,
      ...(normalizedAts ? { ats: normalizedAts } : {}),
    });
    this.lastSentAt = this.now();
    this.onStatus({ lastError: null, lastSendAt: new Date().toISOString() });
    return result;
  }

  send(target, text, options = {}) {
    const operation = this.sendTail.then(() => this.sendNow(target, text, options));
    this.sendTail = operation.catch(() => {});
    return operation.catch(error => {
      this.onStatus({ lastError: errorState(error) });
      throw error;
    });
  }

  async sendImageNow(target, { imageUrl } = {}) {
    if (target?.channel !== 'wechat') {
      throw new Error('GeWe sender received a non-WeChat target');
    }
    const parsedUrl = new URL(String(imageUrl || ''));
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      throw new Error('GeWe image URL must use HTTPS without embedded credentials');
    }
    const waitMs = Math.max(0, this.lastSentAt + this.minSendIntervalMs - this.now());
    if (waitMs) await this.sleep(waitMs);
    const result = await this.request('/gewe/v2/api/message/postImage', {
      appId: this.appId,
      toWxid: target.id,
      imgUrl: parsedUrl.href,
    });
    this.lastSentAt = this.now();
    this.onStatus({ lastError: null, lastSendAt: new Date().toISOString() });
    return result;
  }

  sendImage(target, image) {
    const operation = this.sendTail.then(() => this.sendImageNow(target, image));
    this.sendTail = operation.catch(() => {});
    return operation.catch(error => {
      this.onStatus({ lastError: errorState(error) });
      throw error;
    });
  }

  async sendFileNow(target, { fileUrl, fileName } = {}) {
    if (target?.channel !== 'wechat') {
      throw new Error('GeWe sender received a non-WeChat target');
    }
    const parsedUrl = new URL(String(fileUrl || ''));
    if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
      throw new Error('GeWe file URL must use HTTPS without embedded credentials');
    }
    const safeFileName = String(fileName || '').split(/[\\/]/).at(-1)?.trim().slice(0, 180);
    if (!safeFileName) throw new Error('GeWe file name is required');
    const waitMs = Math.max(0, this.lastSentAt + this.minSendIntervalMs - this.now());
    if (waitMs) await this.sleep(waitMs);
    const result = await this.request('/gewe/v2/api/message/postFile', {
      appId: this.appId,
      toWxid: target.id,
      fileUrl: parsedUrl.href,
      fileName: safeFileName,
    });
    this.lastSentAt = this.now();
    this.onStatus({ lastError: null, lastSendAt: new Date().toISOString() });
    return result;
  }

  sendFile(target, file) {
    const operation = this.sendTail.then(() => this.sendFileNow(target, file));
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
    maxArtifactBytes = 100 * 1024 * 1024,
    now = Date.now,
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
    this.maxArtifactBytes = maxArtifactBytes;
    this.now = now;
    this.artifacts = new Map();
    this.server = null;
  }

  path() {
    return `/webhooks/gewe/${this.callbackSecret}`;
  }

  address() {
    return this.server?.address() || null;
  }

  pruneArtifacts() {
    const nowMs = this.now();
    for (const [token, artifact] of this.artifacts) {
      if (artifact.expiresAt <= nowMs) this.artifacts.delete(token);
    }
  }

  async registerArtifact({ path, fileName, ttlMs = 5 * 60_000 } = {}) {
    const sourcePath = String(path || '');
    const sourceInfo = await lstat(sourcePath);
    if (sourceInfo.isSymbolicLink()) {
      throw new Error('GeWe artifact must be a regular file');
    }
    const resolvedPath = await realpath(sourcePath);
    const info = await lstat(resolvedPath);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('GeWe artifact must be a regular file');
    }
    if (info.size <= 0 || info.size > this.maxArtifactBytes) {
      throw new Error('GeWe artifact size is invalid');
    }
    const safeName = basename(String(fileName || '')).trim().slice(0, 180);
    if (!safeName) throw new Error('GeWe artifact file name is required');
    this.pruneArtifacts();
    const token = randomBytes(32).toString('base64url');
    this.artifacts.set(token, {
      path: resolvedPath,
      fileName: safeName,
      size: info.size,
      expiresAt: this.now() + Math.max(1_000, Math.min(Number(ttlMs) || 0, 15 * 60_000)),
    });
    return `${this.path()}/artifacts/${token}/${encodeURIComponent(safeName)}`;
  }

  handleArtifact(request, response, pathname) {
    const prefix = `${this.path()}/artifacts/`;
    if (!pathname.startsWith(prefix)) return false;
    if (!['GET', 'HEAD'].includes(request.method || '')) {
      response.setHeader('Allow', 'GET, HEAD');
      writeJson(response, 405, { ok: false });
      return true;
    }
    this.pruneArtifacts();
    const token = pathname.slice(prefix.length).split('/')[0];
    const artifact = this.artifacts.get(token);
    if (!artifact) {
      writeJson(response, 404, { ok: false });
      return true;
    }
    const extension = extname(artifact.fileName).replace(/[^.A-Za-z0-9]/g, '').slice(0, 12);
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': artifact.size,
      'Content-Disposition': `attachment; filename="artifact${extension}"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (request.method === 'HEAD') {
      response.end();
      return true;
    }
    const stream = createReadStream(artifact.path);
    stream.once('error', () => response.destroy());
    stream.pipe(response);
    return true;
  }

  handle(request, response) {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
    if (this.handleArtifact(request, response, pathname)) return;
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
    this.artifacts.clear();
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
