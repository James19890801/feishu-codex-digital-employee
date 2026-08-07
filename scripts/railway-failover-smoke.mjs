import { pathToFileURL } from 'node:url';

function required(name, value) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function endpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

async function readJson(response, label) {
  let body;
  try { body = await response.json(); } catch { throw new Error(`${label} did not return JSON`); }
  if (!response.ok || body?.ok !== true) throw new Error(`${label} failed with HTTP ${response.status}`);
  return body;
}

export async function runRailwayFailoverSmoke({
  railwayUrl,
  coordinatorUrl,
  token,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  const railway = required('RAILWAY_PUBLIC_URL', railwayUrl);
  const coordinator = required('AIPROS_COORDINATOR_URL', coordinatorUrl);
  const runtimeToken = required('AIPROS_CONTAINER_TOKEN', token);
  const signal = AbortSignal.timeout(timeoutMs);
  const live = await readJson(await fetchImpl(endpoint(railway, '/live'), {
    method: 'GET', headers: { accept: 'application/json' }, signal,
  }), 'Railway liveness');
  const lease = await readJson(await fetchImpl(endpoint(coordinator, '/internal/runtime/lease'), {
    method: 'POST', body: '{}', signal,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${runtimeToken}`,
      'content-type': 'application/json',
    },
  }), 'Cloudflare runtime lease');
  return {
    ok: true,
    railway: { live: live.ok === true },
    coordinator: { state: String(lease.state || ''), generation: Number(lease.generation || 0) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runRailwayFailoverSmoke({
    railwayUrl: process.env.RAILWAY_PUBLIC_URL,
    coordinatorUrl: process.env.AIPROS_COORDINATOR_URL,
    token: process.env.AIPROS_CONTAINER_TOKEN,
  });
  console.log(JSON.stringify(result, null, 2));
}
