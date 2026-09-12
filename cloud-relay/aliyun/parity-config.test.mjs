import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseParityConfig } from './parity-config.mjs';

test('parity stays disabled when no dedicated secrets are present', () => {
  assert.deepEqual(parseParityConfig({}), { parityToken: undefined, parityEncryptionKey: undefined });
});

test('parity requires both a long token and a 32-byte encryption key', () => {
  const key = Buffer.alloc(32, 7);
  assert.deepEqual(parseParityConfig({ parityToken: 'x'.repeat(48),
    parityEncryptionKeyBase64: key.toString('base64') }),
  { parityToken: 'x'.repeat(48), parityEncryptionKey: key });
  assert.throws(() => parseParityConfig({ parityToken: 'x'.repeat(48) }), /incomplete/i);
  assert.throws(() => parseParityConfig({ parityToken: 'short',
    parityEncryptionKeyBase64: key.toString('base64') }), /invalid/i);
});
