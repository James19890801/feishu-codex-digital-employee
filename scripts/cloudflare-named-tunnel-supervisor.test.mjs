import assert from 'node:assert/strict';
import test from 'node:test';

import { namedTunnelArguments } from './cloudflare-named-tunnel-supervisor.mjs';

test('forces IPv4 HTTP2 named tunnel transport with loopback metrics', () => {
  assert.deepEqual(namedTunnelArguments({ metricsAddress: '127.0.0.1:17657' }), [
    'tunnel', '--no-autoupdate', '--protocol', 'http2', '--edge-ip-version', '4',
    '--metrics', '127.0.0.1:17657', 'run',
  ]);
});

test('rejects non-loopback metrics binding', () => {
  assert.throws(() => namedTunnelArguments({ metricsAddress: '0.0.0.0:17657' }), /loopback/);
});
