import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const image = 'aipros-railway-failover:runtime-test';
const platform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';

const build = spawnSync('docker', ['build', '--platform', platform, '--tag', image, '.'], {
  cwd: new URL('.', import.meta.url), encoding: 'utf8', timeout: 10 * 60_000,
});
assert.equal(build.status, 0, `container build failed:\n${build.stderr.slice(-4_000)}`);

const version = spawnSync('docker', [
  'run', '--rm', '--platform', platform, '--entrypoint', 'dws', image, '--version',
], { encoding: 'utf8', timeout: 60_000 });
assert.equal(version.status, 0, `dws failed to start:\n${version.stderr.slice(-4_000)}`);
assert.match(version.stdout, /dws version/i);

const caBundle = spawnSync('docker', [
  'run', '--rm', '--platform', platform, '--entrypoint', 'sh', image,
  '-c', 'test -s /etc/ssl/certs/ca-certificates.crt',
], { encoding: 'utf8', timeout: 60_000 });
assert.equal(caBundle.status, 0, 'container is missing the system CA certificate bundle');

const authImport = spawnSync('docker', [
  'run', '--rm', '--platform', platform, '--entrypoint', 'dws', image,
  'auth', 'import', '--help',
], { encoding: 'utf8', timeout: 60_000 });
assert.equal(authImport.status, 0, `dws auth import is unavailable:\n${authImport.stderr.slice(-4_000)}`);
assert.match(authImport.stdout, /--base64/);

console.log('FAILOVER_CONTAINER_DWS_RUNTIME_TEST_OK');
