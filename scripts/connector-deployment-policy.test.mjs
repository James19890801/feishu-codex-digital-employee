import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveStandaloneConnector } from './connector-deployment-policy.mjs';

async function executable(path) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(path, 0o755);
  return path;
}

const fixture = await mkdtemp(join(tmpdir(), 'james-connector-policy-'));
const explicit = await executable(join(fixture, 'standalone', 'connector'));
assert.equal(
  await resolveStandaloneConnector({ explicitPath: explicit, home: fixture }),
  await realpath(resolve(explicit)),
);

const standard = await executable(join(fixture, '.npm-global', 'bin', 'connector'));
assert.equal(await resolveStandaloneConnector({ home: fixture }), await realpath(resolve(standard)));

await assert.rejects(
  () => resolveStandaloneConnector({ home: join(fixture, 'missing-home') }),
  /standalone CONNECTOR/i,
);

const bundled = await executable(join(fixture, '.real', '.bin', 'connector', 'bin', 'connector'));
await assert.rejects(
  () => resolveStandaloneConnector({ explicitPath: bundled, home: fixture }),
  /LegacyBridge is not allowed/i,
);

const namedLegacyBridge = await executable(join(fixture, 'bin', 'legacyBridge-connector'));
await assert.rejects(
  () => resolveStandaloneConnector({ explicitPath: namedLegacyBridge, home: fixture }),
  /LegacyBridge is not allowed/i,
);

console.log('CONNECTOR_DEPLOYMENT_POLICY_TEST_OK');
