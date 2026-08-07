import { Container } from '@cloudflare/containers';
import { FailoverCoordinatorService } from './domain.mjs';
import { QoderCloudClient } from './qoder-client.mjs';
import { DurableObjectFailoverRepository } from './repository-do.mjs';
import { createFailoverWorker } from './routes.mjs';

export class StandbyContainer extends Container {
  defaultPort = 8788;
  sleepAfter = '1h';
  enableInternet = true;
  pingEndpoint = 'health';

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      NODE_ENV: 'production',
      AIPROS_GENERATION: '0',
      AIPROS_COORDINATOR_URL: String(env.AIPROS_INTERNAL_COORDINATOR_URL || ''),
      AIPROS_CONTAINER_TOKEN: String(env.AIPROS_CONTAINER_TOKEN || ''),
      AIPROS_ALLOWED_CHAT_IDS: String(env.AIPROS_ALLOWED_CHAT_IDS || ''),
      DINGTALK_CLIENT_ID: String(env.DINGTALK_CLIENT_ID || ''),
      DINGTALK_CLIENT_SECRET: String(env.DINGTALK_CLIENT_SECRET || ''),
      DINGTALK_DWS_AUTH_BUNDLE_B64: String(env.DINGTALK_DWS_AUTH_BUNDLE_B64 || ''),
    };
  }

  async fetch(request) {
    if (new URL(request.url).pathname === '/__control/stop') {
      await this.stop();
      return Response.json({ ok: true });
    }
    return this.containerFetch(request);
  }

  async onActivityExpired() {
    this.renewActivityTimeout();
  }

  async stopStandby() {
    await this.stop();
  }
}

export class FailoverCoordinator {
  constructor(ctx, env) {
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
    const result = await client.execute({
      prompt,
      digest: input.digest,
      metadata: { level: input.level, purpose: input.purpose, node: this.env.AIPROS_NODE_ID },
    });
    return { result, ...(await this.service.status()) };
  }

  async alarm() {
    const before = await this.service.status();
    const after = await this.service.evaluate(Date.now());
    const container = this.env.STANDBY_CONTAINER.getByName(this.env.AIPROS_NODE_ID);
    if (after.state === 'TAKING_OVER' && before.state !== 'TAKING_OVER') {
      await this.ctx.storage.delete('container_stopped_generation');
      const response = await container.fetch(new Request('http://container/generation', {
        method: 'POST', body: JSON.stringify({ generation: after.generation }),
        headers: { 'content-type': 'application/json' },
      }));
      if (response.ok) await this.service.containerReady(after.generation);
      else await this.service.degrade('container_start_failed');
    }
    if (after.state === 'CLOUD_ACTIVE') {
      let response = await container.fetch(new Request('http://container/health'));
      if (!response.ok) {
        response = await container.fetch(new Request('http://container/generation', {
          method: 'POST', body: JSON.stringify({ generation: after.generation }),
          headers: { 'content-type': 'application/json' },
        }));
        if (!response.ok) await this.service.degrade('container_health_failed');
      }
    }
    if (after.state === 'LOCAL_PRIMARY' && after.generation > 0
      && Number(await this.ctx.storage.get('container_stopped_generation') || 0) !== after.generation) {
      await container.stopStandby();
      await this.ctx.storage.put('container_stopped_generation', after.generation);
    }
    await this.ctx.storage.setAlarm(Date.now() + Number(this.env.HEARTBEAT_MS || 30_000));
  }
}

export default createFailoverWorker();
