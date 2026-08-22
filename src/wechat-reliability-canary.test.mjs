import assert from 'node:assert/strict';
import {
  CANARY_PATH,
  createCanaryChallenge,
  createCanaryResponse,
  verifyCanaryChallenge,
} from './wechat-reliability-canary.mjs';

const secret = 's'.repeat(32);

{
  const challenge = createCanaryChallenge({ secret, nowMs: 10_000, nonce: 'abc' });
  assert.deepEqual(Object.keys(challenge).sort(), ['nonce', 'signature', 'timestamp']);
  assert.equal(verifyCanaryChallenge(challenge, { secret, nowMs: 10_500 }).ok, true);
  assert.equal(verifyCanaryChallenge({ ...challenge, signature: 'bad' }, {
    secret,
    nowMs: 10_500,
  }).ok, false);
  assert.equal(verifyCanaryChallenge(challenge, { secret, nowMs: 80_000 }).reason, 'expired');
  assert.equal(verifyCanaryChallenge(challenge, { secret, nowMs: -60_001 }).reason, 'not_yet_valid');
}

{
  assert.throws(
    () => createCanaryChallenge({ secret: 'short', nowMs: 1, nonce: 'abc' }),
    /secret/i,
  );
  assert.throws(
    () => createCanaryChallenge({ secret, nowMs: 1, nonce: 'x'.repeat(129) }),
    /nonce/i,
  );
  assert.deepEqual(verifyCanaryChallenge({
    timestamp: 'not-a-number',
    nonce: 'abc',
    signature: 'a'.repeat(64),
  }, { secret, nowMs: 1 }), { ok: false, reason: 'malformed' });
}

{
  const challenge = createCanaryChallenge({ secret, nowMs: 10_000, nonce: 'private-nonce' });
  const response = createCanaryResponse(challenge, { nowMs: 10_500 });
  assert.deepEqual(response, {
    ok: true,
    nonceDigest: '8ba0e653af82060f831e5a8db63199d7c306d47023a3a13556162bcecf1f8567',
    at: '1970-01-01T00:00:10.500Z',
  });
  assert.equal(JSON.stringify(response).includes('private-nonce'), false);
  assert.equal(JSON.stringify(response).includes(challenge.signature), false);
  assert.equal(CANARY_PATH.includes('webhooks/gewe'), false);
}

console.log('WECHAT_RELIABILITY_CANARY_TEST_OK');
