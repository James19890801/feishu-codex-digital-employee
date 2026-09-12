const DIGEST = /^[a-f0-9]{64}$/;

export const REQUIRED_CLOUD_CAPABILITIES = Object.freeze([
  'qoder', 'wechatIngress', 'dingtalkIngress', 'wechatSend', 'dingtalkSend',
  'policyParity', 'outboundFencing', 'providerReceipts',
]);

// Readiness is evaluated by the coordinator before promotion, never inferred
// from a local process PID, a successful health GET, or a daily sync schedule.
export function evaluateCloudReadiness(input = {}) {
  const reasons = [];
  const now = Number(input.now);
  const policy = input.policy;
  const heartbeat = input.lastLocalHeartbeat;
  if (!Number.isFinite(now) || now <= 0) reasons.push('invalid_coordinator_time');
  if (!policy || !Number.isSafeInteger(policy.revision) || policy.revision < 1
    || !DIGEST.test(policy.digest || '') || !Number.isFinite(policy.appliedAt)
    || policy.appliedAt > now) reasons.push('policy_unverified');
  if (!heartbeat || !Number.isFinite(heartbeat.at) || heartbeat.at <= 0
    || heartbeat.at > now || !DIGEST.test(heartbeat.policyDigest || '')
    || !Number.isSafeInteger(heartbeat.criticalStateSequence)
    || heartbeat.criticalStateSequence < 0) reasons.push('last_local_heartbeat_unverified');
  if (policy && heartbeat && policy.digest !== heartbeat.policyDigest) {
    reasons.push('policy_digest_mismatch');
  }
  if (!heartbeat || !Number.isSafeInteger(input.criticalStateAckSequence)
    || input.criticalStateAckSequence !== heartbeat.criticalStateSequence) {
    reasons.push('critical_state_unacknowledged');
  }
  for (const name of REQUIRED_CLOUD_CAPABILITIES) {
    if (input.capabilities?.[name] !== true) reasons.push(`missing_${name}`);
  }
  return { ready: reasons.length === 0, reasons };
}
