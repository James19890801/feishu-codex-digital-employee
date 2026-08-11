const ACTIONS = new Set([
  'answer',
  'list',
  'get',
  'activity',
  'create',
  'update',
  'comment',
  'follow',
  'unfollow',
  'sync_here',
  'stop_sync',
]);
const CATEGORIES = new Set(['req', 'bug', 'task']);
const SCOPES = new Set(['personal', 'project', 'team', 'all', 'collect', 'associate', 'child']);
const CREATE_FIELDS = new Set([
  'category', 'type', 'title', 'body', 'assignee', 'status', 'sprint', 'module',
  'version', 'tag', 'priority', 'severity',
]);
const UPDATE_FIELDS = new Set([
  'title', 'body', 'assignee', 'status', 'sprint', 'module', 'version', 'tag',
  'priority', 'severity', 'tracker', 'participant', 'verifier', 'relatedSpace',
]);
const CREDENTIAL_PATTERN = /(?:sk-[A-Za-z0-9_-]{20,}|(?:access|refresh|id)[_-]?token\s*[:=]|(?:buc|pat|password|passwd|secret)\s*[:=]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/i;

export function looksLikeA1Request(value) {
  return /\bA1\b|\b1A\b|(?:工作项|需求池|研发需求|研发缺陷).{0,18}(?:查|看|创建|新建|更新|修改|评论|跟进|同步)|(?:查|看|创建|新建|更新|修改|评论|跟进|同步).{0,18}(?:工作项|需求池|A1|1A)/i
    .test(String(value || ''));
}

function text(value, name, maxLength, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${name} is required`);
    return '';
  }
  const normalized = String(value).trim();
  if (required && !normalized) throw new Error(`${name} is required`);
  if (normalized.length > maxLength || /\u0000/.test(normalized)) {
    throw new Error(`${name} is invalid or too long`);
  }
  if (CREDENTIAL_PATTERN.test(normalized)) {
    throw new Error(`Credential-like content is not allowed in ${name}`);
  }
  return normalized;
}

function exactWorkitemId(value) {
  const normalized = text(value, 'A1 workitem ID', 20, { required: true });
  if (!/^\d{1,20}$/.test(normalized)) throw new Error('A1 workitem ID is invalid');
  return normalized;
}

function normalizeProject(value, context, { required = false } = {}) {
  const input = text(value || context.defaultProjectId, 'A1 project', 200);
  if (!input) {
    if (required) throw new Error('A1 project is required');
    return '';
  }
  const normalized = input.toLowerCase();
  const exact = context.projects.filter(project => (
    String(project.id) === input || String(project.name || '').toLowerCase() === normalized
  ));
  if (exact.length === 1) return String(exact[0].id);
  const partial = context.projects.filter(project => (
    String(project.id).startsWith(input)
      || String(project.name || '').toLowerCase().includes(normalized)
  ));
  if (partial.length === 1) return String(partial[0].id);
  if (!partial.length) throw new Error(`A1 project is not available: ${input}`);
  throw new Error(`A1 project is ambiguous: ${input}`);
}

function normalizeFields(fields, allowed, { creating = false } = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('A1 workitem fields must be an object');
  }
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new Error(`A1 workitem field is not allowed: ${key}`);
  }
  const normalized = {};
  if ('category' in fields) {
    const category = text(fields.category, 'A1 category', 20, { required: true }).toLowerCase();
    if (!CATEGORIES.has(category)) throw new Error(`A1 category is invalid: ${category}`);
    normalized.category = category;
  }
  if ('type' in fields) normalized.type = text(fields.type, 'A1 type', 200, { required: true });
  if ('title' in fields) normalized.title = text(fields.title, 'A1 title', 500, { required: creating });
  if ('body' in fields) normalized.body = text(fields.body, 'A1 body', 100_000);
  for (const [key, label, maxLength] of [
    ['assignee', 'A1 assignee', 300],
    ['status', 'A1 status', 300],
    ['sprint', 'A1 sprint', 300],
    ['module', 'A1 module', 500],
    ['version', 'A1 version', 500],
    ['tag', 'A1 tag', 500],
    ['priority', 'A1 priority', 100],
    ['severity', 'A1 severity', 100],
    ['tracker', 'A1 tracker', 500],
    ['participant', 'A1 participant', 500],
    ['verifier', 'A1 verifier', 500],
    ['relatedSpace', 'A1 related space', 200],
  ]) {
    if (key in fields) normalized[key] = text(fields[key], label, maxLength, { required: true });
  }
  if (creating && !normalized.title) throw new Error('A1 title is required');
  if (creating && !normalized.category && !normalized.type) {
    throw new Error('A1 category or type is required');
  }
  return normalized;
}

function confirmationLevel(action, fields) {
  if (!['create', 'update', 'comment'].includes(action)) return 'none';
  if (fields?.assignee || /(?:cancel|closed|已取消|已关闭|关闭)/i.test(fields?.status || '')) {
    return 'double';
  }
  return 'single';
}

export function normalizeA1Plan(proposal, context) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('A1 plan must be an object');
  }
  if (!Array.isArray(context?.projects)) throw new Error('A1 projects are unavailable');
  const action = text(proposal.action, 'A1 action', 50, { required: true });
  if (!ACTIONS.has(action)) throw new Error(`A1 action is not allowed: ${action}`);
  const plan = {
    summary: text(proposal.summary || 'A1 request', 'A1 summary', 300, { required: true }),
    answer: text(proposal.answer || '', 'A1 answer', 4_000),
    action,
    confirmationLevel: 'none',
  };
  if (['get', 'activity', 'update', 'comment', 'follow', 'unfollow'].includes(action)) {
    plan.workitemId = exactWorkitemId(proposal.workitemId);
  }
  if (['create', 'sync_here', 'stop_sync'].includes(action) || proposal.projectId) {
    plan.projectId = normalizeProject(proposal.projectId, context, {
      required: ['create', 'sync_here', 'stop_sync'].includes(action),
    });
  }
  if (['sync_here', 'stop_sync'].includes(action)
    && plan.projectId !== String(context.defaultProjectId || '')) {
    throw new Error('A1 synchronization is limited to the configured project');
  }
  if (action === 'list') {
    if (proposal.projectId) plan.projectId = normalizeProject(proposal.projectId, context);
    const filters = proposal.filters && typeof proposal.filters === 'object'
      && !Array.isArray(proposal.filters) ? proposal.filters : {};
    const allowedFilters = new Set(['scope', 'category', 'status', 'assignee', 'title', 'modified']);
    for (const key of Object.keys(filters)) {
      if (!allowedFilters.has(key)) throw new Error(`A1 filter is not allowed: ${key}`);
    }
    plan.filters = {};
    if (filters.scope) {
      const scope = text(filters.scope, 'A1 scope', 20, { required: true });
      if (!SCOPES.has(scope)) throw new Error(`A1 scope is invalid: ${scope}`);
      plan.filters.scope = scope;
    }
    if (filters.category) {
      const categories = text(filters.category, 'A1 category', 50, { required: true })
        .split(',').filter(Boolean);
      if (categories.some(category => !CATEGORIES.has(category))) {
        throw new Error('A1 category filter is invalid');
      }
      plan.filters.category = categories.join(',');
    }
    for (const key of ['status', 'assignee', 'title', 'modified']) {
      if (filters[key]) plan.filters[key] = text(filters[key], `A1 ${key} filter`, 300);
    }
  }
  if (action === 'create') plan.fields = normalizeFields(proposal.fields, CREATE_FIELDS, { creating: true });
  if (action === 'update') {
    plan.fields = normalizeFields(proposal.fields, UPDATE_FIELDS);
    if (!Object.keys(plan.fields).length) throw new Error('At least one A1 workitem field is required');
  }
  if (action === 'comment') {
    plan.content = text(proposal.content, 'A1 comment', 10_000, { required: true });
  }
  plan.confirmationLevel = confirmationLevel(action, plan.fields);
  return plan;
}

export function parseA1PlannerOutput(output) {
  const source = String(output || '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI runtime did not return an A1 JSON plan');
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    throw new Error(`AI runtime returned invalid A1 JSON: ${error.message}`);
  }
}

export function buildA1PlannerPrompt({
  request,
  history = '',
  projects,
  defaultProjectId = '',
}) {
  const normalizedRequest = text(request, 'A1 request', 4_000, { required: true });
  const safeProjects = (projects || []).map(project => ({
    id: String(project.id || ''),
    name: String(project.name || ''),
    default: String(project.id || '') === String(defaultProjectId || ''),
  }));
  return `
You are the AIPRO A1 workitem planner for a DingTalk conversation. Convert the
operator's Simplified Chinese request into one constrained action. You plan
only, do not execute commands, and never include credentials.

Return JSON only:
{
  "summary": "short Simplified Chinese summary",
  "answer": "optional clarification",
  "action": "answer|list|get|activity|create|update|comment|follow|unfollow|sync_here|stop_sync",
  "projectId": "exact available project id or name",
  "workitemId": "numeric A1 workitem id",
  "filters": {"scope":"personal|project","category":"req|bug|task","status":"","assignee":"","title":"","modified":""},
  "fields": {"category":"req|bug|task","type":"","title":"","body":"","assignee":"","status":"","sprint":"","module":"","version":"","tag":"","priority":"","severity":""},
  "content": "comment text"
}

Rules:
- Use answer when information is missing or the request only asks about capability.
- list, get, and activity are read-only. Use exact numeric IDs for get/activity.
- create requires an available project, title, and category or type.
- update changes only fields explicitly requested by the operator.
- follow subscribes this DingTalk conversation to one workitem.
- sync_here subscribes only one explicitly available or configured project.
- Never plan delete, raw APIs, shell commands, databases, permissions, tokens,
  credentials, attachments, arbitrary files, or project membership changes.
- Do not invent IDs, projects, people, statuses, sprints, or content.
- Output one action only, without Markdown.

Available projects:
${JSON.stringify(safeProjects, null, 2)}

Recent conversation:
${String(history || '').slice(0, 8_000)}

Operator request:
${normalizedRequest}
`.trim();
}
