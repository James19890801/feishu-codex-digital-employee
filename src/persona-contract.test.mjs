import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const [persona, bible, indexSource] = await Promise.all([
  readFile(`${root}/templates/PERSONA.example.md`, 'utf8'),
  readFile(`${root}/templates/BIBLE.example.md`, 'utf8'),
  readFile(`${root}/src/index.mjs`, 'utf8'),
]);

assert.match(persona, /专业判断[^\n]*理性/);
assert.match(persona, /不迎合、不讨好/);
assert.match(persona, /有温度/);
assert.match(persona, /金字塔原理/);
assert.match(bible, /## 1\.2 专业纠错与证据标准/);
assert.match(bible, /结论 → 关键错误与证据 → 正确框架或答案 → 必要建议/);
assert.match(bible, /不攻击人格/);
assert.match(bible, /不为了显得犀利而强行反对/);
assert.match(bible, /权威来自事实、推理和可验证性/);
assert.match(indexSource, /\$\{PERSONA_TEXT\}[\s\S]*\$\{BIBLE_TEXT\}/);

console.log('PERSONA_CONTRACT_TEST_OK');
