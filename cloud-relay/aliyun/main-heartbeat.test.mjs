import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SqliteRelayStore } from './store.mjs';

const digest = 'a'.repeat(64);
const now = 1_800_000_000_000;

test('main-process heartbeat persists boot, policy and critical cursor under server clock', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aipro-main-heartbeat-'));
  const databasePath = path.join(dir, 'state.sqlite');
  const artifactDirectory = path.join(dir, 'artifacts');
  try {
    const store = new SqliteRelayStore({ databasePath, artifactDirectory });
    const leader = store.startLocalLeadership({ now: now - 10_000 });
    const accepted = store.recordMainHeartbeat({ generation: leader.generation,
      bootId: 'boot-1', policyDigest: digest, criticalStateSequence: 12,
      channels: { wechat: true, dingtalk: true }, now });
    assert.equal(accepted.accepted, true);
    assert.deepEqual(store.lastMainHeartbeat(), { generation: 1, bootId: 'boot-1',
      policyDigest: digest, criticalStateSequence: 12,
      channels: { wechat: true, dingtalk: true }, receivedAt: now });
    store.close();
    const reopened = new SqliteRelayStore({ databasePath, artifactDirectory });
    assert.equal(reopened.lastMainHeartbeat().policyDigest, digest);
    assert.equal(reopened.recordMainHeartbeat({ generation: 2, bootId: 'old',
      policyDigest: digest, criticalStateSequence: 12, channels: { wechat: true, dingtalk: true },
      now: now + 15_000 }).accepted, false);
    assert.equal(reopened.lastMainHeartbeat().bootId, 'boot-1');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('refuses invalid or decreasing main-process heartbeat metadata', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'aipro-main-heartbeat-'));
  try {
    const store = new SqliteRelayStore({ databasePath: path.join(dir, 'state.sqlite'),
      artifactDirectory: path.join(dir, 'artifacts') });
    store.startLocalLeadership({ now: now - 10_000 });
    assert.throws(() => store.recordMainHeartbeat({ generation: 1, bootId: 'boot',
      policyDigest: 'not-a-digest', criticalStateSequence: 1, channels: {}, now }), /invalid/);
    store.recordMainHeartbeat({ generation: 1, bootId: 'boot', policyDigest: digest,
      criticalStateSequence: 2, channels: { wechat: true, dingtalk: false }, now });
    assert.equal(store.recordMainHeartbeat({ generation: 1, bootId: 'boot', policyDigest: digest,
      criticalStateSequence: 1, channels: { wechat: true, dingtalk: true }, now: now + 15_000 }).accepted, false);
    assert.equal(store.lastMainHeartbeat().criticalStateSequence, 2);
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
