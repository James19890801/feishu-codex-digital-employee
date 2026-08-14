import { DurableObject } from 'cloudflare:workers';
import { FailoverCoordinatorService } from './domain.mjs';
import { QoderCloudClient } from './qoder-client.mjs';
import { DurableObjectFailoverRepository } from './repository-do.mjs';
import { createFailoverWorker } from './routes.mjs';
import { executeCloudHandoff } from './handoff.mjs';
import { describeCloudImage } from './vision.mjs';

export class FailoverCoordinator extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.repository = new DurableObjectFailoverRepository(ctx.storage);
    this.service = new FailoverCoordinatorService({
      repository: this.repository,
      heartbeatMs: Number(env.HEARTBEAT_MS || 30_000),
      missThreshold: Number(env.MISS_THRESHOLD || 3),
      recoveryThreshold: Number(env.RECOVERY_THRESHOLD || 3),
    });
  }

  async useNonce(node, nonce, expiresAt, now) {
    return this.repository.use(node, nonce, expiresAt, now);
  }

  async heartbeat(payload) {
    const result = await this.service.heartbeat({ ...payload, at: Date.parse(payload.at) });
    await this.ctx.storage.setAlarm(Date.now() + Number(this.env.HEARTBEAT_MS || 30_000));
    return result;
  }

  async lease() { return this.service.lease(Date.now()); }
  async status() { return this.service.status(); }
  async containerReady(generation) { return this.service.containerReady(generation); }
  async claim(input) { return this.service.claim(input); }
  async complete(input) { return this.service.complete(input); }

  async executeQoder(input) {
    if (!['L0', 'L1'].includes(String(input.level || '').toUpperCase())) {
      throw Object.assign(new Error('Only L0/L1 tasks are allowed'), { code: 'risk_level' });
    }
    const prompt = String(input.prompt || '');
    const promptBytes = new TextEncoder().encode(prompt);
    if (!prompt || prompt.length > 24_000 || promptBytes.byteLength > 64 * 1024) {
      throw Object.assign(new Error('Cloud prompt is empty or too large'), { code: 'invalid_prompt' });
    }
    const actualDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', promptBytes))]
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    if (actualDigest !== String(input.digest || '') || Number(input.bytes) !== promptBytes.byteLength) {
      throw Object.assign(new Error('Cloud prompt metadata does not match'), { code: 'prompt_tampered' });
    }
    const client = new QoderCloudClient({
      pat: this.env.QODER_PAT,
      agentId: this.env.QODER_AGENT_ID,
      agentVersion: this.env.QODER_AGENT_VERSION,
      environmentId: this.env.QODER_ENVIRONMENT_ID,
    });
    const handoff = await executeCloudHandoff({
      repository: this.repository,
      handoffId: String(input.handoffId || ''),
      digest: actualDigest,
      execute: () => client.execute({
        prompt,
        digest: input.digest,
        metadata: { level: input.level, purpose: input.purpose, node: this.env.AIPROS_NODE_ID },
      }),
    });
    return { ...handoff, ...(await this.service.status()) };
  }

  async executeVision(input) {
    const status = await this.service.status();
    if (status.state !== 'CLOUD_ACTIVE' || Number(input?.generation) !== Number(status.generation)) {
      throw Object.assign(new Error('Cloud vision requires the active failover generation'), { code: 'stale_generation' });
    }
    return describeCloudImage({ ai: this.env.AI, input });
  }

  async alarm() {
    await this.repository.pruneHandoffs(Date.now());
    await this.service.evaluate(Date.now());
    await this.ctx.storage.setAlarm(Date.now() + Number(this.env.HEARTBEAT_MS || 30_000));
  }
}

export default createFailoverWorker();
