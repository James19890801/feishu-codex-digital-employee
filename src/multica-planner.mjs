const ACTIONS = new Set([
  'answer',
  'list',
  'search',
  'get',
  'create',
  'update',
  'comment',
  'follow',
  'unfollow',
  'sync_here',
  'stop_sync',
]);
const STATUSES = new Set([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
]);
const PRIORITIES = new Set(['none', 'low', 'medium', 'high', 'urgent']);
const CREATE_FIELDS = new Set([
  'title',
  'description',
  'status',
  'priority',
  'assignee',
  'assigneeId',
  'project',
  'parent',
  'dueDate',
  'startDate',
]);
const UPDATE_FIELDS = new Set([
  'title',
  'description',
  'status',
  'priority',
  'assignee',
  'assigneeId',
  'project',
  'dueDate',
  'startDate',
]);
const CREDENTIAL_PATTERN = /(?:sk-[A-Za-z0-9_-]{20,}|mul_[A-Za-z0-9_-]{12,}|(?:access|refresh)[_-]?token\s*[:=]|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|password\s*[:=])/i;

export function looksLikeMulticaRequest(value) {
  return /\bmultica\b|\bissue\b|[A-Za-z][A-Za-z0-9]{0,15}-\d+\b|(?:问题单|任务系统|业务系统|需求).{0,12}(?:查|创建|新建|登记|更新|跟进|同步)|(?:创建|新建|登记).{0,12}(?:需求|问题单|任务系统|业务系统)/i
    .test(String(value || ''));
}

function text(value, name, maxLength, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${name} is required`);
    return '';
  }
  const normalized = String(value).trim();
  if (required && !normalized) throw new Error(`${name} is required`);
  if (normalized.length > maxLength) throw new Error(`${name} is too long`);
  if (CREDENTIAL_PATTERN.test(normalized)) {
    throw new Error(`Credential-like content is not allowed in ${name}`);
  }
  return normalized;
}

function issueReference(value) {
  const normalized = text(value, 'Issue reference', 200, { required: true });
  if (!/^(?:[A-Za-z][A-Za-z0-9]{0,15}-\d+|[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(normalized)) {
    throw new Error('Issue reference must be an identifier such as MYS-2 or a UUID');
  }
  return normalized;
}

function date(value, name) {
  const normalized = text(value, name, 10);
  if (normalized && !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`${name} must use YYYY-MM-DD`);
  }
  return normalized;
}

function normalizeWorkspace(value, context) {
  const input = text(value || context.defaultWorkspaceId, 'Workspace ID', 200);
  if (!input) return '';
  const match = context.workspaces.find(item => item.id === input);
  if (!match) throw new Error(`Workspace is not available: ${input}`);
  return match.id;
}

function normalizeFields(fields, allowed, { creating = false } = {}) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Issue fields must be an object');
  }
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) throw new Error(`Issue field is not allowed: ${key}`);
  }
  const normalized = {};
  if ('title' in fields) {
    const value = text(fields.title, 'Issue title', 500, { required: creating });
    if (value) normalized.title = value;
  }
  if (creating && !normalized.title) throw new Error('Issue title is required');
  if ('description' in fields) {
    const value = text(fields.description, 'Issue description', 20_000);
    if (value) normalized.description = value;
  }
  if ('status' in fields) {
    const value = text(fields.status, 'Issue status', 50);
    if (value && !STATUSES.has(value)) throw new Error(`Invalid issue status: ${value}`);
    if (value) normalized.status = value;
  }
  if (creating && !normalized.status) {
    normalized.status = 'todo';
  }
  if ('priority' in fields) {
    const value = text(fields.priority, 'Issue priority', 50);
    if (value && !PRIORITIES.has(value)) throw new Error(`Invalid issue priority: ${value}`);
    if (value) normalized.priority = value;
  }
  if (creating && !normalized.priority) {
    normalized.priority = 'none';
  }
  for (const [key, label, maxLength] of [
    ['assignee', 'Assignee', 300],
    ['assigneeId', 'Assignee ID', 200],
    ['project', 'Project ID', 200],
    ['parent', 'Parent issue', 200],
  ]) {
    if (key in fields) {
      const value = text(fields[key], label, maxLength);
      if (value) normalized[key] = value;
    }
  }
  if (normalized.assignee && normalized.assigneeId) {
    throw new Error('Use assignee or assigneeId, not both');
  }
  if ('dueDate' in fields) {
    const value = date(fields.dueDate, 'Due date');
    if (value) normalized.dueDate = value;
  }
  if ('startDate' in fields) {
    const value = date(fields.startDate, 'Start date');
    if (value) normalized.startDate = value;
  }
  return normalized;
}

function confirmationLevel(action, fields) {
  if (!['create', 'update', 'comment'].includes(action)) return 'none';
  if (fields?.status === 'cancelled' || fields?.assignee || fields?.assigneeId) return 'double';
  return 'single';
}

export function normalizeMulticaPlan(proposal, context) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) {
    throw new Error('Multica plan must be an object');
  }
  if (!Array.isArray(context?.workspaces)) throw new Error('Multica workspaces are unavailable');
  const action = text(proposal.action, 'Action', 50, { required: true });
  if (!ACTIONS.has(action)) throw new Error(`Multica action is not allowed: ${action}`);
  const plan = {
    summary: text(proposal.summary || 'Multica request', 'Summary', 300, { required: true }),
    answer: text(proposal.answer || '', 'Answer', 4000),
    action,
    confirmationLevel: 'none',
  };
  if (['get', 'update', 'comment', 'follow', 'unfollow'].includes(action)) {
    plan.issue = issueReference(proposal.issue);
  }
  if (['list', 'search', 'create'].includes(action) || proposal.workspaceId) {
    plan.workspaceId = normalizeWorkspace(proposal.workspaceId, context);
  }
  if (action === 'search') {
    plan.query = text(proposal.query, 'Issue search query', 300, { required: true });
  }
  if (action === 'list') {
    const filters = proposal.filters && typeof proposal.filters === 'object'
      && !Array.isArray(proposal.filters) ? proposal.filters : {};
    const allowedFilters = new Set(['status', 'project']);
    for (const key of Object.keys(filters)) {
      if (!allowedFilters.has(key)) throw new Error(`Issue filter is not allowed: ${key}`);
    }
    plan.filters = {};
    if (filters.status) {
      if (!STATUSES.has(filters.status)) throw new Error(`Invalid issue status: ${filters.status}`);
      plan.filters.status = filters.status;
    }
    if (filters.project) plan.filters.project = text(filters.project, 'Project ID', 200);
  }
  if (action === 'create') {
    if (!plan.workspaceId) throw new Error('Workspace is required to create an issue');
    plan.fields = normalizeFields(proposal.fields, CREATE_FIELDS, { creating: true });
  }
  if (action === 'update') {
    plan.fields = normalizeFields(proposal.fields, UPDATE_FIELDS);
    if (!Object.keys(plan.fields).length) throw new Error('At least one issue field is required');
  }
  if (action === 'comment') {
    plan.content = text(proposal.content, 'Comment', 10_000, { required: true });
  }
  plan.confirmationLevel = confirmationLevel(action, plan.fields);
  return plan;
}

export function parseMulticaPlannerOutput(output) {
  const source = String(output || '').trim();
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI runtime did not return a Multica JSON plan');
  try {
    return JSON.parse(source.slice(start, end + 1));
  } catch (error) {
    throw new Error(`AI runtime returned invalid Multica JSON: ${error.message}`);
  }
}

export function buildMulticaPlannerPrompt({
  request,
  history = '',
  workspaces,
  defaultWorkspaceId = '',
}) {
  const normalizedRequest = text(request, 'Multica request', 4000, { required: true });
  const safeWorkspaces = (workspaces || []).map(item => ({
    id: String(item.id || ''),
    name: String(item.name || ''),
    slug: String(item.slug || ''),
    default: item.id === defaultWorkspaceId,
  }));
  return `
You are the AIPRO Multica action planner. Convert the operator's Simplified
Chinese request into one constrained action. You plan only; you do not execute
commands and you never include credentials.

Return JSON only:
{
  "summary": "short Simplified Chinese summary",
  "answer": "optional clarification or explanation",
  "action": "answer|list|search|get|create|update|comment|follow|unfollow|sync_here|stop_sync",
  "workspaceId": "an exact available workspace id or empty",
  "issue": "MYS-2 or UUID when required",
  "query": "search words for search",
  "filters": {"status":"todo","project":""},
  "fields": {
    "title": "",
    "description": "",
    "status": "backlog|todo|in_progress|in_review|done|blocked|cancelled",
    "priority": "none|low|medium|high|urgent",
    "assignee": "",
    "assigneeId": "",
    "project": "",
    "parent": "",
    "dueDate": "YYYY-MM-DD",
    "startDate": "YYYY-MM-DD"
  },
  "content": "comment text"
}

Rules:
- Use answer when the request is about capability or lacks enough information.
- list lists recent issues, optionally by workspace/status/project.
- search finds issues by title, description, identifier, or status.
- get reads one exact issue.
- create requires a title and a workspace. Use the default workspace when the
  operator did not name one.
- update changes only the fields included by the operator.
- comment adds one issue comment.
- follow subscribes the current Feishu conversation to changes for one issue.
- sync_here subscribes the current Feishu conversation to new and changed
  issues across every available workspace.
- Never plan delete, raw API calls, shell commands, database access, workspace
  membership changes, permission changes, token operations, or arbitrary files.
- Do not invent an issue key, workspace id, assignee, project, date, or content.
- Output one action only and do not wrap JSON in Markdown.

Available workspaces:
${JSON.stringify(safeWorkspaces, null, 2)}

Recent conversation:
${String(history || '').slice(0, 8000)}

Operator request:
${normalizedRequest}
`.trim();
}
