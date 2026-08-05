import { processFailureSummary, runBufferedProcess } from './process-runner.mjs';

const ISSUE_STATUSES = new Set([
  'backlog',
  'todo',
  'in_progress',
  'in_review',
  'done',
  'blocked',
  'cancelled',
]);
const ISSUE_PRIORITIES = new Set(['none', 'low', 'medium', 'high', 'urgent']);

function requiredText(value, name, maxLength) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${name} is required`);
  if (normalized.length > maxLength) throw new Error(`${name} is too long`);
  return normalized;
}

function optionalDate(value, name) {
  if (value === undefined || value === null || value === '') return '';
  const normalized = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new Error(`${name} must use YYYY-MM-DD`);
  }
  return normalized;
}

function parseJsonOutput(stdout, operation) {
  try {
    return JSON.parse(String(stdout || ''));
  } catch (error) {
    throw new Error(`Multica ${operation} returned invalid JSON: ${error.message}`);
  }
}

function validateWorkspace(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string'
    || typeof item.name !== 'string') {
    throw new Error('Multica returned an invalid workspace');
  }
  return {
    id: item.id,
    name: item.name,
    slug: String(item.slug || ''),
  };
}

function validateSquad(item, workspaceId) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string'
    || typeof item.name !== 'string') {
    throw new Error('Multica returned an invalid squad');
  }
  return {
    ...structuredClone(item),
    workspace_id: String(item.workspace_id || workspaceId || ''),
    member_count: Math.max(0, Number(item.member_count || 0)),
  };
}

function validateIssue(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string'
    || typeof item.identifier !== 'string' || typeof item.workspace_id !== 'string') {
    throw new Error('Multica returned an invalid issue');
  }
  return structuredClone(item);
}

function validateIssueRun(item) {
  if (!item || typeof item !== 'object' || typeof item.id !== 'string'
    || typeof item.status !== 'string') {
    throw new Error('Multica returned an invalid issue run');
  }
  return structuredClone(item);
}

export function isTransientMulticaError(error) {
  if (['PROCESS_TIMEOUT', 'PROCESS_SPAWN_ERROR'].includes(error?.code)) return true;
  const detail = `${error?.message || ''}\n${error?.stderr || ''}`.toLowerCase();
  if (/(?:http\s*)?(?:401|403|404|409|422)\b/.test(detail)) return false;
  return /(?:timeout|timed out|connection|temporar|network|econn|socket|http\s*429|http\s*5\d\d|server returned 5\d\d)/i
    .test(detail);
}

export class MulticaClient {
  constructor({
    bin,
    profile,
    defaultWorkspaceId = '',
    runner = runBufferedProcess,
    timeoutMs = 30_000,
    pageSize = 100,
    maxIssues = 5_000,
    retries = 2,
    retryDelay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  }) {
    this.bin = requiredText(bin, 'Multica binary', 1000);
    this.profile = requiredText(profile, 'Multica profile', 200);
    this.defaultWorkspaceId = String(defaultWorkspaceId || '');
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.pageSize = Math.max(1, Math.min(500, Number(pageSize) || 100));
    this.maxIssues = Math.max(this.pageSize, Math.min(20_000, Number(maxIssues) || 5_000));
    this.retries = Math.max(0, Math.min(4, Number(retries) || 0));
    this.retryDelay = retryDelay;
  }

  baseArgs(workspaceId = '') {
    const args = ['--profile', this.profile];
    if (workspaceId) args.push('--workspace-id', workspaceId);
    return args;
  }

  async runJson(commandArgs, {
    workspaceId = '',
    input,
    operation = commandArgs.join(' '),
    retries = this.retries,
  } = {}) {
    const args = [...this.baseArgs(workspaceId), ...commandArgs];
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const { stdout } = await this.runner(this.bin, args, {
          input,
          timeoutMs: this.timeoutMs,
          killGraceMs: 2_000,
          maxStdoutBytes: 8 * 1024 * 1024,
          maxStderrBytes: 1024 * 1024,
        });
        return parseJsonOutput(stdout, operation);
      } catch (error) {
        lastError = error;
        if (attempt >= retries || !isTransientMulticaError(error)) break;
        await this.retryDelay(Math.min(5_000, 250 * (2 ** attempt)));
      }
    }
    throw new Error(`Multica ${operation} failed: ${processFailureSummary(lastError)}`);
  }

  async listWorkspaces() {
    const result = await this.runJson(['workspace', 'list', '--output', 'json'], {
      operation: 'workspace list',
    });
    if (!Array.isArray(result)) throw new Error('Multica workspace list must be an array');
    return result.map(validateWorkspace);
  }

  async listSquads(workspaceId) {
    const targetWorkspace = requiredText(
      workspaceId || this.defaultWorkspaceId,
      'Workspace ID',
      200,
    );
    const result = await this.runJson(['squad', 'list', '--output', 'json'], {
      workspaceId: targetWorkspace,
      operation: 'squad list',
    });
    if (!Array.isArray(result)) throw new Error('Multica squad list must be an array');
    return result.map(item => validateSquad(item, targetWorkspace));
  }

  async resolveWorkspace(reference = '') {
    const workspaces = await this.listWorkspaces();
    const input = String(reference || this.defaultWorkspaceId || '').trim().toLowerCase();
    if (!input) {
      if (workspaces.length === 1) return workspaces[0];
      throw new Error('Please specify a Multica workspace');
    }
    const exact = workspaces.filter(item => [
      item.id.toLowerCase(),
      item.slug.toLowerCase(),
      item.name.toLowerCase(),
    ].includes(input));
    if (exact.length === 1) return exact[0];
    const partial = workspaces.filter(item => item.name.toLowerCase().includes(input)
      || item.slug.toLowerCase().includes(input)
      || item.id.toLowerCase().startsWith(input));
    if (partial.length === 1) return partial[0];
    if (!partial.length) throw new Error(`Multica workspace not found: ${reference}`);
    throw new Error(`Multica workspace is ambiguous: ${reference}`);
  }

  async listIssues(workspaceId, {
    offset = 0,
    limit = this.pageSize,
    status = '',
    project = '',
  } = {}) {
    const args = [
      'issue', 'list',
      '--limit', String(Math.max(1, Math.min(500, limit))),
      '--offset', String(Math.max(0, Number(offset) || 0)),
      '--sort', 'created_at',
      '--direction', 'desc',
      '--output', 'json',
    ];
    if (status) args.push('--status', status);
    if (project) args.push('--project', project);
    const result = await this.runJson(args, { workspaceId, operation: 'issue list' });
    if (!result || !Array.isArray(result.issues)) {
      throw new Error('Multica issue list has an invalid shape');
    }
    return {
      issues: result.issues.map(validateIssue),
      total: Number(result.total || result.issues.length),
      hasMore: result.has_more === true,
      limit: Number(result.limit || limit),
      offset: Number(result.offset || offset),
    };
  }

  async listAllIssues({ workspaces, status = '', project = '' } = {}) {
    const available = workspaces || await this.listWorkspaces();
    const all = [];
    for (const workspace of available) {
      let offset = 0;
      while (all.length < this.maxIssues) {
        const page = await this.listIssues(workspace.id, {
          offset,
          limit: Math.min(this.pageSize, this.maxIssues - all.length),
          status,
          project,
        });
        all.push(...page.issues.map(issue => ({
          ...issue,
          workspace_name: workspace.name,
          workspace_slug: workspace.slug,
        })));
        if (!page.hasMore || !page.issues.length) break;
        const nextOffset = page.offset + page.issues.length;
        if (nextOffset <= offset) throw new Error('Multica issue pagination did not advance');
        offset = nextOffset;
      }
      if (all.length >= this.maxIssues) break;
    }
    return all;
  }

  async searchIssues(query, options = {}) {
    const normalized = requiredText(query, 'Issue search query', 300).toLowerCase();
    const issues = await this.listAllIssues(options);
    return issues.filter(issue => [
      issue.identifier,
      issue.title,
      issue.description,
      issue.status,
    ].some(value => String(value || '').toLowerCase().includes(normalized)));
  }

  async getIssue(reference, workspaceId = '') {
    const normalized = requiredText(reference, 'Issue reference', 200);
    let targetWorkspace = workspaceId;
    let matchedIssue = null;
    if (!targetWorkspace) {
      matchedIssue = (await this.listAllIssues())
        .find(issue => issue.id === normalized
          || issue.identifier.toLowerCase() === normalized.toLowerCase());
      if (!matchedIssue) throw new Error(`Multica issue not found: ${reference}`);
      targetWorkspace = matchedIssue.workspace_id;
    }
    const result = await this.runJson(
      ['issue', 'get', normalized, '--output', 'json'],
      { workspaceId: targetWorkspace, operation: 'issue get', retries: 1 },
    );
    return {
      ...validateIssue(result),
      ...(matchedIssue?.workspace_name ? { workspace_name: matchedIssue.workspace_name } : {}),
      ...(matchedIssue?.workspace_slug ? { workspace_slug: matchedIssue.workspace_slug } : {}),
    };
  }

  async listIssueRuns(reference, workspaceId = '') {
    const normalized = requiredText(reference, 'Issue reference', 200);
    const result = await this.runJson(
      ['issue', 'runs', normalized, '--output', 'json'],
      { workspaceId, operation: 'issue runs', retries: 1 },
    );
    if (!Array.isArray(result)) throw new Error('Multica issue runs must be an array');
    return result.map(validateIssueRun);
  }

  async createIssue({
    workspaceId,
    title,
    description = '',
    status = 'todo',
    priority = 'none',
    assignee = '',
    assigneeId = '',
    project = '',
    parent = '',
    dueDate = '',
    startDate = '',
  }) {
    const targetWorkspace = requiredText(
      workspaceId || this.defaultWorkspaceId,
      'Workspace ID',
      200,
    );
    const issueTitle = requiredText(title, 'Issue title', 500);
    if (!ISSUE_STATUSES.has(status)) throw new Error(`Invalid Multica issue status: ${status}`);
    if (!ISSUE_PRIORITIES.has(priority)) throw new Error(`Invalid Multica issue priority: ${priority}`);
    if (assignee && assigneeId) throw new Error('Use assignee or assigneeId, not both');
    const args = [
      'issue', 'create',
      '--title', issueTitle,
      '--status', status,
      '--priority', priority,
      '--output', 'json',
    ];
    const input = String(description || '');
    if (input) args.push('--description-stdin');
    if (assignee) args.push('--assignee', requiredText(assignee, 'Assignee', 300));
    if (assigneeId) args.push('--assignee-id', requiredText(assigneeId, 'Assignee ID', 200));
    if (project) args.push('--project', requiredText(project, 'Project ID', 200));
    if (parent) args.push('--parent', requiredText(parent, 'Parent issue', 200));
    if (dueDate) args.push('--due-date', optionalDate(dueDate, 'Due date'));
    if (startDate) args.push('--start-date', optionalDate(startDate, 'Start date'));
    const result = await this.runJson(args, {
      workspaceId: targetWorkspace,
      input: input || undefined,
      operation: 'issue create',
      // A timed-out create may already have reached Multica. Retrying could
      // create a second Issue, so creation is deliberately at-most-once.
      retries: 0,
    });
    return validateIssue(result);
  }

  async updateIssue(reference, {
    workspaceId,
    title,
    description,
    status,
    priority,
    assignee,
    assigneeId,
    project,
    dueDate,
    startDate,
  }) {
    const issue = await this.getIssue(reference, workspaceId);
    if (assignee && assigneeId) throw new Error('Use assignee or assigneeId, not both');
    const args = ['issue', 'update', issue.id, '--output', 'json'];
    let input;
    if (title !== undefined) args.push('--title', requiredText(title, 'Issue title', 500));
    if (description !== undefined) {
      input = String(description);
      args.push('--description-stdin');
    }
    if (status !== undefined) {
      if (!ISSUE_STATUSES.has(status)) throw new Error(`Invalid Multica issue status: ${status}`);
      args.push('--status', status);
    }
    if (priority !== undefined) {
      if (!ISSUE_PRIORITIES.has(priority)) throw new Error(`Invalid Multica issue priority: ${priority}`);
      args.push('--priority', priority);
    }
    if (assignee !== undefined) args.push('--assignee', requiredText(assignee, 'Assignee', 300));
    if (assigneeId !== undefined) args.push('--assignee-id', requiredText(assigneeId, 'Assignee ID', 200));
    if (project !== undefined) args.push('--project', String(project || ''));
    if (dueDate !== undefined) args.push('--due-date', optionalDate(dueDate, 'Due date'));
    if (startDate !== undefined) args.push('--start-date', optionalDate(startDate, 'Start date'));
    if (args.length === 5) throw new Error('No Multica issue changes were provided');
    const result = await this.runJson(args, {
      workspaceId: issue.workspace_id,
      input,
      operation: 'issue update',
      retries: 1,
    });
    return validateIssue(result);
  }

  async addComment(reference, content, workspaceId = '') {
    const issue = await this.getIssue(reference, workspaceId);
    const comment = requiredText(content, 'Comment', 10_000);
    const result = await this.runJson([
      'issue', 'comment', 'add', issue.id,
      '--content-stdin',
      '--output', 'json',
    ], {
      workspaceId: issue.workspace_id,
      input: comment,
      operation: 'issue comment add',
      // Comments are additive and have no idempotency key in the CLI.
      retries: 0,
    });
    return { issue, comment: structuredClone(result) };
  }
}
