import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';

import {
  artifactKeyFromPath,
  authorizeBearer,
  callbackPathMatches,
  digestBytes,
  verifyCanaryRequest,
} from './contract.mjs';

test('matches only the exact secret callback path', () => {
  assert.equal(callbackPathMatches('/webhooks/gewe/abc_DEF-123', 'abc_DEF-123'), true);
  assert.equal(callbackPathMatches('/webhooks/gewe/abc_DEF-123/extra', 'abc_DEF-123'), false);
  assert.equal(callbackPathMatches('/webhooks/gewe/wrong', 'abc_DEF-123'), false);
});

test('accepts an exact bearer token and rejects malformed authorization', () => {
  const token = 'relay-secret-abcdefghijkl';
  assert.equal(authorizeBearer(`Bearer ${token}`, token), true);
  assert.equal(authorizeBearer(`bearer ${token}`, token), false);
  assert.equal(authorizeBearer(`Bearer ${token}-more`, token), false);
});

test('creates a stable sha256 digest for raw webhook bytes', async () => {
  assert.equal(
    await digestBytes(new TextEncoder().encode('{"a":1}')),
    '015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862',
  );
});

test('accepts only bounded artifact routes', () => {
  assert.equal(
    artifactKeyFromPath('/webhooks/gewe/callback/artifacts/abcdefghijklmnopqrstuvwx/file.pdf', 'callback'),
    'abcdefghijklmnopqrstuvwx',
  );
  assert.equal(artifactKeyFromPath('/webhooks/gewe/callback/artifacts/short/file.pdf', 'callback'), null);
  assert.equal(artifactKeyFromPath('/webhooks/gewe/wrong/artifacts/abcdefghijklmnopqrstuvwx/file.pdf', 'callback'), null);
});

test('verifies signed canary requests and returns the nonce digest', async () => {
  const secret = 'c'.repeat(48);
  const timestamp = '1789142400000';
  const nonce = 'nonce_123';
  const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}`).digest('hex');
  const result = await verifyCanaryRequest({ timestamp, nonce, signature }, {
    secret,
    nowMs: Number(timestamp) + 1_000,
  });
  assert.equal(result.ok, true);
  assert.equal(result.response.nonceDigest, 'a9ebf745cd53369381ec7953e692eab98d84e5ef20c544c2da83f6f67d29e863');
});

test('rejects expired canary requests', async () => {
  const secret = 'd'.repeat(48);
  const timestamp = '1789142400000';
  const nonce = 'nonce_456';
  const signature = createHmac('sha256', secret).update(`${timestamp}.${nonce}`).digest('hex');
  const result = await verifyCanaryRequest({ timestamp, nonce, signature }, {
    secret,
    nowMs: Number(timestamp) + 60_001,
  });
  assert.deepEqual(result, { ok: false, reason: 'expired' });
});
