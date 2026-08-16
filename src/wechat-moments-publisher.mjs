import {
  abstractPrivateKnowledge,
  isSafeKnowledgeEvidence,
} from './local-wiki-policy.mjs';
import {
  hasLongVerbatimOverlap,
  protectedKnowledgeLeak,
} from './privacy-boundary.mjs';
import {
  compareSemanticTopics,
  semanticTopic,
} from './semantic-repeat-guard.mjs';

const SHANGHAI_OFFSET = '+08:00';

function boundedText(value, maxLength = 500) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength);
}

export function shanghaiDayKey(nowMs = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

function atShanghai(day, time) {
  return Date.parse(`${day}T${time}:00${SHANGHAI_OFFSET}`);
}

function randomMinute(startMs, endMs, random) {
  const minutes = Math.max(1, Math.floor((endMs - startMs) / 60_000));
  const unit = Math.max(0, Math.min(0.999999, Number(random()) || 0));
  return startMs + Math.floor(unit * minutes) * 60_000;
}

function slot(id, atMs, endMs) {
  return {
    id,
    atMs,
    endMs,
    status: 'pending',
    attempts: 0,
    nextAttemptAtMs: atMs,
  };
}

export function planMomentsDay({
  nowMs = Date.now(),
  activatedAtMs = 0,
  random = Math.random,
} = {}) {
  const day = shanghaiDayKey(nowMs);
  const windows = [
    { id: 'morning', startMs: atShanghai(day, '10:00'), endMs: atShanghai(day, '12:00') },
    { id: 'evening', startMs: atShanghai(day, '18:30'), endMs: atShanghai(day, '21:00') },
  ];
  if (!activatedAtMs) {
    const dayEndMs = atShanghai(day, '23:59') + 59_000;
    const remaining = [...windows].reverse().find(window => window.endMs > nowMs);
    return {
      day,
      activatedAtMs: nowMs,
      slots: [
        slot('activation', nowMs, Math.min(dayEndMs, nowMs + 60 * 60_000)),
        ...(remaining
          ? [slot(remaining.id, randomMinute(
              Math.max(remaining.startMs, nowMs + 5 * 60_000),
              remaining.endMs,
              random,
            ), remaining.endMs)]
          : []),
      ].slice(0, 2),
    };
  }
  return {
    day,
    activatedAtMs,
    slots: windows.map(window => slot(
      window.id,
      randomMinute(window.startMs, window.endMs, random),
      window.endMs,
    )),
  };
}

function parsedJson(value) {
  try {
    const parsed = JSON.parse(String(value || '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseGeneratedMomentsPost(raw, {
  knowledge = '',
  history = [],
} = {}) {
  const parsed = parsedJson(raw);
  const topic = boundedText(parsed?.topic, 60);
  const content = boundedText(parsed?.content, 500);
  const evidence = String(knowledge || '').trim();
  if (!topic || topic.length < 2 || content.length < 100 || content.length > 220) return null;
  if (!evidence || !isSafeKnowledgeEvidence(evidence)) return null;
  if (protectedKnowledgeLeak(content)
    || hasLongVerbatimOverlap(content, [evidence], { minimumChars: 80 })) return null;
  const abstracted = abstractPrivateKnowledge(content);
  if (!abstracted.safe || abstracted.redactionCount > 0 || abstracted.text !== content) return null;
  const current = semanticTopic(content);
  const repeated = (Array.isArray(history) ? history : [])
    .some(previous => compareSemanticTopics(semanticTopic(previous), current).repeat);
  if (repeated) return null;
  return { topic, content };
}
