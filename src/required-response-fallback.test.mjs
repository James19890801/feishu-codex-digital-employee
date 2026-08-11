import assert from 'node:assert/strict';
import {
  REQUIRED_RESPONSE_FALLBACK_REPLY,
  resolveRequiredResponse,
} from './required-response-fallback.mjs';

let calls = 0;
const fallback = await resolveRequiredResponse({
  responseRequired: true,
  generate: async () => {
    calls += 1;
    throw new Error('AI unavailable');
  },
});
assert.equal(calls, 1);
assert.deepEqual(fallback, {
  text: REQUIRED_RESPONSE_FALLBACK_REPLY,
  fallback: true,
  error: 'AI unavailable',
});
assert.equal(
  fallback.text,
  '收到，这条我先接住。刚才回复生成失败了，你不用重复发，我恢复后继续处理。',
);

await assert.rejects(
  () => resolveRequiredResponse({
    responseRequired: false,
    generate: async () => { throw new Error('ordinary failure'); },
  }),
  /ordinary failure/,
);

assert.deepEqual(await resolveRequiredResponse({
  responseRequired: true,
  generate: async () => '正常回复',
}), {
  text: '正常回复',
  fallback: false,
  error: '',
});

console.log('REQUIRED_RESPONSE_FALLBACK_TEST_OK');
