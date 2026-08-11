import assert from 'node:assert/strict';
import {
  annotateAlibabaLanguage,
  formatAlibabaLanguageAnnotations,
} from './alibaba-language.mjs';

const positiveCases = [
  ['招一个6', /P6/],
  ['这个同学是7', /P7/],
  ['5晋6', /P5.*P6/],
  ['P8向9汇报', /P8.*P9|P9/],
  ['这个HC要几级，先按7看', /P7/],
  ['这个岗位要个9', /P9/],
];

for (const [text, expected] of positiveCases) {
  const result = annotateAlibabaLanguage(text);
  assert.match(result.annotations.join('\n'), expected, text);
  assert.equal(result.ambiguous, false, text);
}

for (const text of [
  '8月9日上线',
  '预算9万',
  '需要6个人',
  'V7版本发布',
  '跑5分钟',
  '需求84886503现在怎样',
  '看第9页',
  '接口返回8条数据',
]) {
  const result = annotateAlibabaLanguage(text);
  assert.doesNotMatch(result.annotations.join('\n'), /P[5-9]/, text);
  assert.equal(result.ambiguous, false, text);
}

const ambiguous = annotateAlibabaLanguage('按7来');
assert.deepEqual(ambiguous.annotations, []);
assert.equal(ambiguous.ambiguous, true);

const contextual = annotateAlibabaLanguage('按7来', [
  { direction: 'counterparty', content: '这个岗位定什么层级？' },
]);
assert.match(contextual.annotations.join('\n'), /P7/);
assert.equal(contextual.ambiguous, false);

const glossary = annotateAlibabaLanguage('这个链路的卡点要对焦，明确 owner 后倒排，最后复盘沉淀');
const glossaryText = glossary.annotations.join('\n');
for (const expected of ['链路', '卡点', '对焦', 'owner', '倒排', '复盘', '沉淀']) {
  assert.match(glossaryText, new RegExp(expected, 'i'));
}

const formatted = formatAlibabaLanguageAnnotations(annotateAlibabaLanguage('这个同学是6，要拿结果并闭环'));
assert.match(formatted, /阿里语境注释/);
assert.match(formatted, /P6/);
assert.match(formatted, /拿结果/);
assert.match(formatted, /闭环/);

const none = formatAlibabaLanguageAnnotations({ annotations: [], ambiguous: false });
assert.equal(none, '阿里语境注释：\n（本轮没有需要补充的企业语义）');

console.log('ALIBABA_LANGUAGE_TEST_OK');
