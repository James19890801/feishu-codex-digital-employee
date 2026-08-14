import { redactLearningText } from './daily-learning.mjs';

function normalizedText(value, maxLength) {
  return redactLearningText(value).replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function normalizedDate(value) {
  const date = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Accepted learning requires a YYYY-MM-DD learning date');
  }
  return date;
}

export function applyAcceptedLearning(state, {
  learningDate,
  summary = '',
  acceptedChanges = [],
  memoryRules = [],
} = {}) {
  if (!state || typeof state.get !== 'function' || typeof state.set !== 'function'
    || typeof state.audit !== 'function') {
    throw new Error('Accepted learning requires persistent AgentState');
  }
  const date = normalizedDate(learningDate);
  const changes = (Array.isArray(acceptedChanges) ? acceptedChanges : []).map(change => ({
    category: normalizedText(change?.category || 'response', 80),
    problem: normalizedText(change?.problem, 300),
    action: normalizedText(change?.action, 500),
    verification: normalizedText(change?.verification, 300),
  })).filter(change => change.problem && change.action && change.verification).slice(0, 12);
  const rules = [...new Set((Array.isArray(memoryRules) ? memoryRules : [])
    .map(rule => normalizedText(rule, 500)).filter(Boolean))].slice(0, 30);
  if (!changes.length || !rules.length) {
    throw new Error('Accepted learning requires at least one accepted change and runtime rule');
  }

  const priorMemory = String(state.get('learning', 'memory', '') || '').trim();
  const newRules = rules.filter(rule => !priorMemory.includes(rule));
  const section = newRules.length
    ? [`已接受并生效的改进（${date}）：`, ...newRules.map((rule, index) => `${index + 1}. ${rule}`)].join('\n')
    : '';
  const memory = [priorMemory, section].filter(Boolean).join('\n\n').slice(-12_000);
  const accepted = changes.map(change => ({ ...change }));

  state.set('learning', 'memory', memory);
  state.set('learning', 'last_applied_date', date);
  state.set('learning', 'last_applied_summary', normalizedText(summary, 2_000));
  state.set('learning', 'last_applied_changes', accepted);
  state.audit('daily_learning_changes_applied', {
    detail: {
      learningDate: date,
      acceptedCount: accepted.length,
      ruleCount: rules.length,
      categories: [...new Set(accepted.map(change => change.category))],
    },
  });
  return {
    applied: true,
    learningDate: date,
    acceptedCount: accepted.length,
    ruleCount: rules.length,
    memoryUpdated: newRules.length > 0,
  };
}
