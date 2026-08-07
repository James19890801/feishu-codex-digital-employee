export class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class InMemoryFailoverRepository {
  constructor() {
    this.value = {
      state: 'LOCAL_PRIMARY', generation: 0, lastHeartbeatAt: null,
      serviceStartId: '', recoveryCount: 0, containerReady: false,
      inFlight: 0, lastErrorCode: '', drainStartedAt: null,
    };
    this.claims = new Map();
  }

  async read() { return structuredClone(this.value); }
  async write(value) { this.value = structuredClone(value); }

  async claim(key, claim) {
    if (this.claims.has(key)) return false;
    this.claims.set(key, structuredClone(claim));
    return true;
  }

  async complete(key, outcome) {
    const claim = this.claims.get(key);
    if (!claim || claim.completedAt) return false;
    Object.assign(claim, structuredClone(outcome));
    return true;
  }
}

export class FailoverCoordinatorService {
  constructor({
    repository,
    heartbeatMs = 30_000,
    missThreshold = 3,
    recoveryThreshold = 3,
    drainTimeoutMs = 120_000,
  } = {}) {
    if (!repository) throw new TypeError('repository is required');
    this.repository = repository;
    this.heartbeatMs = heartbeatMs;
    this.missThreshold = missThreshold;
    this.recoveryThreshold = recoveryThreshold;
    this.drainTimeoutMs = drainTimeoutMs;
  }

  async heartbeat(input) {
    const at = Number(input.at);
    if (!Number.isFinite(at)) throw new DomainError('invalid_heartbeat', 'Heartbeat time is invalid');
    const current = await this.repository.read();
    const healthy = input.dwsConnected === true && input.runtimeHealthy === true;
    const recovered = ['TAKING_OVER', 'CLOUD_ACTIVE', 'DRAINING', 'DEGRADED'].includes(current.state)
      && healthy;
    const next = {
      ...current,
      lastHeartbeatAt: at,
      serviceStartId: String(input.serviceStartId || ''),
      recoveryCount: recovered ? current.recoveryCount + 1 : 0,
    };
    if (recovered && next.recoveryCount >= this.recoveryThreshold
      && ['TAKING_OVER', 'CLOUD_ACTIVE', 'DEGRADED'].includes(next.state)) {
      next.state = 'DRAINING';
      next.drainStartedAt = at;
    }
    await this.repository.write(next);
    return this.status(at);
  }

  async evaluate(now) {
    const current = await this.repository.read();
    const age = current.lastHeartbeatAt === null ? Number.POSITIVE_INFINITY
      : Math.max(0, now - current.lastHeartbeatAt);
    if (current.state === 'LOCAL_PRIMARY'
      && age >= this.heartbeatMs * this.missThreshold) {
      current.state = 'TAKING_OVER';
      current.generation += 1;
      current.containerReady = false;
      current.recoveryCount = 0;
      await this.repository.write(current);
    } else if (current.state === 'DRAINING'
      && (current.inFlight === 0
        || now - Number(current.drainStartedAt || now) >= this.drainTimeoutMs)) {
      current.state = 'LOCAL_PRIMARY';
      current.containerReady = false;
      current.recoveryCount = 0;
      current.drainStartedAt = null;
      current.lastErrorCode = '';
      await this.repository.write(current);
    }
    return this.status(now);
  }

  async containerReady(generation) {
    const current = await this.repository.read();
    if (Number(generation) !== current.generation || current.state !== 'TAKING_OVER') {
      throw new DomainError('stale_generation', 'Container generation is stale');
    }
    current.containerReady = true;
    current.state = 'CLOUD_ACTIVE';
    await this.repository.write(current);
    return this.status(Date.now());
  }

  async claim({ generation, messageDigest, at = Date.now() }) {
    const current = await this.repository.read();
    if (Number(generation) !== current.generation) {
      throw new DomainError('stale_generation', 'Claim generation is stale');
    }
    if (current.state !== 'CLOUD_ACTIVE') {
      throw new DomainError('claims_closed', 'Cloud claims are not accepted');
    }
    if (!/^[a-f0-9]{64}$/.test(String(messageDigest || ''))) {
      throw new DomainError('invalid_digest', 'Message digest is invalid');
    }
    const key = `${current.generation}:${messageDigest}`;
    const accepted = await this.repository.claim(key, { at, generation: current.generation });
    if (!accepted) return { accepted: false, generation: current.generation };
    current.inFlight += 1;
    await this.repository.write(current);
    return { accepted: true, generation: current.generation };
  }

  async complete({ generation, messageDigest, outcomeCode = 'completed', at = Date.now() }) {
    const current = await this.repository.read();
    if (Number(generation) !== current.generation) {
      throw new DomainError('stale_generation', 'Completion generation is stale');
    }
    const key = `${current.generation}:${messageDigest}`;
    const completed = await this.repository.complete(key, { completedAt: at, outcomeCode });
    if (completed) current.inFlight = Math.max(0, current.inFlight - 1);
    if (current.state === 'DRAINING' && current.inFlight === 0) {
      current.state = 'LOCAL_PRIMARY';
      current.containerReady = false;
      current.recoveryCount = 0;
      current.drainStartedAt = null;
      current.lastErrorCode = '';
    }
    await this.repository.write(current);
    return { completed, ...(await this.status(at)) };
  }

  async degrade(code) {
    const current = await this.repository.read();
    current.state = 'DEGRADED';
    current.lastErrorCode = String(code || 'unknown').slice(0, 64);
    await this.repository.write(current);
  }

  async status(now = Date.now()) {
    const current = await this.repository.read();
    return {
      state: current.state,
      generation: current.generation,
      heartbeatAgeMs: current.lastHeartbeatAt === null ? null : Math.max(0, now - current.lastHeartbeatAt),
      containerReady: current.containerReady,
      inFlight: current.inFlight,
      lastErrorCode: current.lastErrorCode,
      protocolVersion: '1',
    };
  }
}
