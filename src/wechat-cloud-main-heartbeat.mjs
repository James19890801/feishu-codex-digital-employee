const DIGEST = /^[a-f0-9]{64}$/;

export class WeChatCloudMainHeartbeat {
  constructor({ paritySync, controlClient, channelReady, bootId } = {}) {
    if (typeof paritySync?.reconcile !== 'function'
      || typeof controlClient?.localGeneration !== 'function'
      || typeof controlClient?.heartbeat !== 'function'
      || typeof channelReady !== 'function'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(String(bootId || ''))) {
      throw new TypeError('invalid_wechat_cloud_heartbeat');
    }
    this.paritySync = paritySync;
    this.controlClient = controlClient;
    this.channelReady = channelReady;
    this.bootId = bootId;
  }

  async tick() {
    const parity = await this.paritySync.reconcile();
    if (!DIGEST.test(String(parity?.digest || ''))
      || !Number.isSafeInteger(parity?.workerSequence)
      || parity.workerSequence < 1) throw new Error('cloud_parity_unacknowledged');
    const generation = await this.controlClient.localGeneration();
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new Error('local_generation_invalid');
    }
    return this.controlClient.heartbeat({ generation, bootId: this.bootId,
      policyDigest: parity.digest, criticalStateSequence: parity.workerSequence,
      channels: { wechat: this.channelReady() === true, dingtalk: false } });
  }
}
