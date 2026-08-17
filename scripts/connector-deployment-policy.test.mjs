import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as connectorPolicy from './connector-deployment-policy.mjs';

const { bundledDwsPath, resolveStandaloneConnector, resolveStandaloneDws } = connectorPolicy;
assert.equal(typeof resolveStandaloneDws, 'function');
assert.equal(typeof bundledDwsPath, 'function');

async function executable(path) {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmod(path, 0o755);
  return path;
}

const fixture = await mkdtemp(join(tmpdir(), 'james-dws-policy-'));
const explicit = await executable(join(fixture, 'standalone', 'dws'));
assert.equal(
  await resolveStandaloneDws({ explicitPath: explicit, home: fixture }),
  await realpath(resolve(explicit)),
);

const installRoot = join(fixture, 'application');
assert.equal(
  bundledDwsPath(installRoot, 'win32'),
  join(installRoot, 'node_modules', 'dingtalk-workspace-cli', 'vendor', 'dws.exe'),
);
const bundled = await executable(join(
  installRoot, 'node_modules', 'dingtalk-workspace-cli', 'vendor', 'dws',
));
assert.equal(
  await resolveStandaloneDws({ home: fixture, installRoot }),
  await realpath(resolve(bundled)),
);

const standard = await executable(join(fixture, '.npm-global', 'bin', 'dws'));
assert.equal(await resolveStandaloneDws({ home: fixture }), await realpath(resolve(standard)));

await assert.rejects(
  () => resolveStandaloneDws({ home: join(fixture, 'missing-home') }),
  /standalone DWS/i,
);

const legacy = await executable(join(fixture, '.real', '.bin', 'dws', 'bin', 'dws'));
await assert.rejects(
  () => resolveStandaloneDws({ explicitPath: legacy, home: fixture }),
  /Wukong is not allowed/i,
);

const namedWukong = await executable(join(fixture, 'bin', 'Wukong-dws'));
await assert.rejects(
  () => resolveStandaloneDws({ explicitPath: namedWukong, home: fixture }),
  /Wukong is not allowed/i,
);

assert.equal(
  await resolveStandaloneConnector({ explicitPath: explicit, home: fixture }),
  await realpath(resolve(explicit)),
);

console.log('CONNECTOR_DEPLOYMENT_POLICY_TEST_OK');
