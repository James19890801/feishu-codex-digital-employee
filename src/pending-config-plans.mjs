export class PendingConfigurationPlans {
  constructor({
    now = () => Date.now(),
    ttlMs = 15 * 60_000,
    maxPlans = 20,
  } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxPlans = maxPlans;
    this.plans = new Map();
  }

  get size() {
    return this.plans.size;
  }

  prune() {
    const now = this.now();
    for (const [id, entry] of this.plans) {
      if (entry.expiresAt <= now) this.plans.delete(id);
    }
    while (this.plans.size > this.maxPlans) {
      this.plans.delete(this.plans.keys().next().value);
    }
  }

  add(plan, { confirmationCode = '' } = {}) {
    if (!plan?.id) throw new Error('Plan ID is required');
    this.prune();
    const stored = {
      plan: structuredClone(plan),
      confirmationCode: String(confirmationCode),
      expiresAt: this.now() + this.ttlMs,
    };
    this.plans.delete(plan.id);
    this.plans.set(plan.id, stored);
    while (this.plans.size > this.maxPlans) {
      this.plans.delete(this.plans.keys().next().value);
    }
    return {
      ...structuredClone(plan),
      confirmationCode: plan.confirmationLevel === 'double' ? stored.confirmationCode : '',
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  }

  get(id) {
    const entry = this.plans.get(String(id || ''));
    if (!entry) throw new Error('Configuration plan not found');
    if (entry.expiresAt <= this.now()) {
      this.plans.delete(String(id));
      throw new Error('Configuration plan expired');
    }
    return structuredClone(entry.plan);
  }

  consume(id, { confirmationCode = '' } = {}) {
    const key = String(id || '');
    const entry = this.plans.get(key);
    if (!entry) throw new Error('Configuration plan not found');
    if (entry.expiresAt <= this.now()) {
      this.plans.delete(key);
      throw new Error('Configuration plan expired');
    }
    if (entry.plan.confirmationLevel === 'double'
      && String(confirmationCode) !== entry.confirmationCode) {
      throw new Error('Confirmation code is incorrect');
    }
    this.plans.delete(key);
    return structuredClone(entry.plan);
  }
}
