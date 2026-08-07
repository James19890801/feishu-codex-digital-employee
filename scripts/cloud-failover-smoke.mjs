import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { CloudFailoverClient } from '../src/cloud-failover-client.mjs';
import { config } from '../src/config.mjs';

export async function runCloudFailoverSmoke(client, now = () => new Date()) {
  const at = now().toISOString();
  const heartbeat = await client.heartbeat({
    sequence: 1,
    at,
    serviceStartId: 'manual-smoke',
    dwsConnected: true,
    runtimeHealthy: true,
    lastMessageDigest: '',
    appVersion: '1.0.0',
    protocolVersion: '1',
  });
  const runtime = await client.execute({
    level: 'L0',
    prompt: '只回复 AIPR0S_CLOUD_OK',
    digest: '03869515a53e51803a38037c587845db2c6fe0e8b3c6820137475b9967213f4c',
    bytes: 25,
    purpose: 'manual_smoke',
  });
  if (runtime.text.trim() !== 'AIPR0S_CLOUD_OK') {
    throw new Error('Cloud failover smoke response did not match AIPR0S_CLOUD_OK');
  }
  return {
    ok: true,
    state: heartbeat.state,
    generation: heartbeat.generation,
    sessionId: runtime.sessionId,
    latencyMs: runtime.latencyMs,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!config.cloudFailoverEnabled) throw new Error('cloudFailoverEnabled must be true');
  const secret = execFileSync('/usr/bin/security', [
    'find-generic-password', '-a', config.cloudFailoverKeychainAccount,
    '-s', config.cloudFailoverKeychainService, '-w',
  ], { encoding: 'utf8' }).trim();
  const result = await runCloudFailoverSmoke(new CloudFailoverClient({
    baseUrl: config.cloudFailoverBaseUrl,
    nodeId: config.cloudFailoverNodeId,
    secret,
  }));
  console.log(JSON.stringify(result, null, 2));
}
