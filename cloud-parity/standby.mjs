import { evaluateCloudReadiness } from './readiness.mjs';

function invariant(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export class CloudStandby {
  constructor({ store, runtime, policyEngine, senders, readinessProbe,
    channels = ['wechat', 'dingtalk'], now = Date.now } = {}) {
    invariant(store && typeof store.getCurrentPolicy === 'function'
      && typeof store.tryCloudTakeover === 'function'
      && typeof store.lastMainHeartbeat === 'function'
      && typeof store.getPolicyCursor === 'function'
      && typeof store.leadershipStatus === 'function', 'cloud_store_required');
    invariant(runtime && typeof runtime.execute === 'function', 'cloud_runtime_required');
    invariant(policyEngine && typeof policyEngine.decide === 'function'
      && typeof policyEngine.authorizeSend === 'function', 'shared_policy_engine_required');
    invariant(Array.isArray(channels) && channels.length > 0
      && new Set(channels).size === channels.length
      && channels.every(channel => ['wechat', 'dingtalk'].includes(channel)), 'invalid_cloud_channels');
    invariant(channels.every(channel => typeof senders?.[channel]?.send === 'function'),
      'channel_sender_required');
    invariant(typeof readinessProbe === 'function', 'readiness_probe_required');
    this.store = store;
    this.runtime = runtime;
    this.policyEngine = policyEngine;
    this.senders = senders;
    this.readinessProbe = readinessProbe;
    this.channels = Object.freeze([...channels]);
    this.now = now;
  }

  async promote() {
    const policy = this.store.getCurrentPolicy();
    const persisted = this.store.lastMainHeartbeat();
    const cursor = this.store.getPolicyCursor('mac');
    const leader = this.store.leadershipStatus();
    const capabilities = await this.readinessProbe();
    const lastLocalHeartbeat = persisted && {
      at: persisted.receivedAt, policyDigest: persisted.policyDigest,
      criticalStateSequence: persisted.criticalStateSequence,
    };
    const assessment = evaluateCloudReadiness({ now: this.now(), policy,
      lastLocalHeartbeat, criticalStateAckSequence: cursor?.sequence,
      capabilities }, { channels: this.channels });
    if (cursor?.digest !== policy?.digest) assessment.reasons.push('policy_cursor_mismatch');
    if (persisted?.generation !== leader?.generation
      || leader?.state !== 'LOCAL_PRIMARY' || leader?.owner !== 'mac') {
      assessment.reasons.push('heartbeat_generation_mismatch');
    }
    for (const channel of this.channels) {
      if (persisted?.channels?.[channel] !== true) {
        assessment.reasons.push(`last_local_${channel}_unready`);
      }
    }
    if (assessment.reasons.length) return { takenOver: false, reasons: assessment.reasons };
    return this.store.tryCloudTakeover({ now: this.now(), cloudReady: true });
  }

  async process(event) {
    const channel = event?.metadata?.channel;
    const sourceEventId = event?.message?.message_id;
    invariant(['wechat', 'dingtalk'].includes(channel)
      && typeof sourceEventId === 'string' && sourceEventId.startsWith(`${channel}:`),
    'invalid_cloud_event');
    invariant(this.channels.includes(channel), 'disabled_cloud_channel');
    const leadership = this.store.leadershipStatus();
    invariant(leadership?.state === 'CLOUD_ACTIVE' && leadership?.owner === 'cloud',
      'cloud_not_leader');
    const generation = leadership.generation;
    const policy = this.store.getCurrentPolicy();
    invariant(policy?.revision > 0 && policy?.digest, 'policy_unavailable');
    const claim = this.store.claimEvent({ worker: 'cloud', generation, channel, sourceEventId,
      now: this.now() });
    if (!claim.claimed) return { outcome: 'duplicate', reason: claim.reason };

    const decision = await this.policyEngine.decide(event, policy.manifest);
    if (decision?.kind !== 'reply') {
      this.store.completeClaim({ claimKey: claim.claimKey, worker: 'cloud', generation,
        outcome: 'skipped', now: this.now() });
      return { outcome: 'skipped' };
    }
    const response = await this.runtime.execute({ message: decision.message,
      context: decision.context || {}, policyDigest: policy.digest });
    invariant(typeof response?.text === 'string' && response.text.trim(), 'cloud_empty_reply');

    // Re-evaluate immediately before persisting a one-shot outbound intent.
    const currentPolicy = this.store.getCurrentPolicy();
    const currentLeader = this.store.leadershipStatus();
    invariant(currentPolicy?.digest === policy.digest, 'policy_changed');
    invariant(currentLeader?.state === 'CLOUD_ACTIVE' && currentLeader?.owner === 'cloud'
      && currentLeader?.generation === generation, 'stale_generation');
    const allowed = await this.policyEngine.authorizeSend(event, currentPolicy.manifest, response.text);
    if (allowed !== true) {
      this.store.completeClaim({ claimKey: claim.claimKey, worker: 'cloud', generation,
        outcome: 'skipped', now: this.now() });
      return { outcome: 'skipped', reason: 'send_policy_denied' };
    }
    const intent = this.store.prepareSend({ worker: 'cloud', generation, claimKey: claim.claimKey,
      actionKind: 'reply', now: this.now() });
    if (!intent.shouldSend) return { outcome: 'fenced', reason: intent.status };

    // A prepared intent is never retried automatically after an uncertain send.
    let receipt;
    try {
      receipt = await this.senders[channel].send({ event, text: response.text,
        intentKey: intent.intentKey, generation });
    } catch {
      this.store.recordSendReceipt({ intentKey: intent.intentKey, generation,
        status: 'ambiguous', now: this.now() });
      throw Object.assign(new Error('ambiguous_cloud_send'), { code: 'ambiguous_cloud_send' });
    }
    if (!receipt?.receiptId) {
      this.store.recordSendReceipt({ intentKey: intent.intentKey, generation,
        status: 'ambiguous', now: this.now() });
      throw Object.assign(new Error('ambiguous_cloud_send'), { code: 'ambiguous_cloud_send' });
    }
    this.store.recordSendReceipt({ intentKey: intent.intentKey, generation, status: 'sent',
      providerReceiptId: receipt.receiptId, now: this.now() });
    this.store.completeClaim({ claimKey: claim.claimKey, worker: 'cloud', generation,
      outcome: 'replied', now: this.now() });
    return { outcome: 'replied', intentKey: intent.intentKey, receiptId: receipt.receiptId };
  }
}
