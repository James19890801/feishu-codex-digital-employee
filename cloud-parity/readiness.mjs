const DIGEST = /^[a-f0-9]{64}$/;

const COMMON_CAPABILITIES = Object.freeze([
  'qoder', 'policyParity', 'outboundFencing', 'providerReceipts',
]);
const CHANNEL_CAPABILITIES = Object.freeze({
  wechat: Object.freeze(['wechatIngress', 'wechatSend']),
  dingtalk: Object.freeze(['dingtalkIngress', 'dingtalkSend']),
});
export const REQUIRED_CLOUD_CAPABILITIES = Object.freeze([
  ...COMMON_CAPABILITIES, ...CHANNEL_CAPABILITIES.wechat, ...CHANNEL_CAPABILITIES.dingtalk,
]);

// Readiness is evaluated by the coordinator before promotion, never inferred
// from a local process PID, a successful health GET, or a daily sync schedule.
export function evaluateCloudReadiness(input = {}, { channels = ['wechat', 'dingtalk'] } = {}) {
  const reasons = [];
  const validChannels = Array.isArray(channels) && channels.length > 0
    && new Set(channels).size === channels.length
    && channels.every(channel => Object.hasOwn(CHANNEL_CAPABILITIES, channel));
  if (!validChannels) reasons.push('invalid_channels');
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
  const required = validChannels ? [
    ...COMMON_CAPABILITIES, ...channels.flatMap(channel => CHANNEL_CAPABILITIES[channel]),
  ] : COMMON_CAPABILITIES;
  for (const name of required) {
    if (input.capabilities?.[name] !== true) reasons.push(`missing_${name}`);
  }
  return { ready: reasons.length === 0, reasons };
}
