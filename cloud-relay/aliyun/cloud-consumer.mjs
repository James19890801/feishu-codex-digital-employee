import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SqliteRelayStore } from './store.mjs';
import { parseParityConfig } from './parity-config.mjs';
import { QoderManagedRuntime } from './qoder-runtime.mjs';

const EVENT_ID = /^[A-Za-z0-9_-]{1,256}$/;

function text(value) {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && typeof value.string === 'string') return value.string;
  return '';
}

// The relay stores the original callback.  Keep the cloud normalizer narrow:
// only ordinary text callbacks are eligible for autonomous replies.  Media,
// system, malformed and self-originated callbacks remain unacknowledged.
export function normalizeCloudGeWeText(callback) {
  const v1 = Boolean(callback?.Data);
  const data = v1 ? callback.Data : callback;
  const appId = String(v1 ? callback?.Appid : callback?.appid || '').trim();
  const selfWxid = String(v1 ? callback?.Wxid : callback?.wxid || '').trim();
  const type = v1 ? Number(data?.MsgType) : String(data?.msgType || '').toUpperCase();
  const isText = v1 ? String(callback?.TypeName || '') === 'AddMsg' && type === 1 : type === 'TEXT';
  if (!isText || !appId || !selfWxid) return null;
  const from = text(v1 ? data?.FromUserName : data?.fromUser).trim();
  const to = text(v1 ? data?.ToUserName : data?.toUser).trim();
  const content = text(v1 ? data?.Content : data?.content).trim();
  const messageId = text(v1 ? data?.NewMsgId : data?.newMsgId).trim();
  if (!from || !content || !EVENT_ID.test(messageId) || from === selfWxid) return null;
  const group = from.endsWith('@chatroom') || to.endsWith('@chatroom');
  const target = group ? (from.endsWith('@chatroom') ? from : to) : from;
  const sender = group ? String(v1 ? '' : data?.senderWxid || data?.sender || '').trim() : from;
  if (!target || (group && !sender)) return null;
  return { message: { message_id: `wechat:${appId}:${messageId}`,
    chat_id: `wechat:${group ? 'group' : 'user'}:${target}`, chat_type: group ? 'group' : 'p2p',
    message_type: 'text', content: JSON.stringify({ text: content }) },
  sender: { sender_type: 'user', sender_id: { open_id: `wechat:${sender}` } },
  metadata: { channel: 'wechat', appId, callbackVersion: v1 ? 'v1' : 'v2' } };
}

function policyAllows(event, manifest) {
  const config = manifest?.sections?.config?.data || {};
  const state = manifest?.sections?.state?.data || {};
  const paused = Array.isArray(state.settings) && state.settings.some(row => row?.key === 'assistant_paused'
    && ['1', 'true', 'yes', true].includes(row?.value));
  if (paused) return false;
  const allowed = Array.isArray(config.authorizedChatIds) ? config.authorizedChatIds : [];
  return config.allowAllChats === true || allowed.includes(event.message.chat_id);
}

function receiptId(payload, depth = 0) {
  if (!payload || typeof payload !== 'object' || depth > 4) return '';
  for (const key of ['newMsgId', 'new_msg_id', 'msgId', 'msg_id', 'messageId', 'message_id']) {
    if (typeof payload[key] === 'string' && payload[key].trim()) return payload[key].trim();
  }
  for (const value of Object.values(payload)) {
    const found = receiptId(value, depth + 1);
    if (found) return found;
  }
  return '';
}

export function createCloudGeWeClient({ appId, token, fetchImpl = fetch } = {}) {
  const configuredAppId = String(appId || '').trim();
  const configuredToken = String(token || '');
  if (!configuredAppId || configuredToken.length < 24 || typeof fetchImpl !== 'function') {
    throw new TypeError('cloud_gewe_configuration_required');
  }
  return { async sendText({ toWxid, content } = {}) {
    const target = String(toWxid || '').trim();
    const text = String(content || '').trim();
    if (!target || !text || text.length > 16_000) throw new Error('invalid_cloud_gewe_send');
    const response = await fetchImpl('https://api.geweapi.com/gewe/v2/api/message/postText', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-GEWE-TOKEN': configuredToken },
      body: JSON.stringify({ appId: configuredAppId, toWxid: target, content: text }), signal: AbortSignal.timeout(30_000),
    });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('wechat_send_unconfirmed'); }
    if (!response.ok || Number(payload?.ret) !== 200) throw new Error('wechat_send_unconfirmed');
    return payload;
  } };
}

export function createCloudWechatWorker({ store, runtime, gewe, now = Date.now } = {}) {
  if (!store || !runtime || typeof runtime.execute !== 'function' || !gewe || typeof gewe.sendText !== 'function') {
    throw new TypeError('cloud_worker_dependencies_required');
  }
  return { async process(item) {
    let callback;
    try { callback = JSON.parse(String(item?.body || '')); } catch { return { outcome: 'skipped', reason: 'malformed_callback' }; }
    const event = normalizeCloudGeWeText(callback);
    if (!event) return { outcome: 'skipped', reason: 'unsupported_callback' };
    const leader = store.leadershipStatus();
    if (leader?.state !== 'CLOUD_ACTIVE' || leader?.owner !== 'cloud') return { outcome: 'fenced', reason: 'not_cloud_leader' };
    const policy = store.getCurrentPolicy();
    if (!policy?.digest || !policyAllows(event, policy.manifest)) return { outcome: 'skipped', reason: 'policy_denied' };
    const claim = store.claimEvent({ worker: 'cloud', generation: leader.generation, channel: 'wechat',
      sourceEventId: event.message.message_id, now: now() });
    if (!claim?.claimed) return { outcome: 'duplicate', reason: claim?.reason };
    const response = await runtime.execute({ message: JSON.parse(event.message.content).text,
      context: { persona: String(policy.manifest.sections?.persona?.data || ''),
        rules: String(policy.manifest.sections?.instructions?.data || '') }, policyDigest: policy.digest });
    if (!response?.text?.trim()) throw new Error('cloud_empty_reply');
    const current = store.leadershipStatus();
    if (current?.state !== 'CLOUD_ACTIVE' || current?.owner !== 'cloud' || current.generation !== leader.generation
      || store.getCurrentPolicy()?.digest !== policy.digest || !policyAllows(event, policy.manifest)) {
      throw new Error('stale_generation_or_policy');
    }
    const intent = store.prepareSend({ worker: 'cloud', generation: leader.generation, claimKey: claim.claimKey,
      actionKind: 'reply', now: now() });
    if (!intent?.shouldSend) return { outcome: 'fenced', reason: intent?.status };
    let provider;
    try {
      const target = event.message.chat_id.replace(/^wechat:(?:user|group):/, '');
      provider = await gewe.sendText({ toWxid: target, content: response.text.trim(), intentKey: intent.intentKey });
    } catch {
      store.recordSendReceipt({ intentKey: intent.intentKey, generation: leader.generation, status: 'ambiguous', now: now() });
      throw new Error('ambiguous_cloud_send');
    }
    const id = Number(provider?.ret) === 200 ? receiptId(provider) : '';
    if (!id) {
      store.recordSendReceipt({ intentKey: intent.intentKey, generation: leader.generation, status: 'ambiguous', now: now() });
      throw new Error('ambiguous_cloud_send');
    }
    store.recordSendReceipt({ intentKey: intent.intentKey, generation: leader.generation, status: 'sent', providerReceiptId: id, now: now() });
    store.completeClaim({ claimKey: claim.claimKey, worker: 'cloud', generation: leader.generation, outcome: 'replied', now: now() });
    return { outcome: 'replied', receiptId: id };
  } };
}

export async function consumeActiveOnce({ store, worker, enabled = false, now = Date.now() } = {}) {
  if (enabled !== true) return { leased: 0, acknowledged: 0, ambiguous: 0, skipped: 'disabled' };
  const leader = store?.leadershipStatus?.();
  if (leader?.state !== 'CLOUD_ACTIVE' || leader?.owner !== 'cloud') {
    return { leased: 0, acknowledged: 0, ambiguous: 0, skipped: 'not_cloud_leader' };
  }
  const lease = await store.lease({ now, leaseMs: 30_000, limit: 10 });
  const ids = [];
  let ambiguous = 0;
  for (const item of lease.events || []) {
    try {
      const result = await worker.process(item);
      if (['replied', 'skipped', 'duplicate', 'fenced'].includes(result?.outcome)) ids.push(item.id);
      else ambiguous += 1;
    } catch { ambiguous += 1; }
  }
  const acknowledged = ids.length ? (await store.ack({ ids })).acked || 0 : 0;
  return { leased: (lease.events || []).length, acknowledged, ambiguous, generation: leader.generation };
}

export async function consumeShadowOnce({ store, enabled = false, now = Date.now() } = {}) {
  if (enabled !== true) return { leased: 0, parsed: 0, normalized: 0, malformed: 0, acknowledged: 0, skipped: 'disabled' };
  const leader = store?.leadershipStatus?.();
  if (leader?.state !== 'CLOUD_ACTIVE' || leader?.owner !== 'cloud') {
    return { leased: 0, parsed: 0, normalized: 0, malformed: 0, acknowledged: 0, skipped: 'not_cloud_leader' };
  }
  const lease = await store.lease({ now, leaseMs: 30_000, limit: 10 });
  let parsed = 0;
  let normalized = 0;
  let malformed = 0;
  for (const event of lease.events || []) {
    try {
      const callback = JSON.parse(String(event.body || ''));
      parsed += 1;
      if (normalizeCloudGeWeText(callback)) normalized += 1;
    } catch { malformed += 1; }
  }
  return { leased: (lease.events || []).length, parsed, normalized, malformed, acknowledged: 0, generation: leader.generation };
}

async function main() {
  const configPath = process.env.RELAY_CONFIG_PATH || '/etc/aipro-wechat-relay/config.json';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const parity = parseParityConfig(config);
  const store = new SqliteRelayStore({ databasePath: config.databasePath || '/var/lib/aipro-wechat-relay/events.sqlite',
    artifactDirectory: config.artifactDirectory || '/var/lib/aipro-wechat-relay/artifacts', parityEncryptionKey: parity.parityEncryptionKey });
  const active = config.cloudConsumerEnabled === true && config.cloudConsumerMode === 'active';
  const worker = active ? createCloudWechatWorker({ store,
    runtime: new QoderManagedRuntime({ agentId: config.cloudQoderAgentId,
      environmentId: config.cloudQoderEnvironmentId, agentVersion: Number(config.cloudQoderAgentVersion),
      patSupplier: async () => config.cloudQoderPat }),
    gewe: createCloudGeWeClient({ appId: config.cloudGeweAppId, token: config.cloudGeweToken }),
  }) : null;
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  while (!controller.signal.aborted) {
    const result = active ? await consumeActiveOnce({ store, worker, enabled: true })
      : await consumeShadowOnce({ store, enabled: config.cloudConsumerEnabled === true });
    if (result.leased) process.stdout.write(`cloud_consumer leased=${result.leased} acknowledged=${result.acknowledged || 0}\n`);
    await new Promise(resolve => setTimeout(resolve, result.leased ? 250 : 1_000));
  }
  store.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`cloud_consumer_fatal ${String(error?.message || error)}\n`); process.exitCode = 1; });
}
