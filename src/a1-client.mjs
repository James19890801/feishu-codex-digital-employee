import { processFailureSummary, runBufferedProcess } from './process-runner.mjs';

const SCOPES = new Set(['personal', 'project', 'team', 'all', 'collect', 'associate', 'child']);
const CATEGORIES = new Set(['req', 'bug', 'task']);
const UPDATE_FIELDS = new Map([
  ['title', '--title'],
  ['body', '--body'],
  ['assignee', '--assignee'],
  ['status', '--status'],
  ['sprint', '--sprint'],
  ['module', '--module'],
  ['version', '--version'],
  ['tag', '--tag'],
  ['priority', '--priority'],
  ['severity', '--severity'],
  ['tracker', '--tracker'],
  ['participant', '--participant'],
  ['verifier', '--verifier'],
  ['relatedSpace', '--related-space'],
]);

function requiredText(value, name, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maxLength || /[\u0000\r\n]/.test(normalized)) {
    throw new Error(`${name} is invalid or too long`);
  }
  return normalized;
}

function bodyText(value, name = 'A1 workitem body') {
  const normalized = String(value ?? '');
  if (normalized.length > 100_000 || /\u0000/.test(normalized)) {
    throw new Error(`${name} is invalid or too long`);
  }
  return normalized;
}

function identifier(value, name) {
  const normalized = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function workitemId(value) {
  const normalized = String(value || '').trim();
  if (!/^\d{1,20}$/.test(normalized)) throw new Error('A1 workitem ID is invalid');
  return normalized;
}

function parseJson(stdout, operation) {
  try {
    return JSON.parse(String(stdout || ''));
  } catch (error) {
    throw new Error(`A1 ${operation} returned invalid JSON: ${error.message}`);
  }
}

function field(item, key) {
  return Array.isArray(item?.fields)
    ? item.fields.find(candidate => candidate?.identifier === key)
    : null;
}

function displayField(item, key) {
  const current = field(item, key);
  return String(current?.displayValue ?? current?.value ?? '');
}

function normalizeWorkitem(item) {
  if (!item || typeof item !== 'object') throw new Error('A1 returned an invalid workitem');
  const id = String(item.id ?? item.identifier ?? '');
  if (!/^\d{1,20}$/.test(id)) throw new Error('A1 returned a workitem without a valid ID');
  const title = String(item.title ?? item.subject ?? '');
  if (!title) throw new Error('A1 returned a workitem without a title');
  const space = field(item, 'space');
  return {
    id,
    projectId: String(item.spaceIdentifier ?? space?.value ?? ''),
    projectName: String(item.spaceName ?? space?.displayValue ?? ''),
    title,
    status: String(item.status?.name ?? item.status ?? displayField(item, 'status') ?? ''),
    assignee: String(item.assignedTo?.displayName ?? item.assignedTo?.nickName
      ?? item.assignedTo ?? displayField(item, 'assignedTo') ?? ''),
    category: String(item.categoryIdentifier ?? item.category ?? ''),
    type: String(item.workitemType?.name ?? item.workitemType ?? displayField(item, 'workitemType') ?? ''),
    updatedAt: String(item.updatedAt ?? item.gmtModified ?? ''),
    url: String(item.url || ''),
    ...(item.description !== undefined ? { description: String(item.description || '') } : {}),
    raw: structuredClone(item),
  };
}

function normalizeProject(item) {
  if (!item || typeof item !== 'object') throw new Error('A1 returned an invalid project');
  const id = String(item.id ?? item.identifier ?? '');
  const name = String(item.name ?? item.title ?? '');
  if (!/^\d{1,20}$/.test(id) || !name) throw new Error('A1 returned an invalid project');
  return {
    id,
    name,
    status: String(item.status || ''),
    type: String(item.type || ''),
    description: String(item.description || ''),
  };
}

export function isTransientA1Error(error) {
  if (['PROCESS_TIMEOUT', 'PROCESS_SPAWN_ERROR'].includes(error?.code)) return true;
  const detail = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase();
  if (/(?:http\s*)?(?:400|401|403|404|409|422)\b/.test(detail)) return false;
  return /(?:timeout|timed out|connection|temporar|network|econn|socket|http\s*429|http\s*5\d\d|server returned 5\d\d)/i
    .test(detail);
}

export class A1Client {
  constructor({
    bin,
    defaultProjectId = '',
    runner = runBufferedProcess,
    timeoutMs = 30_000,
    pageSize = 25,
    maxWorkitems = 500,
    retries = 2,
    retryDelay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  }) {
    this.bin = requiredText(bin, 'A1 binary', 1000);
    this.defaultProjectId = defaultProjectId ? identifier(defaultProjectId, 'A1 project ID') : '';
    this.runner = runner;
    this.timeoutMs = Math.max(5_000, Math.min(120_000, Number(timeoutMs) || 30_000));
    this.pageSize = Math.max(1, Math.min(100, Number(pageSize) || 25));
    this.maxWorkitems = Math.max(this.pageSize, Math.min(5_000, Number(maxWorkitems) || 500));
    this.retries = Math.max(0, Math.min(4, Number(retries) || 0));
    this.retryDelay = retryDelay;
  }

  async runJson(commandArgs, { operation, retries = this.retries } = {}) {
    const args = [...commandArgs, '--no-update-check', '-f', 'json'];
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const { stdout } = await this.runner(this.bin, args, {
          env: { ...process.env, A1_NO_UPDATE_CHECK: '1' },
          timeoutMs: this.timeoutMs,
          killGraceMs: 2_000,
          maxStdoutBytes: 8 * 1024 * 1024,
          maxStderrBytes: 1024 * 1024,
        });
        return parseJson(stdout, operation || commandArgs.join(' '));
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isTransientA1Error(error)) break;
        await this.retryDelay(Math.min(5_000, 250 * (2 ** attempt)));
      }
    }
    throw new Error(`A1 ${operation || commandArgs.join(' ')} failed: ${processFailureSummary(lastError)}`);
  }

  async whoami() {
    const result = await this.runJson(['auth', 'whoami'], { operation: 'auth whoami' });
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('A1 auth whoami returned an invalid identity');
    }
    return structuredClone(result);
  }

  async listProjects(keyword = '') {
    const args = ['project', 'list'];
    if (keyword) args.push('--keyword', requiredText(keyword, 'A1 project keyword', 200));
    const result = await this.runJson(args, { operation: 'project list' });
    if (!Array.isArray(result)) throw new Error('A1 project list must be an array');
    return result.map(normalizeProject);
  }

  async listWorkitems({
    projectId = '',
    scope = 'personal',
    category = 'req,bug,task',
    status = '',
    assignee = '',
    title = '',
    modified = '',
    page = 1,
    pageSize = this.pageSize,
  } = {}) {
    if (!SCOPES.has(scope)) throw new Error('A1 scope is invalid');
    const categories = String(category || '').split(',').filter(Boolean);
    if (!categories.length || categories.some(value => !CATEGORIES.has(value))) {
      throw new Error('A1 workitem category is invalid');
    }
    const boundedPageSize = Math.min(this.pageSize, this.maxWorkitems, Math.max(1, Number(pageSize) || this.pageSize));
    const args = [
      'project', 'workitem', 'list',
      '--scope', scope,
      '--category', categories.join(','),
      '--page', String(Math.max(1, Number(page) || 1)),
      '--page-size', String(boundedPageSize),
    ];
    const targetProject = projectId || (scope === 'personal' ? '' : this.defaultProjectId);
    if (targetProject) args.push('--project', identifier(targetProject, 'A1 project ID'));
    for (const [flag, value, name] of [
      ['--status', status, 'A1 status'],
      ['--assignee', assignee, 'A1 assignee'],
      ['--title', title, 'A1 title filter'],
      ['--modified', modified, 'A1 modified filter'],
    ]) {
      if (value) args.push(flag, requiredText(value, name, 300));
    }
    const result = await this.runJson(args, { operation: 'workitem list' });
    if (!Array.isArray(result)) throw new Error('A1 workitem list must be an array');
    return result.slice(0, this.maxWorkitems).map(normalizeWorkitem);
  }

  async getWorkitem(id) {
    const result = await this.runJson(
      ['project', 'workitem', 'get', workitemId(id)],
      { operation: 'workitem get' },
    );
    return normalizeWorkitem(result);
  }

  async getActivity(id, limit = 50) {
    const boundedLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const result = await this.runJson([
      'project', 'workitem', 'activity', workitemId(id),
      '--limit', String(boundedLimit), '--sort', 'desc',
    ], { operation: 'workitem activity' });
    if (!Array.isArray(result)) throw new Error('A1 workitem activity must be an array');
    return structuredClone(result);
  }

  async createWorkitem({
    projectId = this.defaultProjectId,
    category,
    type = '',
    title,
    body = '',
    assignee = '',
    status = '',
    sprint = '',
    module = '',
    version = '',
    tag = '',
    priority = '',
    severity = '',
  }) {
    const targetProject = identifier(projectId, 'A1 project ID');
    if (!CATEGORIES.has(category) && !type) throw new Error('A1 workitem category or type is required');
    const args = [
      'project', 'workitem', 'create',
      '--project', targetProject,
      ...(CATEGORIES.has(category) ? ['--category', category] : []),
      '--title', requiredText(title, 'A1 workitem title', 500),
    ];
    if (type) args.push('--type', requiredText(type, 'A1 workitem type', 200));
    if (body) args.push('--body', bodyText(body));
    for (const [flag, value, name] of [
      ['--assignee', assignee, 'A1 assignee'],
      ['--status', status, 'A1 status'],
      ['--sprint', sprint, 'A1 sprint'],
      ['--module', module, 'A1 module'],
      ['--version', version, 'A1 version'],
      ['--tag', tag, 'A1 tag'],
      ['--priority', priority, 'A1 priority'],
      ['--severity', severity, 'A1 severity'],
    ]) {
      if (value) args.push(flag, requiredText(value, name, 500));
    }
    const result = await this.runJson(args, { operation: 'workitem create', retries: 0 });
    const id = workitemId(result?.id ?? result?.identifier);
    return this.getWorkitem(id);
  }

  async updateWorkitem(id, changes = {}) {
    const args = ['project', 'workitem', 'update', workitemId(id)];
    let count = 0;
    for (const [key, flag] of UPDATE_FIELDS) {
      if (changes[key] === undefined) continue;
      const value = key === 'body'
        ? bodyText(changes[key])
        : requiredText(changes[key], `A1 ${key}`, key === 'title' ? 500 : 1_000);
      args.push(flag, value);
      count += 1;
    }
    if (!count) throw new Error('No A1 workitem changes were provided');
    await this.runJson(args, { operation: 'workitem update', retries: 0 });
    return this.getWorkitem(id);
  }

  async createComment(id, content) {
    const targetId = workitemId(id);
    await this.runJson([
      'project', 'workitem', 'comment', 'create', targetId,
      '-m', requiredText(content, 'A1 comment', 10_000),
    ], { operation: 'workitem comment create', retries: 0 });
    return this.getWorkitem(targetId);
  }
}
