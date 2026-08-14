import assert from 'node:assert/strict';
import {
  classifyRuntimeFailure,
  evaluateCloudEligibility,
  sanitizeCloudPrompt,
} from './cloud-failover-policy.mjs';

for (const [message, expectedCode] of [
  ['process timed out after 40000ms', 'timeout'],
  ['Codex CLI failed: process exited with code 1', 'process_failure'],
  ['Qoder CLI returned an empty response', 'empty_response'],
  ['fetch failed: ECONNRESET', 'network_failure'],
]) {
  assert.deepEqual(classifyRuntimeFailure(new Error(message)), {
    retryable: true,
    code: expectedCode,
  });
}
assert.deepEqual(classifyRuntimeFailure(new Error('permission denied by owner policy')), {
  retryable: false,
  code: 'non_runtime_failure',
});
assert.deepEqual(classifyRuntimeFailure({ code: 'BUSINESS_VALIDATION_FAILED' }), {
  retryable: false,
  code: 'non_runtime_failure',
});

assert.deepEqual(evaluateCloudEligibility({
  level: 'L0',
  prompt: '请帮我把这句话写得更自然',
  images: [],
}), { eligible: true, reason: 'eligible' });

for (const [input, reason] of [
  [{ level: 'L2', prompt: '创建日程' }, 'risk_level'],
  [{ level: 'L0', prompt: '看图', images: ['/tmp/a.png'] }, 'image'],
  [{ level: 'L0', prompt: '读附件', attachments: ['a.pdf'] }, 'attachment'],
  [{ level: 'L0', prompt: '确认发送', pendingConfirmation: true }, 'pending_confirmation'],
  [{ level: 'L0', prompt: '执行写入', mutationIntent: true }, 'mutation_intent'],
  [{ level: 'L0', prompt: '总结邮件', sourceKind: 'mail' }, 'sensitive_source'],
  [{ level: 'L0', prompt: 'Authorization: Bearer sk-this-is-a-secret-value' }, 'credential'],
  [{ level: 'L0', prompt: 'a'.repeat(24_001), maxPromptChars: 24_000 }, 'prompt_too_large'],
]) {
  assert.deepEqual(evaluateCloudEligibility(input), { eligible: false, reason });
}

const sanitized = sanitizeCloudPrompt(
  '读取 /Users/alice/private/report.txt，然后访问 https://example.com/a?token=abc&x=1；'
    + '联系电话 13812345678；Authorization: Bearer bearer-secret-value；marker cloud-channel-9',
  {
    forbiddenValues: ['cloud-channel-9'],
    ownerPhone: '13812345678',
    maxChars: 24_000,
  },
);
assert.equal(sanitized.text.includes('/Users/alice'), false);
assert.equal(sanitized.text.includes('token=abc'), false);
assert.equal(sanitized.text.includes('13812345678'), false);
assert.equal(sanitized.text.includes('bearer-secret-value'), false);
assert.equal(sanitized.text.includes('cloud-channel-9'), false);
assert.match(sanitized.text, /\[REDACTED_LOCAL_PATH\]/);
assert.match(sanitized.text, /https:\/\/example\.com\/a\?\[REDACTED_QUERY\]/);
assert.match(sanitized.digest, /^[a-f0-9]{64}$/);
assert.equal(sanitized.bytes, Buffer.byteLength(sanitized.text, 'utf8'));

assert.throws(
  () => sanitizeCloudPrompt('x'.repeat(101), { maxChars: 100 }),
  error => error?.code === 'cloud_prompt_too_large',
);

console.log('CLOUD_FAILOVER_POLICY_TEST_OK');
