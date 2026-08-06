import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./index.mjs', import.meta.url), 'utf8');
const intakeCall = source.indexOf('await handleA1Requirement(message, senderOpenId, cleanText, metadata)');
const greetingGate = source.indexOf('if (shouldIntroduceAssistant({');
assert.ok(intakeCall >= 0, 'runtime must invoke the A1 intake helper');
assert.ok(intakeCall < greetingGate, 'A1 intake must run before the first-contact greeting');

const helperStart = source.indexOf('async function handleA1Requirement(');
const helperEnd = source.indexOf('\n}\n', helperStart);
const helper = source.slice(helperStart, helperEnd);
for (const token of ['history: formatHistory(', 'requester:', 'metadata,']) {
  assert.match(helper, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

console.log('a1-runtime-wiring tests passed');
