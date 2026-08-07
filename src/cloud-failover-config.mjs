function boundedInteger(value, fallback, { min, max, label }) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function normalizedOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('cloudFailoverBaseUrl must use HTTPS');
  if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('cloudFailoverBaseUrl must be an HTTPS origin');
  }
  return url.origin;
}

export function normalizeCloudFailoverConfig(raw = {}) {
  const cloudFailoverEnabled = raw.cloudFailoverEnabled === true;
  const cloudFailoverBaseUrl = normalizedOrigin(raw.cloudFailoverBaseUrl);
  const cloudFailoverNodeId = String(raw.cloudFailoverNodeId || '').trim();
  if (cloudFailoverEnabled && !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(cloudFailoverNodeId)) {
    throw new Error('cloudFailoverNodeId is required when cloud failover is enabled');
  }
  if (cloudFailoverEnabled && !cloudFailoverBaseUrl) {
    throw new Error('cloudFailoverBaseUrl is required when cloud failover is enabled');
  }
  return {
    cloudFailoverEnabled,
    cloudFailoverBaseUrl,
    cloudFailoverNodeId,
    cloudFailoverHeartbeatMs: boundedInteger(raw.cloudFailoverHeartbeatMs, 30_000, {
      min: 10_000, max: 60_000, label: 'cloudFailoverHeartbeatMs',
    }),
    cloudFailoverMissThreshold: boundedInteger(raw.cloudFailoverMissThreshold, 3, {
      min: 2, max: 10, label: 'cloudFailoverMissThreshold',
    }),
    cloudFailoverRecoveryThreshold: boundedInteger(raw.cloudFailoverRecoveryThreshold, 3, {
      min: 2, max: 10, label: 'cloudFailoverRecoveryThreshold',
    }),
    cloudFailoverLocalAttempts: boundedInteger(raw.cloudFailoverLocalAttempts, 3, {
      min: 1, max: 3, label: 'cloudFailoverLocalAttempts',
    }),
    cloudFailoverMaxPromptChars: boundedInteger(raw.cloudFailoverMaxPromptChars, 24_000, {
      min: 1_000, max: 40_000, label: 'cloudFailoverMaxPromptChars',
    }),
    cloudFailoverKeychainService: String(
      raw.cloudFailoverKeychainService || 'james-cloud-failover',
    ).trim(),
    cloudFailoverKeychainAccount: String(
      raw.cloudFailoverKeychainAccount || 'hmac-secret',
    ).trim(),
  };
}
