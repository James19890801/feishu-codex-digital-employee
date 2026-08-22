import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  namedTunnelArguments,
  readTunnelToken,
  superviseNamedTunnel,
} from './cloudflare-named-tunnel-supervisor.mjs';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.kills = [];
    this.killed = false;
  }

  kill(signal) {
    this.kills.push(signal);
    this.killed = true;
    return true;
  }
}

test('builds fixed IPv4 Named Tunnel arguments without a token', () => {
  assert.deepEqual(namedTunnelArguments({ metricsAddress: '127.0.0.1:17657' }), [
    'tunnel', '--no-autoupdate',
    '--edge-ip-version', '4',
    '--metrics', '127.0.0.1:17657',
    'run',
  ]);
  assert.throws(
    () => namedTunnelArguments({ metricsAddress: '0.0.0.0:17657' }),
    /metrics/i,
  );
  assert.throws(
    () => namedTunnelArguments({ metricsAddress: '127.0.0.1:99999' }),
    /metrics/i,
  );
});

test('reads the connector token from Keychain without putting it in arguments', async () => {
  const calls = [];
  const token = await readTunnelToken({
    service: 'com.example.aipro.tunnel',
    account: 'production',
    run: async (command, args) => {
      calls.push({ command, args });
      return { stdout: 'keychain-token-value\n' };
    },
  });
  assert.equal(token, 'keychain-token-value');
  assert.deepEqual(calls, [{
    command: '/usr/bin/security',
    args: ['find-generic-password', '-w', '-s', 'com.example.aipro.tunnel', '-a', 'production'],
  }]);
  assert.equal(JSON.stringify(calls).includes(token), false);
});

test('passes token only through TUNNEL_TOKEN and reports abnormal exit', async () => {
  const secret = 'keychain-token-value';
  const child = new FakeChild();
  const spawned = [];
  const logs = [];
  const processLike = new EventEmitter();
  processLike.env = { PATH: '/usr/bin' };
  processLike.exitCode = 0;
  const completion = superviseNamedTunnel({
    cloudflaredPath: '/opt/cloudflared',
    metricsAddress: '127.0.0.1:17657',
    readToken: async () => secret,
    spawnImpl: (command, args, options) => {
      spawned.push({ command, args, options });
      return child;
    },
    processLike,
    logger: {
      info: text => logs.push(String(text)),
      error: text => logs.push(String(text)),
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  child.stderr.emit('data', `connector failed near ${secret}`);
  child.emit('exit', 7, null);
  assert.equal(await completion, 7);
  assert.equal(processLike.exitCode, 7);
  assert.equal(spawned[0].options.env.TUNNEL_TOKEN, secret);
  assert.equal(JSON.stringify(spawned[0].args).includes(secret), false);
  assert.equal(logs.join('\n').includes(secret), false);
  assert.match(logs.join('\n'), /\[REDACTED\]/);
});

test('forwards termination signals and schedules bounded forced shutdown', async () => {
  const child = new FakeChild();
  const processLike = new EventEmitter();
  processLike.env = {};
  processLike.exitCode = 0;
  let scheduled;
  const completion = superviseNamedTunnel({
    cloudflaredPath: '/opt/cloudflared',
    metricsAddress: '127.0.0.1:17657',
    readToken: async () => 'token-value-with-enough-length',
    spawnImpl: () => child,
    processLike,
    logger: { info() {}, error() {} },
    schedule: callback => { scheduled = callback; return 123; },
    cancelSchedule() {},
  });
  await new Promise(resolve => setImmediate(resolve));
  processLike.emit('SIGTERM');
  assert.deepEqual(child.kills, ['SIGTERM']);
  scheduled();
  assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
  child.emit('exit', 0, 'SIGTERM');
  assert.equal(await completion, 0);
});

console.log('CLOUDFLARE_NAMED_TUNNEL_SUPERVISOR_TEST_OK');
