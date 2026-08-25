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
assert.equal(calls, 2);
assert.deepEqual(fallback, {
  text: REQUIRED_RESPONSE_FALLBACK_REPLY,
  fallback: true,
  error: 'AI unavailable',
});
assert.match(fallback.text, /(?:没有处理完成|请稍后重试|再发一次)/u);
assert.doesNotMatch(fallback.text, /(?:不用重复发|恢复后继续处理)/u);

let transientCalls = 0;
assert.deepEqual(await resolveRequiredResponse({
  responseRequired: true,
  generate: async () => {
    transientCalls += 1;
    if (transientCalls === 1) throw new Error('transient AI failure');
    return '第二次生成成功';
  },
}), {
  text: '第二次生成成功',
  fallback: false,
  error: '',
});
assert.equal(transientCalls, 2);

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
