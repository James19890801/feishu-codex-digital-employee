import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SqliteRelayStore } from './store.mjs';
import { parseParityConfig } from './parity-config.mjs';

export async function consumeShadowOnce({ store, enabled = false, now = Date.now() } = {}) {
  if (enabled !== true) return { leased: 0, parsed: 0, malformed: 0, acknowledged: 0, skipped: 'disabled' };
  const leader = store?.leadershipStatus?.();
  if (leader?.state !== 'CLOUD_ACTIVE' || leader?.owner !== 'cloud') {
    return { leased: 0, parsed: 0, malformed: 0, acknowledged: 0, skipped: 'not_cloud_leader' };
  }
  const lease = await store.lease({ now, leaseMs: 30_000, limit: 10 });
  let parsed = 0;
  let malformed = 0;
  for (const event of lease.events || []) {
    try { JSON.parse(String(event.body || '')); parsed += 1; } catch { malformed += 1; }
  }
  return { leased: (lease.events || []).length, parsed, malformed, acknowledged: 0, generation: leader.generation };
}

async function main() {
  const configPath = process.env.RELAY_CONFIG_PATH || '/etc/aipro-wechat-relay/config.json';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const parity = parseParityConfig(config);
  const store = new SqliteRelayStore({ databasePath: config.databasePath || '/var/lib/aipro-wechat-relay/events.sqlite',
    artifactDirectory: config.artifactDirectory || '/var/lib/aipro-wechat-relay/artifacts', parityEncryptionKey: parity.parityEncryptionKey });
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  while (!controller.signal.aborted) {
    const result = await consumeShadowOnce({ store, enabled: config.cloudConsumerEnabled === true });
    if (result.leased) process.stdout.write(`cloud_shadow_consumer leased=${result.leased} parsed=${result.parsed}\n`);
    await new Promise(resolve => setTimeout(resolve, result.leased ? 250 : 1_000));
  }
  store.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`cloud_consumer_fatal ${String(error?.message || error)}\n`); process.exitCode = 1; });
}
