import { evaluateEntitlement, verifyEnvelope } from './crypto.mjs';
import { LicensingStore } from './store.mjs';

const CLOCK_SKEW_MS = 5 * 60 * 1000;

export async function evaluateLicenseGuard({
  enforced = false,
  store = null,
  publicKey = '',
  product = 'James',
  now = new Date(),
} = {}) {
  if (!enforced) {
    return {
      allowed: true,
      enforced: false,
      edition: 'Development',
      issuerAuthorized: false,
    };
  }
  const secretStore = store || new LicensingStore();
  const current = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(current.getTime())) {
    return { allowed: false, enforced: true, reason: 'invalid_clock' };
  }
  try {
    const clockState = typeof secretStore.loadClockState === 'function'
      ? await secretStore.loadClockState()
      : null;
    const lastSeen = clockState?.lastSeenAt ? Date.parse(clockState.lastSeenAt) : 0;
    if (Number.isFinite(lastSeen) && lastSeen > current.getTime() + CLOCK_SKEW_MS) {
      return { allowed: false, enforced: true, reason: 'clock_rollback' };
    }
    const device = await secretStore.ensureDeviceIdentity();
    const token = await secretStore.loadEntitlement();
    if (!token) return { allowed: false, enforced: true, reason: 'activation_required' };
    let entitlement;
    try {
      entitlement = verifyEnvelope(token, publicKey);
    } catch {
      return { allowed: false, enforced: true, reason: 'invalid_entitlement' };
    }
    const evaluation = evaluateEntitlement(entitlement, {
      product,
      deviceKeyHash: device.keyHash,
      now: current,
    });
    if (!evaluation.valid) {
      return { allowed: false, enforced: true, reason: evaluation.reason };
    }
    if (typeof secretStore.saveClockState === 'function') {
      await secretStore.saveClockState({ lastSeenAt: current.toISOString() });
    }
    return {
      allowed: true,
      enforced: true,
      edition: entitlement.edition || 'Business',
      issuerAuthorized: entitlement.edition === 'Founder',
      licenseId: entitlement.licenseId,
      expiresAt: entitlement.expiresAt,
    };
  } catch {
    return { allowed: false, enforced: true, reason: 'licensing_storage_error' };
  }
}

export async function runGuardedStartup({ guard, initialize, onBlocked = async () => {} }) {
  const decision = await guard();
  if (!decision.allowed) {
    await onBlocked(decision);
    return { started: false, decision };
  }
  await initialize(decision);
  return { started: true, decision };
}

export function waitForTerminationSignals() {
  return new Promise(resolve => {
    const finish = signal => resolve(signal);
    process.once('SIGTERM', () => finish('SIGTERM'));
    process.once('SIGINT', () => finish('SIGINT'));
  });
}
