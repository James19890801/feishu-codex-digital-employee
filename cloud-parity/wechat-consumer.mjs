function relayOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') {
    throw new Error('invalid_relay_origin');
  }
  return url.origin;
}

async function request(fetchImpl, url, token, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, ...(options.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`relay_http_${response.status}`);
  return response.json();
}

// The consumer deliberately acks only outcomes which have reached a durable
// terminal state. An ambiguous provider result remains in the relay queue and
// is reconciled by the outbox, never retried blindly.
export async function consumeWechatOnce({ relayOrigin: baseUrl, relayToken, processEvent,
  fetchImpl = fetch, leaseMs = 30_000, limit = 10 } = {}) {
  const origin = relayOrigin(baseUrl);
  const token = String(relayToken || '');
  if (token.length < 24 || typeof processEvent !== 'function') throw new Error('invalid_cloud_consumer');
  const status = await request(fetchImpl, `${origin}/relay/status`, token);
  const leader = status?.leadership;
  if (!leader || leader.state !== 'CLOUD_ACTIVE' || leader.owner !== 'cloud') {
    return { leased: 0, acknowledged: 0, skipped: 'not_cloud_leader' };
  }
  const leased = await request(fetchImpl, `${origin}/relay/lease`, token, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ leaseMs, limit }),
  });
  const ids = [];
  let ambiguous = 0;
  for (const item of Array.isArray(leased.events) ? leased.events : []) {
    try {
      const outcome = await processEvent(item, leader.generation);
      if (['replied', 'skipped', 'duplicate', 'fenced'].includes(outcome?.outcome)) ids.push(String(item.id));
      else ambiguous += 1;
    } catch { ambiguous += 1; }
  }
  let acknowledged = 0;
  if (ids.length) {
    const ack = await request(fetchImpl, `${origin}/relay/ack`, token, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids }),
    });
    acknowledged = Number(ack.acked) || 0;
  }
  return { leased: Array.isArray(leased.events) ? leased.events.length : 0, acknowledged, ambiguous };
}
