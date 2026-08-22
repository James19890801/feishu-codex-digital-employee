import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertIsolatedSmokeScope,
  parseWechatReliabilitySmokeArgs,
  runWechatReliabilitySmoke,
} from './wechat-reliability-smoke.mjs';

const isolatedRoot = await mkdtemp(join(tmpdir(), 'aipro-wechat-smoke-'));
assert.deepEqual(parseWechatReliabilitySmokeArgs([
  '--isolated-root', isolatedRoot,
]), {
  isolatedRoot,
  controlledLive: false,
  confirmationToken: '',
});
assert.throws(() => parseWechatReliabilitySmokeArgs([]), /isolated-root/i);

assert.doesNotThrow(() => assertIsolatedSmokeScope({
  isolatedRoot,
  labels: ['test.aipro.main', 'test.aipro.tunnel'],
}));
assert.throws(() => assertIsolatedSmokeScope({
  isolatedRoot,
  labels: ['com.local.aipro-main'],
}), /production label/i);
assert.throws(() => assertIsolatedSmokeScope({
  isolatedRoot,
  labels: ['com.local.aipro-main'],
  controlledLive: true,
  confirmationToken: 'wrong',
  expectedConfirmationToken: 'expected',
}), /confirmation token/i);

const result = await runWechatReliabilitySmoke({ isolatedRoot });
assert.equal(result.ok, true);
assert.equal(result.ports.local > 0, true);
assert.equal(result.ports.metrics > 0, true);
assert.notEqual(result.ports.local, result.ports.metrics);

const expected = [
  ['local_service', 'reconcile_main_service', 'ok'],
  ['tunnel', 'reconcile_tunnel', 'ok'],
  ['public_callback', 'reconcile_tunnel', 'ok'],
  ['callback_registration', 'align_callback', 'ok'],
  ['tunnel', 'circuit_open', 'bounded'],
  ['release', 'rollback_release', 'ok'],
  ['all', 'confirm_healthy', 'ok'],
];
assert.deepEqual(
  result.report.map(item => [item.layer, item.action, item.result]),
  expected,
);
for (const item of result.report) {
  assert.deepEqual(Object.keys(item).sort(), ['action', 'elapsedMs', 'layer', 'result']);
  assert.equal(Number.isInteger(item.elapsedMs) && item.elapsedMs >= 0, true);
}
assert.equal(JSON.stringify(result.report).includes('secret'), false);
assert.equal(JSON.stringify(result.report).includes(isolatedRoot), false);

console.log('WECHAT_RELIABILITY_SMOKE_TEST_OK');
