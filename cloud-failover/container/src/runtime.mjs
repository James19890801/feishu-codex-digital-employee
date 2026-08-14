export function computeBackoffMs(failures, {
  baseMs = 10_000,
  maxMs = 60_000,
  jitter = Math.random,
} = {}) {
  const exponent = Math.max(0, Math.min(16, Number(failures) || 0));
  const uncapped = baseMs * (2 ** exponent);
  const capped = Math.min(maxMs, uncapped);
  const extra = Math.floor(capped * 0.2 * Math.max(0, Math.min(1, Number(jitter()) || 0)));
  return Math.min(maxMs, capped + extra);
}

function abortableSleep(ms, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(finish, ms);
    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    }
    signal?.addEventListener('abort', finish, { once: true });
  });
}

function boundedError(error) {
  return {
    code: String(error?.code || error?.name || 'runtime_error').slice(0, 64),
    message: String(error?.message || error).slice(0, 160),
  };
}

export class RailwayFailoverRuntime {
  constructor({
    worker,
    coordinator,
    sleep = abortableSleep,
    jitter = Math.random,
    onError = error => console.error('railway_failover_cycle_failed', boundedError(error)),
  } = {}) {
    if (!worker || !coordinator) throw new TypeError('worker and coordinator are required');
    this.worker = worker;
    this.coordinator = coordinator;
    this.sleep = sleep;
    this.jitter = jitter;
    this.onError = onError;
  }

  async tick() {
    await this.worker.initialize();
    const lease = await this.coordinator.lease();
    const generation = Number(lease.generation || 0);
    if (lease.state === 'TAKING_OVER') {
      if (this.worker.activeGeneration !== generation) {
        await this.worker.activate(generation, { announceReady: true });
      }
    } else if (lease.state === 'CLOUD_ACTIVE') {
      if (this.worker.activeGeneration !== generation) {
        await this.worker.activate(generation, { announceReady: false });
      }
    } else {
      this.worker.deactivate();
    }
    return lease;
  }

  async start({ signal } = {}) {
    let failures = 0;
    while (!signal?.aborted) {
      try {
        await this.tick();
        failures = 0;
      } catch (error) {
        failures += 1;
        this.onError(error);
      }
      const delay = computeBackoffMs(Math.max(0, failures - 1), { jitter: this.jitter });
      await this.sleep(delay, signal);
    }
  }
}
