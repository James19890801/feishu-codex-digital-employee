import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteRelayStore } from './store.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aipro-outbox-'));
  const options = { databasePath: join(directory, 'db.sqlite'),
    artifactDirectory: join(directory, 'artifacts'), parityEncryptionKey: randomBytes(32) };
  const store = new SqliteRelayStore(options);
  store.startLocalLeadership({ now: 0 });
  return { directory, options, store };
}

test('one source event can be claimed only once across generations and reopen', () => {
  const { directory, options, store } = fixture();
  try {
    const claim = store.claimEvent({ worker: 'mac', generation: 1,
      channel: 'wechat', sourceEventId: 'wx-1', now: 100 });
    assert.equal(claim.claimed, true);
    assert.equal(store.claimEvent({ worker: 'mac', generation: 1,
      channel: 'wechat', sourceEventId: 'wx-1', now: 101 }).claimed, false);
    store.prepareSend({ worker: 'mac', generation: 1, claimKey: claim.claimKey,
      actionKind: 'reply', now: 102 });
    store.tryCloudTakeover({ now: 90_000, cloudReady: true });
    assert.equal(store.claimEvent({ worker: 'mac', generation: 1,
      channel: 'wechat', sourceEventId: 'wx-2', now: 90_001 }).claimed, false);
    store.close();
    const reopened = new SqliteRelayStore(options);
    assert.equal(reopened.claimEvent({ worker: 'cloud', generation: 2,
      channel: 'wechat', sourceEventId: 'wx-1', now: 90_002 }).claimed, false);
    assert.equal(reopened.claimEvent({ worker: 'cloud', generation: 2,
      channel: 'wechat', sourceEventId: 'wx-2', now: 90_003 }).claimed, true);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('prepared outbound intent is never automatically resent after an ambiguous receipt', () => {
  const { directory, store } = fixture();
  try {
    const claim = store.claimEvent({ worker: 'mac', generation: 1,
      channel: 'dingtalk', sourceEventId: 'dt-1', now: 100 });
    const first = store.prepareSend({ worker: 'mac', generation: 1, claimKey: claim.claimKey,
      actionKind: 'reply', now: 101 });
    assert.equal(first.shouldSend, true);
    assert.equal(store.prepareSend({ worker: 'mac', generation: 1, claimKey: claim.claimKey,
      actionKind: 'reply', now: 102 }).shouldSend, false);
    assert.equal(store.recordSendReceipt({ intentKey: first.intentKey, generation: 1,
      status: 'ambiguous', now: 103 }).status, 'ambiguous');
    assert.equal(store.prepareSend({ worker: 'mac', generation: 1, claimKey: claim.claimKey,
      actionKind: 'reply', now: 104 }).shouldSend, false);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('cloud handback waits for in-flight claim and records provider receipt once', () => {
  const { directory, store } = fixture();
  try {
    store.tryCloudTakeover({ now: 90_000, cloudReady: true });
    const claim = store.claimEvent({ worker: 'cloud', generation: 2,
      channel: 'wechat', sourceEventId: 'wx-3', now: 90_001 });
    const intent = store.prepareSend({ worker: 'cloud', generation: 2,
      claimKey: claim.claimKey, actionKind: 'reply', now: 90_002 });
    for (const now of [91_000, 92_000, 93_000]) store.recoveryHeartbeat({ now, healthy: true });
    assert.equal(store.finishCloudDrain({ now: 94_000 }).handedBack, false);
    assert.equal(store.recordSendReceipt({ intentKey: intent.intentKey, generation: 2,
      status: 'sent', providerReceiptId: 'receipt-1', now: 94_001 }).status, 'sent');
    assert.equal(store.completeClaim({ claimKey: claim.claimKey, worker: 'cloud',
      generation: 2, outcome: 'replied', now: 94_002 }).completed, true);
    assert.equal(store.finishCloudDrain({ now: 94_003 }).generation, 3);
    assert.equal(store.recordSendReceipt({ intentKey: intent.intentKey, generation: 2,
      status: 'sent', providerReceiptId: 'receipt-1', now: 94_004 }).duplicate, true);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('unsent pre-takeover claim can transfer once, but prepared sends remain fenced', () => {
  const { directory, store } = fixture();
  try {
    const unsent = store.claimEvent({ worker: 'mac', generation: 1,
      channel: 'wechat', sourceEventId: 'wx-transfer', now: 100 });
    const prepared = store.claimEvent({ worker: 'mac', generation: 1,
      channel: 'wechat', sourceEventId: 'wx-uncertain', now: 101 });
    store.prepareSend({ worker: 'mac', generation: 1, claimKey: prepared.claimKey,
      actionKind: 'reply', now: 102 });
    store.tryCloudTakeover({ now: 90_000, cloudReady: true });
    assert.equal(store.claimEvent({ worker: 'cloud', generation: 2,
      channel: 'wechat', sourceEventId: 'wx-transfer', now: 90_001 }).claimed, true);
    assert.equal(store.claimEvent({ worker: 'cloud', generation: 2,
      channel: 'wechat', sourceEventId: 'wx-uncertain', now: 90_002 }).claimed, false);
    assert.equal(store.prepareSend({ worker: 'mac', generation: 1, claimKey: unsent.claimKey,
      actionKind: 'reply', now: 90_003 }).shouldSend, false);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('replied completion needs a provider-confirmed send receipt', () => {
  const { directory, store } = fixture();
  try {
    const claim = store.claimEvent({ worker: 'mac', generation: 1,
      channel: 'wechat', sourceEventId: 'wx-no-receipt', now: 100 });
    assert.deepEqual(store.completeClaim({ worker: 'mac', generation: 1,
      claimKey: claim.claimKey, outcome: 'replied', now: 101 }),
    { completed: false, reason: 'missing_send_receipt' });
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
