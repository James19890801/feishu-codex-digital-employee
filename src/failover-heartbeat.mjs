export class FailoverHeartbeat {
  constructor({
    client,
    snapshot,
    intervalMs = 30_000,
    onSuccess = () => {},
    onError = () => {},
    setTimer = (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimer = timer => clearTimeout(timer),
  } = {}) {
    if (!client || typeof client.heartbeat !== 'function') {
      throw new TypeError('Cloud failover heartbeat client is required');
    }
    if (typeof snapshot !== 'function') throw new TypeError('Heartbeat snapshot is required');
    this.client = client;
    this.snapshot = snapshot;
    this.intervalMs = Math.max(10_000, Math.min(60_000, Number(intervalMs) || 30_000));
    this.onSuccess = onSuccess;
    this.onError = onError;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timer = null;
    this.sequence = 0;
    this.started = false;
    this.running = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  schedule(delayMs) {
    if (!this.started) return;
    this.timer = this.setTimer(() => this.tick(), delayMs);
    this.timer?.unref?.();
  }

  async tick() {
    if (!this.started || this.running) return;
    this.running = true;
    this.sequence += 1;
    try {
      const result = await this.client.heartbeat(this.snapshot(this.sequence));
      await this.onSuccess(result);
    } catch (error) {
      await this.onError(error);
    } finally {
      this.running = false;
      if (this.started) this.schedule(this.intervalMs);
    }
  }

  stop() {
    this.started = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
  }
}
