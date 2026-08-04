import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processFailureSummary, runBufferedProcess } from './process-runner.mjs';

const ALLOWED_PROJECTS = new Set(['2165415', '2168196']);

function requiredText(value, name, maxLength = 20_000) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  if (text.length > maxLength) throw new Error(`${name} is too long`);
  return text;
}

function parseJson(stdout, operation) {
  try {
    return JSON.parse(String(stdout || ''));
  } catch (error) {
    throw new Error(`A1 ${operation} returned invalid JSON: ${error.message}`);
  }
}

function fieldValue(fields, identifier) {
  const field = fields.find(item => String(item?.identifier || '') === identifier);
  return String(field?.displayValue ?? field?.value ?? '');
}

function fieldRawValue(fields, identifier) {
  const field = fields.find(item => String(item?.identifier || '') === identifier);
  return String(field?.value ?? '');
}

export function normalizeWorkitem(item) {
  if (!item || typeof item !== 'object') throw new Error('A1 workitem is invalid');
  const id = requiredText(item.id, 'workitem id', 100);
  const url = requiredText(item.url, 'workitem url', 2000);
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'https:' || parsedUrl.username || parsedUrl.password) {
    throw new Error('A1 workitem url must be HTTPS without credentials');
  }
  const fields = Array.isArray(item.fields) ? item.fields : [];
  return {
    id,
    title: String(item.title || ''),
    url,
    description: String(item.description || ''),
    status: fieldValue(fields, 'status'),
    assignee: fieldValue(fields, 'assignedTo'),
    projectId: fieldRawValue(fields, 'space'),
    projectName: fieldValue(fields, 'space'),
    updatedAt: String(item.updatedAt || ''),
    raw: structuredClone(item),
  };
}

function extractCreatedId(result) {
  const candidate = result?.id ?? result?.workitemId ?? result?.data?.id ?? result?.data?.workitemId;
  return requiredText(candidate, 'created workitem id', 100);
}

export class A1Client {
  constructor({
    bin = 'a1',
    runner = runBufferedProcess,
    timeoutMs = 45_000,
    allowedProjectIds = ALLOWED_PROJECTS,
  } = {}) {
    this.bin = requiredText(bin, 'A1 binary', 1000);
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.allowedProjectIds = new Set([...allowedProjectIds].map(String));
  }

  assertProject(projectId) {
    const value = requiredText(projectId, 'projectId', 100);
    if (!this.allowedProjectIds.has(value)) throw new Error(`A1 project ${value} is not allowed`);
    return value;
  }

  async runJson(args, operation = args.join(' ')) {
    try {
      const { stdout } = await this.runner(this.bin, args, {
        env: { ...process.env, A1_NO_UPDATE_CHECK: '1' },
        timeoutMs: this.timeoutMs,
        killGraceMs: 2_000,
        maxStdoutBytes: 12 * 1024 * 1024,
        maxStderrBytes: 2 * 1024 * 1024,
      });
      return parseJson(stdout, operation);
    } catch (error) {
      if (/^A1 .* returned invalid JSON/.test(error?.message || '')) throw error;
      throw new Error(`A1 ${operation} failed: ${processFailureSummary(error)}`);
    }
  }

  async getWorkitem(id) {
    const value = requiredText(id, 'workitem id', 100);
    const result = await this.runJson(
      ['project', 'workitem', 'get', value, '-f', 'json'],
      `workitem get ${value}`,
    );
    return normalizeWorkitem(result);
  }

  async listRequirements({ projectId, title = '', modified = '', page = 1, pageSize = 50 } = {}) {
    const project = this.assertProject(projectId);
    const args = [
      'project', 'workitem', 'list', '--project', project, '--category', 'req',
      '--page', String(Math.max(1, Number(page) || 1)),
      '--page-size', String(Math.max(1, Math.min(100, Number(pageSize) || 50))),
    ];
    if (title) args.push('--title', requiredText(title, 'title', 500));
    if (modified) args.push('--modified', requiredText(modified, 'modified', 100));
    args.push('-f', 'json');
    const result = await this.runJson(args, 'workitem list');
    if (!Array.isArray(result)) throw new Error('A1 workitem list must be an array');
    return result;
  }

  async resolveRequirementType(projectId) {
    const project = this.assertProject(projectId);
    const result = await this.runJson([
      'project', 'workitem', 'type', 'list', '--project', project, '--category', 'req', '-f', 'json',
    ], 'workitem type list');
    if (!Array.isArray(result)) throw new Error('A1 workitem type list must be an array');
    const type = result.find(item => String(item?.displayName || item?.name || '').includes('产品类需求')) || result[0];
    return requiredText(type?.identifier, 'requirement type identifier', 100);
  }

  async listFields(projectId, typeId) {
    const project = this.assertProject(projectId);
    const result = await this.runJson([
      'project', 'workitem', 'field', 'list', '--project', project, '--type', requiredText(typeId, 'typeId', 100), '-f', 'json',
    ], 'workitem field list');
    if (!Array.isArray(result)) throw new Error('A1 workitem field list must be an array');
    return result;
  }

  async withBodyFile(body, callback) {
    const directory = await mkdtemp(join(tmpdir(), 'james-a1-'));
    const path = join(directory, 'requirement.md');
    try {
      await writeFile(path, requiredText(body, 'body'), { encoding: 'utf8', mode: 0o600 });
      return await callback(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async createRequirement({ projectId, title, body, assignee = '', priority = '' } = {}) {
    const project = this.assertProject(projectId);
    const typeId = await this.resolveRequirementType(project);
    await this.listFields(project, typeId);
    const result = await this.withBodyFile(body, async bodyFile => {
      const args = [
        'project', 'workitem', 'create', '--project', project, '--type', typeId,
        '--title', requiredText(title, 'title', 500), '--body-file', bodyFile,
      ];
      if (assignee) args.push('--assignee', requiredText(assignee, 'assignee', 200));
      if (priority) args.push('--priority', requiredText(priority, 'priority', 100));
      args.push('-f', 'json');
      return this.runJson(args, 'workitem create');
    });
    return this.getWorkitem(extractCreatedId(result));
  }

  async updateRequirement(id, changes = {}) {
    const value = requiredText(id, 'workitem id', 100);
    const run = async bodyFile => {
      const args = ['project', 'workitem', 'update', value];
      if (changes.title) args.push('--title', requiredText(changes.title, 'title', 500));
      if (bodyFile) args.push('--body-file', bodyFile);
      if (changes.assignee) args.push('--assignee', requiredText(changes.assignee, 'assignee', 200));
      if (changes.priority) args.push('--priority', requiredText(changes.priority, 'priority', 100));
      if (changes.status) args.push('--status', requiredText(changes.status, 'status', 200));
      if (args.length === 4) throw new Error('A1 update requires at least one change');
      args.push('-f', 'json');
      await this.runJson(args, `workitem update ${value}`);
    };
    if (changes.body) await this.withBodyFile(changes.body, run);
    else await run('');
    return this.getWorkitem(value);
  }

  async getActivity(id, { limit = 50 } = {}) {
    const value = requiredText(id, 'workitem id', 100);
    const result = await this.runJson([
      'project', 'workitem', 'activity', value, '--limit', String(Math.max(1, Math.min(200, Number(limit) || 50))), '-f', 'json',
    ], `workitem activity ${value}`);
    if (!Array.isArray(result)) throw new Error('A1 workitem activity must be an array');
    return result;
  }

  async searchRepository({ repo, keyword, branch = '' } = {}) {
    const repository = requiredText(repo, 'repo', 1000);
    const query = requiredText(keyword, 'keyword', 500);
    const search = await this.runJson([
      'repo', 'search', query, '--repo', repository, '-f', 'json',
    ], 'repo search');
    let tree = [];
    if (branch) {
      tree = await this.runJson([
        'repo', 'file', 'list', '', '--repo', repository, '--ref', requiredText(branch, 'branch', 1000),
        '--type', 'RECURSIVE', '-f', 'json',
      ], 'repo file list');
    }
    return { search, tree };
  }

  async viewRepositoryFile({ repo, path, branch = '', startLine, endLine } = {}) {
    const args = ['repo', 'file', 'view', requiredText(path, 'path', 2000), '--repo', requiredText(repo, 'repo', 1000)];
    if (branch) args.push('--ref', requiredText(branch, 'branch', 1000));
    if (startLine) args.push('--start-line', String(Math.max(1, Number(startLine))));
    if (endLine) args.push('--end-line', String(Math.max(1, Number(endLine))));
    args.push('-f', 'json');
    return this.runJson(args, 'repo file view');
  }
}
