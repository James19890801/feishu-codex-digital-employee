import { compareSemanticTopics, semanticTopic } from './semantic-repeat-guard.mjs';

const QUESTION_PATTERN = /[?？]|(?:为什么|为何|如何|怎么|是否|能否|会不会|有没有|哪(?:个|些|里)|什么)/u;
const COUNTERARGUMENT_PATTERN = /(?:但是|然而|不过|反例|反驳|相反|质疑|未必|风险|隐患)/u;
const REASONING_PATTERN = /(?:因为|所以|因此|意味着|例如|比如|案例|证据|数据|建议|方案|关键|影响|决定|结论)/u;
const ACKNOWLEDGEMENT_PATTERN = /^(?:好(?:的)?|收到|明白|了解|赞同|同意|认可|行|可以|嗯|对)(?:了|的)?(?:[，,。.!！?？\s]*(?:我也)?(?:赞同|同意|认可))?[，,。.!！?？\s]*$/u;
const TERMINAL_HANDOFF_PATTERN = /(?=.*(?:确认|安排|等待|等))(?=.*(?:跟.{0,4}说|告诉|转达|发.{0,4}声|回复))/u;

function hasStructuredEvidence(topic) {
  return ['urls', 'issues', 'dates', 'numbers']
    .some(key => (topic?.signals?.[key] || []).length > 0);
}

export function evaluateDiscussionValue({ text, recentTopics = [] } = {}) {
  const source = String(text || '').trim();
  const topic = semanticTopic(source);
  const comparisons = recentTopics
    .filter(Boolean)
    .map(previous => compareSemanticTopics(previous, topic));
  const repeated = comparisons.some(result => result.repeat);
  const acknowledgement = ACKNOWLEDGEMENT_PATTERN.test(source);
  const terminalHandoff = TERMINAL_HANDOFF_PATTERN.test(source);
  const structuredEvidence = hasStructuredEvidence(topic);
  const counterargument = COUNTERARGUMENT_PATTERN.test(source);
  const question = QUESTION_PATTERN.test(source);
  const reasoning = REASONING_PATTERN.test(source);
  const compactLength = [...topic.normalized].length;
  const semanticNovelty = recentTopics.length > 0 && !repeated && compactLength >= 12;

  let score = 0;
  const reasons = [];
  if (structuredEvidence) {
    score += 3;
    reasons.push('structured_evidence');
  }
  if (counterargument) {
    score += 2;
    reasons.push('counterargument');
  }
  if (question) {
    score += 2;
    reasons.push('question');
  }
  if (reasoning) {
    score += 1;
    reasons.push('causal_reasoning');
  }
  if (semanticNovelty) {
    score += 2;
    reasons.push('semantic_novelty');
  }
  if (compactLength >= 24) {
    score += 1;
    reasons.push('substantive_length');
  }
  if (repeated) {
    score -= 4;
    reasons.push('semantic_repeat');
  }
  if (acknowledgement) {
    score -= 3;
    reasons.push('acknowledgement');
  }
  if (terminalHandoff) {
    score -= 3;
    reasons.push('terminal_handoff');
  }
  if (compactLength <= 12 && !structuredEvidence) {
    score -= 2;
    reasons.push('short_low_information');
  }

  return {
    substantive: score >= 2,
    score,
    reasons,
    topic,
    repeated,
  };
}
