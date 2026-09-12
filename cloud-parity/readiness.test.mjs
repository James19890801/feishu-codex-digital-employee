import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCloudReadiness } from './readiness.mjs';

const NOW = 1_800_000_000_000;
const digest = 'a'.repeat(64);
const readyInput = () => ({
  now: NOW,
  policy: { revision: 6, digest, appliedAt: NOW - 10_000 },
  lastLocalHeartbeat: { at: NOW - 90_000, policyDigest: digest, criticalStateSequence: 12 },
  criticalStateAckSequence: 12,
  capabilities: {
    qoder: true, wechatIngress: true, dingtalkIngress: true,
    wechatSend: true, dingtalkSend: true, policyParity: true,
    outboundFencing: true, providerReceipts: true,
  },
});

test('requires verified policy, acknowledged critical state, and every channel/send capability', () => {
  assert.deepEqual(evaluateCloudReadiness(readyInput()), { ready: true, reasons: [] });
  for (const capability of Object.keys(readyInput().capabilities)) {
    const input = readyInput();
    input.capabilities[capability] = false;
    const result = evaluateCloudReadiness(input);
    assert.equal(result.ready, false, capability);
    assert.ok(result.reasons.includes(`missing_${capability}`), capability);
  }
});

test('fails closed on mismatched policy and unacknowledged critical mutations', () => {
  const missing = readyInput(); missing.policy = null;
  assert.equal(evaluateCloudReadiness(missing).ready, false);
  const mismatch = readyInput(); mismatch.lastLocalHeartbeat.policyDigest = 'b'.repeat(64);
  assert.ok(evaluateCloudReadiness(mismatch).reasons.includes('policy_digest_mismatch'));
  const critical = readyInput(); critical.criticalStateAckSequence = 11;
  assert.ok(evaluateCloudReadiness(critical).reasons.includes('critical_state_unacknowledged'));
});

test('rejects invalid last heartbeat and cannot be made ready by missing capability names', () => {
  const future = readyInput(); future.lastLocalHeartbeat.at = NOW + 1000;
  assert.equal(evaluateCloudReadiness(future).ready, false);
  const partial = readyInput(); delete partial.capabilities.dingtalkIngress;
  assert.ok(evaluateCloudReadiness(partial).reasons.includes('missing_dingtalkIngress'));
});
