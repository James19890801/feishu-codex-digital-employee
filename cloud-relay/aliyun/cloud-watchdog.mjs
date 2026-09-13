import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SqliteRelayStore } from './store.mjs';
import { parseParityConfig } from './parity-config.mjs';

const DIGEST = /^[a-f0-9]{64}$/;
const HEARTBEAT_MISS_MS = 90_000;

export async function assessCloudPromotion({ store, now = Date.now(), cloudReady = false } = {}) {
  const leader = store?.leadershipStatus?.();
  const heartbeat = store?.lastMainHeartbeat?.();
  const policy = store?.getCurrentPolicy?.();
  const cursor = store?.getPolicyCursor?.('mac');
  const reasons = [];
  if (!leader || leader.state !== 'LOCAL_PRIMARY' || leader.owner !== 'mac') reasons.push('local_not_primary');
  if (!heartbeat || heartbeat.generation !== leader?.generation) reasons.push('missing_current_main_heartbeat');
  if (!heartbeat?.channels?.wechat) reasons.push('last_main_wechat_unready');
  if (!DIGEST.test(String(policy?.digest || '')) || !policy?.revision) reasons.push('policy_unavailable');
  if (cursor?.digest !== policy?.digest || cursor?.sequence !== heartbeat?.criticalStateSequence) {
    reasons.push('policy_cursor_mismatch');
  }
  if (!heartbeat || now - heartbeat.receivedAt < HEARTBEAT_MISS_MS) reasons.push('main_heartbeat_fresh');
  if (cloudReady !== true) reasons.push('cloud_capability_unready');
  return { ready: reasons.length === 0, reasons };
}

export async function runCloudWatchdogOnce({ store, enabled = false, readinessProbe, now = Date.now() } = {}) {
  if (enabled !== true) return { promoted: false, reason: 'disabled' };
  if (typeof readinessProbe !== 'function') throw new TypeError('cloud_readiness_probe_required');
  const cloudReady = await readinessProbe();
  const assessment = await assessCloudPromotion({ store, now, cloudReady });
  if (!assessment.ready) return { promoted: false, reasons: assessment.reasons };
  const result = store.tryCloudTakeover({ now, cloudReady: true, missThresholdMs: HEARTBEAT_MISS_MS });
  return result.takenOver ? { promoted: true, state: result.state, generation: result.generation }
    : { promoted: false, reasons: ['promotion_rejected'] };
}

async function main() {
  const configPath = process.env.RELAY_CONFIG_PATH || '/etc/aipro-wechat-relay/config.json';
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const parity = parseParityConfig(config);
  const store = new SqliteRelayStore({ databasePath: config.databasePath || '/var/lib/aipro-wechat-relay/events.sqlite',
    artifactDirectory: config.artifactDirectory || '/var/lib/aipro-wechat-relay/artifacts',
    parityEncryptionKey: parity.parityEncryptionKey });
  const enabled = config.cloudWatchdogEnabled === true;
  // The worker is intentionally not capable until a concrete runtime probe is
  // provided. This keeps an installed watchdog from promoting a cloud that
  // cannot safely process a WeChat event.
  const readinessProbe = async () => config.cloudRuntimeReady === true;
  const interval = setInterval(async () => {
    const result = await runCloudWatchdogOnce({ store, enabled, readinessProbe });
    if (result.promoted) process.stdout.write(`cloud_watchdog_promoted g${result.generation}\n`);
  }, 5_000);
  interval.unref();
  await runCloudWatchdogOnce({ store, enabled, readinessProbe });
  await new Promise(resolve => process.once('SIGTERM', resolve));
  clearInterval(interval);
  store.close();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`cloud_watchdog_fatal ${String(error?.message || error)}\n`); process.exitCode = 1; });
}
