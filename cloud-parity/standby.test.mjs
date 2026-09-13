import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudStandby } from './standby.mjs';

const digest = 'a'.repeat(64);
const now = 1_800_000_000_000;
const event = { message: { message_id: 'dingtalk:m1', chat_id: 'dingtalk:user:u1' },
  metadata: { channel: 'dingtalk' } };
const capabilities = { qoder: true, wechatIngress: true, dingtalkIngress: true,
  wechatSend: true, dingtalkSend: true, policyParity: true,
  outboundFencing: true, providerReceipts: true };

function fixture(overrides = {}) {
  const calls = [];
  let leader = { state: 'LOCAL_PRIMARY', owner: 'mac', generation: 1 };
  const store = {
    getCurrentPolicy: () => ({ revision: 1, digest, appliedAt: now - 10_000,
      manifest: { sections: { persona: { data: '小詹' } } } }),
    lastMainHeartbeat: () => ({ generation: 1, receivedAt: now - 90_000,
      policyDigest: digest, criticalStateSequence: 4,
      channels: { wechat: true, dingtalk: true } }),
    getPolicyCursor: () => ({ sequence: 4, digest }),
    tryCloudTakeover: ({ cloudReady }) => {
      calls.push(['takeover', cloudReady]);
      if (cloudReady) leader = { state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 2 };
      return { takenOver: cloudReady, ...leader };
    },
    leadershipStatus: () => leader,
    claimEvent: input => { calls.push(['claim', input]); return { claimed: true, claimKey: 'c'.repeat(64) }; },
    prepareSend: input => { calls.push(['prepare', input]); return { shouldSend: true, intentKey: 'i'.repeat(64) }; },
    recordSendReceipt: input => { calls.push(['receipt', input]); return { status: input.status }; },
    completeClaim: input => { calls.push(['complete', input]); return { completed: true }; },
  };
  const runtime = { execute: async () => { calls.push(['qoder']); return { text: '收到' }; } };
  const policyEngine = {
    decide: async () => ({ kind: 'reply', message: '请回答', context: {} }),
    authorizeSend: async () => true,
  };
  const senders = { dingtalk: { send: async () => { calls.push(['send']); return { receiptId: 'provider-1' }; } },
    wechat: { send: async () => ({ receiptId: 'provider-2' }) } };
  const standby = new CloudStandby({ store, runtime, policyEngine, senders,
    readinessProbe: async () => capabilities, now: () => now, ...overrides });
  return { standby, calls, store };
}

test('cannot promote with one missing capability even after heartbeat expiry', async () => {
  const { standby, calls } = fixture({ readinessProbe: async () => ({ ...capabilities, dingtalkIngress: false }) });
  const result = await standby.promote({ lastLocalHeartbeat: {
    at: now - 90_000, policyDigest: digest, criticalStateSequence: 4,
  }, criticalStateAckSequence: 4 });
  assert.equal(result.takenOver, false);
  assert.ok(result.reasons.includes('missing_dingtalkIngress'));
  assert.equal(calls.length, 0);
});

test('one cloud reply requires claim, fresh authorization, fenced intent and provider receipt', async () => {
  const { standby, calls } = fixture();
  await standby.promote({ lastLocalHeartbeat: {
    at: now - 90_000, policyDigest: digest, criticalStateSequence: 4,
  }, criticalStateAckSequence: 4 });
  const result = await standby.process(event);
  assert.equal(result.outcome, 'replied');
  assert.deepEqual(calls.map(item => item[0]), ['takeover', 'claim', 'qoder', 'prepare', 'send', 'receipt', 'complete']);
  assert.equal(calls.find(item => item[0] === 'receipt')[1].providerReceiptId, 'provider-1');
});

test('failed or receipt-less provider send is ambiguous and never completed as replied', async () => {
  const failing = fixture({ senders: {
    dingtalk: { send: async () => { throw Error('lost connection'); } },
    wechat: { send: async () => ({ receiptId: 'unused' }) },
  } });
  await failing.standby.promote({ lastLocalHeartbeat: {
    at: now - 90_000, policyDigest: digest, criticalStateSequence: 4,
  }, criticalStateAckSequence: 4 });
  await assert.rejects(failing.standby.process(event), /ambiguous/);
  assert.equal(failing.calls.find(item => item[0] === 'receipt')[1].status, 'ambiguous');
  assert.ok(!failing.calls.some(item => item[0] === 'complete'));
});

test('a changed policy or denied send fences the outbound before provider contact', async () => {
  const changed = fixture();
  await changed.standby.promote({ lastLocalHeartbeat: {
    at: now - 90_000, policyDigest: digest, criticalStateSequence: 4,
  }, criticalStateAckSequence: 4 });
  const original = changed.store.getCurrentPolicy;
  let reads = 0;
  changed.store.getCurrentPolicy = () => {
    reads += 1;
    return reads === 1 ? original() : { ...original(), digest: 'b'.repeat(64) };
  };
  await assert.rejects(changed.standby.process(event), /policy_changed/);
  assert.ok(!changed.calls.some(item => item[0] === 'prepare' || item[0] === 'send'));

  const denied = fixture({ policyEngine: {
    decide: async () => ({ kind: 'reply', message: 'x' }),
    authorizeSend: async () => false,
  } });
  await denied.standby.promote({ lastLocalHeartbeat: {
    at: now - 90_000, policyDigest: digest, criticalStateSequence: 4,
  }, criticalStateAckSequence: 4 });
  const result = await denied.standby.process(event);
  assert.equal(result.outcome, 'skipped');
  assert.ok(!denied.calls.some(item => item[0] === 'prepare' || item[0] === 'send'));
});

test('WeChat-only standby does not wait for DingTalk and cannot claim DingTalk events', async () => {
  const { standby, calls } = fixture({ channels: ['wechat'],
    senders: { wechat: { send: async () => ({ receiptId: 'wechat-provider-id' }) } },
    readinessProbe: async () => ({ ...capabilities, dingtalkIngress: false, dingtalkSend: false }) });
  const promoted = await standby.promote({ lastLocalHeartbeat: {
    at: now - 90_000, policyDigest: digest, criticalStateSequence: 4,
  }, criticalStateAckSequence: 4 });
  assert.equal(promoted.takenOver, true);
  await assert.rejects(standby.process(event), /disabled_cloud_channel/);
  assert.equal(calls.some(item => item[0] === 'claim'), false);
  const wechatEvent = { message: { message_id: 'wechat:m2', chat_id: 'wechat:user:u2' },
    metadata: { channel: 'wechat' } };
  const result = await standby.process(wechatEvent);
  assert.equal(result.outcome, 'replied');
  assert.equal(result.receiptId, 'wechat-provider-id');
});

test('promotion uses persisted server heartbeat and policy cursor, not caller assertions', async () => {
  const stale = fixture({ channels: ['wechat'] });
  stale.store.lastMainHeartbeat = () => ({ generation: 1, receivedAt: now - 90_000,
    policyDigest: 'b'.repeat(64), criticalStateSequence: 4,
    channels: { wechat: true, dingtalk: false } });
  const forged = await stale.standby.promote({ lastLocalHeartbeat: {
    at: now - 90_000, policyDigest: digest, criticalStateSequence: 4,
  }, criticalStateAckSequence: 4 });
  assert.equal(forged.takenOver, false);
  assert.ok(forged.reasons.includes('policy_digest_mismatch'));
  assert.equal(stale.calls.length, 0);

  const unready = fixture({ channels: ['wechat'] });
  unready.store.lastMainHeartbeat = () => ({ generation: 1, receivedAt: now - 90_000,
    policyDigest: digest, criticalStateSequence: 4,
    channels: { wechat: false, dingtalk: true } });
  const denied = await unready.standby.promote();
  assert.equal(denied.takenOver, false);
  assert.ok(denied.reasons.includes('last_local_wechat_unready'));
});
