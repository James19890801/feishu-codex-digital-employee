import {
  classifyRuntimeFailure,
  evaluateCloudEligibility,
  sanitizeCloudPrompt,
} from './cloud-failover-policy.mjs';

function ineligibleError(reason, cause) {
  const error = new Error(`Cloud failover is not eligible: ${reason}`, { cause });
  error.code = 'cloud_failover_ineligible';
  error.reason = reason;
  return error;
}

export class LocalFirstRuntimeRouter {
  constructor({
    localClient,
    cloudClient = null,
    attempts = 3,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
  } = {}) {
    if (!localClient || typeof localClient.run !== 'function') {
      throw new TypeError('Local AI runtime client is required');
    }
    this.localClient = localClient;
    this.cloudClient = cloudClient;
    this.attempts = Math.max(1, Math.min(3, Number(attempts) || 3));
    this.delay = delay;
    this.now = now;
  }

  async run(prompt, options = {}, context = {}) {
    const totalTimeoutMs = Math.max(1_000, Number(options.timeoutMs) || 120_000);
    const startedAt = this.now();
    const perAttemptTimeoutMs = Math.max(1_000, Math.floor(totalTimeoutMs / this.attempts));
    let lastError = null;

    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      const elapsed = Math.max(0, this.now() - startedAt);
      const remaining = Math.max(1_000, totalTimeoutMs - elapsed);
      try {
        return await this.localClient.run(prompt, {
          ...options,
          timeoutMs: Math.min(perAttemptTimeoutMs, remaining),
        });
      } catch (error) {
        lastError = error;
        const classification = classifyRuntimeFailure(error);
        if (!classification.retryable) throw error;
        if (attempt < this.attempts) {
          const delayMs = attempt * 1_000;
          const afterAttempt = Math.max(0, this.now() - startedAt);
          if (afterAttempt + delayMs < totalTimeoutMs) await this.delay(delayMs);
        }
      }
    }

    const eligibility = evaluateCloudEligibility({
      ...context,
      prompt,
      images: options.images,
      maxPromptChars: context.maxPromptChars,
    });
    if (!eligibility.eligible) throw ineligibleError(eligibility.reason, lastError);
    if (!this.cloudClient || typeof this.cloudClient.execute !== 'function') {
      const error = new Error('Cloud failover client is not configured', { cause: lastError });
      error.code = 'cloud_failover_unavailable';
      throw error;
    }
    const sanitized = sanitizeCloudPrompt(prompt, {
      forbiddenValues: context.forbiddenValues,
      ownerPhone: context.ownerPhone,
      maxChars: context.maxPromptChars,
    });
    const cloudResult = await this.cloudClient.execute({
      level: String(context.level || '').toUpperCase(),
      prompt: sanitized.text,
      digest: sanitized.digest,
      bytes: sanitized.bytes,
      purpose: String(context.purpose || 'reply').slice(0, 64),
    });
    return {
      text: cloudResult.text,
      stdout: cloudResult.text,
      stderr: '',
      runtime: { id: 'qoder-cloud', label: 'Qoder Cloud Agent' },
      cloud: {
        sessionId: cloudResult.sessionId,
        latencyMs: cloudResult.latencyMs,
      },
    };
  }
}
