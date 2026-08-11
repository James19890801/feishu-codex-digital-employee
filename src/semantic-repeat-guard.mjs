import { createHash } from 'node:crypto';

const RESET_PATTERN = /^(?:请)?(?:继续|展开|重新回答|重新说|再回答|补充|往下说|接着说|继续说)/u;
const LEADING_ACK_PATTERN = /^(?:收到|好的|好|可以|对|嗯|明白|了解|行)(?:了|的)?[，,。.!！?？:：;；\s]*/u;
const ISSUE_PATTERN = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/gu;
const URL_PATTERN = /https?:\/\/[^\s<>\])）]+/giu;
const DATE_PATTERN = /(?:\d{4}[年/.\-])?\d{1,2}[月/.\-]\d{1,2}(?:日|号)?/gu;
const NUMBER_PATTERN = /\d+(?:\.\d+)?%?/gu;
const CONFIRMATION_HANDOFF_PATTERN = /(?=.*(?:确认|安排|等待|等))(?=.*(?:跟.{0,4}说|告诉|转达|发.{0,4}声|回复))/u;
const LOW_INFORMATION_WORDS = new Set([
  '这个', '那个', '需要', '本人', '安排', '收到', '好的', '可以', '然后', '之后',
  '一下', '直接', '第一时间', '到时', '再', '往下', '一声', '帮', '您', '我', '了',
]);

function sortedUnique(values) {
  return [...new Set(values.map(value => String(value).toLowerCase()))].sort();
}

function stripMentions(text) {
  return String(text || '')
    .replace(/<at\b[^>]*>.*?<\/at>/giu, ' ')
    .replace(/<@[^>]+>/gu, ' ')
    .replace(/@[＠]?[\p{L}\p{N}_\- ]{1,40}(?=\s|$|[，,。.!！?？:：;；])/gu, ' ');
}

export function normalizeSemanticText(text) {
  return stripMentions(text)
    .trim()
    .replace(LEADING_ACK_PATTERN, '')
    .replace(/[\p{P}\p{S}\s]+/gu, '')
    .toLowerCase();
}

function extractSignals(text) {
  const source = stripMentions(text);
  const urls = sortedUnique(source.match(URL_PATTERN) || []);
  const issues = sortedUnique(source.match(ISSUE_PATTERN) || []);
  const dates = sortedUnique(source.match(DATE_PATTERN) || []);
  const redacted = source
    .replace(URL_PATTERN, ' ')
    .replace(ISSUE_PATTERN, ' ')
    .replace(DATE_PATTERN, ' ');
  const numbers = sortedUnique(redacted.match(NUMBER_PATTERN) || []);
  return { urls, issues, dates, numbers };
}

function keywords(text) {
  if (!text) return [];
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  return sortedUnique([...segmenter.segment(text)]
    .filter(item => item.isWordLike)
    .map(item => item.segment)
    .filter(word => word.length >= 2 && !LOW_INFORMATION_WORDS.has(word)));
}

function characterShingles(text, size = 2) {
  if (text.length < size) return text ? [text] : [];
  const values = [];
  for (let index = 0; index <= text.length - size; index += 1) {
    values.push(text.slice(index, index + size));
  }
  return sortedUnique(values);
}

function dice(leftValues, rightValues) {
  const left = new Set(leftValues);
  const right = new Set(rightValues);
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return (2 * intersection) / (left.size + right.size);
}

function signalsEqual(left, right) {
  return ['urls', 'issues', 'dates', 'numbers']
    .every(key => JSON.stringify(left?.[key] || []) === JSON.stringify(right?.[key] || []));
}

export function semanticTopic(text) {
  const withoutMentions = stripMentions(text).trim();
  const surface = withoutMentions.replace(/[\p{P}\p{S}\s]+/gu, '').toLowerCase();
  const normalized = normalizeSemanticText(withoutMentions);
  return {
    surface,
    normalized,
    signature: createHash('sha256').update(normalized).digest('hex'),
    signals: extractSignals(withoutMentions),
    resetRequested: RESET_PATTERN.test(withoutMentions.replace(LEADING_ACK_PATTERN, '').trim()),
    terminalIntent: CONFIRMATION_HANDOFF_PATTERN.test(normalized)
      ? 'confirmation_handoff'
      : '',
    keywords: keywords(normalized),
    shingles: characterShingles(normalized),
    anchors: characterShingles(normalized, 6),
  };
}

export function compareSemanticTopics(previous, current, {
  keywordThreshold = 0.72,
  shingleThreshold = 0.76,
  minFuzzyChars = 8,
} = {}) {
  if (!previous || !current || current.resetRequested) {
    return {
      repeat: false,
      similarity: 0,
      reason: current?.resetRequested ? 'explicit_reset' : 'missing_topic',
    };
  }
  if (!signalsEqual(previous.signals, current.signals)) {
    return { repeat: false, similarity: 0, reason: 'structured_signal_changed' };
  }
  if ((previous.surface && previous.surface === current.surface)
    || (previous.signature === current.signature && current.normalized)) {
    return { repeat: true, similarity: 1, reason: 'exact_normalized_match' };
  }
  if (previous.terminalIntent && previous.terminalIntent === current.terminalIntent) {
    return { repeat: true, similarity: 1, reason: 'terminal_intent_match' };
  }
  if (Math.min(previous.normalized?.length || 0, current.normalized?.length || 0) < minFuzzyChars) {
    return { repeat: false, similarity: 0, reason: 'short_message_fail_open' };
  }
  const keywordSimilarity = dice(previous.keywords || [], current.keywords || []);
  const shingleSimilarity = dice(previous.shingles || [], current.shingles || []);
  const sharedAnchor = (previous.anchors || []).some(value => (current.anchors || []).includes(value));
  const similarity = Math.max(keywordSimilarity, shingleSimilarity);
  const semanticRepeat = keywordSimilarity >= keywordThreshold
    || shingleSimilarity >= shingleThreshold
    || (sharedAnchor && shingleSimilarity >= 0.3);
  return {
    repeat: semanticRepeat,
    similarity,
    reason: semanticRepeat ? 'semantic_similarity' : 'new_topic',
  };
}
