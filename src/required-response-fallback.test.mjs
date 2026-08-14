import assert from 'node:assert/strict';
import { resolveRequiredResponse } from './required-response-fallback.mjs';

await assert.rejects(
  () => resolveRequiredResponse({
    responseRequired: true,
    generate: async () => { throw new Error('AI returned an empty response'); },
  }),
  /AI returned an empty response/,
);

await assert.rejects(
  () => resolveRequiredResponse({
    responseRequired: false,
    generate: async () => { throw new Error('AI unavailable'); },
  }),
  /AI unavailable/,
);

{
  const reply = await resolveRequiredResponse({
    responseRequired: true,
    generate: async () => '正常回复',
  });
  assert.deepEqual(reply, { text: '正常回复', fallback: false, error: '' });
}

console.log('REQUIRED_RESPONSE_FALLBACK_TEST_OK');
