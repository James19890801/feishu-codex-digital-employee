import assert from 'node:assert/strict';
import {
  REQUIRED_RESPONSE_FALLBACK_REPLY,
  resolveRequiredResponse,
} from './required-response-fallback.mjs';

{
  const reply = await resolveRequiredResponse({
    responseRequired: true,
    generate: async () => { throw new Error('AI returned an empty response'); },
  });
  assert.deepEqual(reply, {
    text: REQUIRED_RESPONSE_FALLBACK_REPLY,
    fallback: true,
    error: 'AI returned an empty response',
  });
}

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
