import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SqliteRelayStore } from './store.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'aipro-leadership-'));
  const options = { databasePath: join(directory, 'db.sqlite'),
    artifactDirectory: join(directory, 'artifacts'), parityEncryptionKey: randomBytes(32) };
  return { directory, options, store: new SqliteRelayStore(options) };
}

test('local leader is fenced only after missed heartbeat threshold and ready standby', () => {
  const { directory, store } = fixture();
  try {
    assert.deepEqual(store.startLocalLeadership({ now: 1000 }), {
      state: 'LOCAL_PRIMARY', owner: 'mac', generation: 1, heartbeatAt: 1000 });
    assert.equal(store.heartbeatLocal({ generation: 1, now: 30_000 }).accepted, true);
    assert.equal(store.tryCloudTakeover({ now: 119_999, cloudReady: true }).takenOver, false);
    assert.equal(store.tryCloudTakeover({ now: 120_000, cloudReady: false }).takenOver, false);
    assert.deepEqual(store.tryCloudTakeover({ now: 120_000, cloudReady: true }), {
      takenOver: true, state: 'CLOUD_ACTIVE', owner: 'cloud', generation: 2 });
    assert.equal(store.heartbeatLocal({ generation: 1, now: 120_001 }).accepted, false);
    assert.equal(store.tryCloudTakeover({ now: 150_000, cloudReady: true }).takenOver, false);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('three healthy recovery heartbeats drain cloud before a newer local generation', () => {
  const { directory, store } = fixture();
  try {
    store.startLocalLeadership({ now: 0 });
    store.tryCloudTakeover({ now: 90_000, cloudReady: true });
    assert.equal(store.recoveryHeartbeat({ now: 91_000, healthy: true }).state, 'CLOUD_ACTIVE');
    assert.equal(store.recoveryHeartbeat({ now: 106_000, healthy: true }).state, 'CLOUD_ACTIVE');
    assert.equal(store.recoveryHeartbeat({ now: 121_000, healthy: true }).state, 'DRAINING');
    assert.deepEqual(store.finishCloudDrain({ now: 122_000 }), {
      handedBack: true, state: 'LOCAL_PRIMARY', owner: 'mac', generation: 3 });
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('leadership survives database reopen and never reuses a generation', () => {
  const { directory, options, store } = fixture();
  try {
    store.startLocalLeadership({ now: 0 });
    store.tryCloudTakeover({ now: 90_000, cloudReady: true });
    store.close();
    const reopened = new SqliteRelayStore(options);
    assert.equal(reopened.leadershipStatus().generation, 2);
    reopened.recoveryHeartbeat({ now: 91_000, healthy: true });
    reopened.recoveryHeartbeat({ now: 106_000, healthy: true });
    reopened.recoveryHeartbeat({ now: 121_000, healthy: true });
    assert.equal(reopened.finishCloudDrain({ now: 122_000 }).generation, 3);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('recovery requires spaced healthy process heartbeats and records observable times', () => {
  const { directory, store } = fixture();
  try {
    store.startLocalLeadership({ now: 1000 });
    store.heartbeatLocal({ generation: 1, now: 30_000 });
    store.tryCloudTakeover({ now: 120_000, cloudReady: true });
    assert.equal(store.recoveryHeartbeat({ now: 121_000, healthy: true }).state, 'CLOUD_ACTIVE');
    assert.equal(store.recoveryHeartbeat({ now: 121_001, healthy: true }).state, 'CLOUD_ACTIVE');
    assert.equal(store.recoveryHeartbeat({ now: 136_000, healthy: true }).state, 'CLOUD_ACTIVE');
    assert.equal(store.recoveryHeartbeat({ now: 151_000, healthy: true }).state, 'DRAINING');
    store.finishCloudDrain({ now: 151_001 });
    assert.deepEqual(store.leadershipTimeline().map(item => [item.event, item.observedAt,
      item.lastLocalHeartbeatAt]), [
      ['local_started', 1000, null],
      ['cloud_promoted', 120_000, 30_000],
      ['local_recovery_seen', 121_000, 30_000],
      ['cloud_draining', 151_000, 30_000],
      ['local_restored', 151_001, 30_000],
    ]);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
