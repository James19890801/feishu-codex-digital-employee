import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const SOURCE_LABELS = {
  chat: '企业会话聊天',
  minutes: 'AI 听记',
  documents: '企业会话文档',
  codex: 'Codex 对话',
  artifacts: '本地工作产物',
};

const SECRET_PATTERNS = [
  [/(\b(?:token|secret|password|passwd|api[_-]?key)\s*[=:]\s*)[^\s,;]+/giu, '$1[REDACTED]'],
  [/(\bBearer\s+)[A-Za-z0-9._~+\/-]+/giu, '$1[REDACTED]'],
  [/sk-[A-Za-z0-9_-]{4,}\b/gu, '[REDACTED]'],
  [/\b(1\d{2})\d{4}(\d{4})\b/gu, '$1****$2'],
];

const FORBIDDEN_ARTIFACT_NAME = /(?:^|\/)(?:config\.local(?:\.[^/]*)?|\.env(?:\.[^/]*)?|auth(?:entication)?(?:\.[^/]*)?|credentials?(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|tokens?(?:\.[^/]*)?)$/iu;

export function redactKnowledgeText(value = '') {
  let text = String(value).replace(/\u0000/g, '').trim();
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function stableRecordHash(record = {}) {
  return createHash('sha256')
    .update(JSON.stringify([record.source || '', record.id || '', record.locator || '', record.text || '']))
    .digest('hex');
}

export function isKnowledgeRecordSafe(record = {}) {
  if (record.source !== 'artifacts') return true;
  const locator = String(record.locator || '').replace(/^file:/u, '');
  return !FORBIDDEN_ARTIFACT_NAME.test(locator);
}

export function buildConnectorEnv({ baseEnv = process.env, channel } = {}) {
  if (!String(channel || '').trim()) throw new Error('CONNECTOR Channel is required');
  return { ...baseEnv, CONNECTOR_CHANNEL: String(channel).trim() };
}

export function buildConnectorSourceCommands({ profile, startMs, endMs, cursor = '0' } = {}) {
  if (!String(profile || '').trim()) throw new Error('CONNECTOR profile is required');
  const common = ['--profile', String(profile), '--format', 'json'];
  return {
    chat: ['chat', 'message', 'list-all', '--start', String(startMs), '--end', String(endMs), '--cursor', String(cursor || '0'), '--limit', '50', ...common],
    minutes: ['minutes', 'list', 'all', '--limit', '30', ...common],
    documents: ['drive', 'recent', '--operate-type', '0,1', '--limit', '5', ...common],
  };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(item => ['input_text', 'output_text', 'text'].includes(item?.type))
    .map(item => item.text || '')
    .filter(Boolean)
    .join('\n');
}

async function walkFiles(root, predicate, output = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return output;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walkFiles(path, predicate, output);
    else if (entry.isFile() && predicate(path)) output.push(path);
  }
  return output;
}

export async function collectCodexSessions({ codexHome, sinceMs = 0, maxFiles = 100 } = {}) {
  const root = join(String(codexHome || ''), 'sessions');
  const candidates = await walkFiles(root, path => path.endsWith('.jsonl'));
  const recent = [];
  for (const path of candidates) {
    const info = await stat(path);
    if (info.mtimeMs > Number(sinceMs || 0)) recent.push({ path, mtimeMs: info.mtimeMs });
  }
  recent.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const records = [];
  for (const file of recent.slice(0, maxFiles)) {
    const info = await stat(file.path);
    if (info.size > 5 * 1024 * 1024) continue;
    const lines = (await readFile(file.path, 'utf8')).split('\n').filter(Boolean);
    let id = file.path;
    let cwd = '';
    const messages = [];
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'session_meta') {
        id = event.payload?.id || event.payload?.session_id || id;
        cwd = event.payload?.cwd || '';
      }
      const payload = event.type === 'response_item' ? event.payload : null;
      if (payload?.type !== 'message' || !['user', 'assistant'].includes(payload.role)) continue;
      const text = contentText(payload.content);
      if (text) messages.push(`${payload.role === 'user' ? '用户' : '助手'}：${text}`);
    }
    const text = redactKnowledgeText(messages.join('\n').slice(0, 30000));
    if (!text) continue;
    records.push({
      id: String(id),
      source: 'codex',
      title: `Codex 对话 ${String(id).slice(0, 12)}`,
      text,
      locator: `codex:${id}`,
      metadata: { cwd, path: relative(String(codexHome), file.path), mtimeMs: file.mtimeMs },
    });
  }
  const processed = recent.slice(0, maxFiles);
  const cursor = processed.length ? String(Math.max(...processed.map(item => item.mtimeMs))) : String(sinceMs || 0);
  return { status: 'ok', cursor, records };
}

function normalizeRecord(record, source, date) {
  const normalized = {
    id: String(record?.id || record?.locator || ''),
    source,
    title: redactKnowledgeText(record?.title || SOURCE_LABELS[source] || source),
    text: redactKnowledgeText(record?.text || ''),
    locator: redactKnowledgeText(record?.locator || ''),
    date,
    metadata: record?.metadata && typeof record.metadata === 'object' ? record.metadata : {},
  };
  normalized.hash = stableRecordHash(normalized);
  return normalized;
}

export function renderDailyWiki({ date, generatedAt, sources = {}, records } = {}) {
  const allRecords = records || Object.entries(sources).flatMap(([source, result]) =>
    (result?.records || []).map(record => normalizeRecord(record, source, date)));
  const lines = [
    `# AIPR0S 知识日报 · ${date}`,
    '',
    `生成时间：${generatedAt}`,
    '',
    '## 来源状态',
    '',
  ];
  for (const source of Object.keys(SOURCE_LABELS)) {
    const result = sources[source];
    if (!result) continue;
    const label = SOURCE_LABELS[source];
    if (result.status === 'ok') lines.push(`- ${label}：已读取（${(result.records || []).length} 条）`);
    else lines.push(`- ${label}：未读取（${redactKnowledgeText(result.error || '未知错误')}）`);
  }
  lines.push('', '## 新增知识', '');
  if (!allRecords.length) lines.push('本次没有新增知识。');
  for (const record of allRecords) {
    lines.push(`### ${record.title || SOURCE_LABELS[record.source]}`, '', record.text || '（仅有元数据）');
    if (record.locator) lines.push('', `来源：${record.locator}`);
    lines.push('');
  }
  return `${lines.join('\n').trim()}\n`;
}

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function atomicWrite(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, value, { mode: 0o600 });
  await rename(temporary, path);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

async function acquireSyncLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${process.pid}\n`);
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = Number.parseInt(await readFile(lockPath, 'utf8').catch(() => ''), 10);
      if (attempt === 0 && !processIsAlive(owner)) {
        await rm(lockPath, { force: true });
        continue;
      }
      throw new Error('Nightly knowledge sync is already running');
    }
  }
  throw new Error('Nightly knowledge sync lock could not be acquired');
}

export async function runNightlyKnowledgeSync({ wikiRoot, collectors, clock = () => new Date(), dryRun = false } = {}) {
  if (!wikiRoot) throw new Error('Wiki root is required');
  if (!collectors || typeof collectors !== 'object') throw new Error('Collectors are required');
  await mkdir(wikiRoot, { recursive: true, mode: 0o700 });
  const lockPath = join(wikiRoot, '.sync.lock');
  const lock = await acquireSyncLock(lockPath);
  try {
    const now = clock();
    const generatedAt = now.toISOString();
    const date = generatedAt.slice(0, 10);
    const statePath = join(wikiRoot, 'state.json');
    const indexPath = join(wikiRoot, 'index.json');
    const dailyPath = join(wikiRoot, 'daily', `${date}.md`);
    const state = await readJson(statePath, { version: 1, sources: {}, published: {} });
    const index = await readJson(indexPath, { version: 1, records: [] });
    index.records = (Array.isArray(index.records) ? index.records : [])
      .filter(isKnowledgeRecordSafe)
      .map(record => {
        const sanitized = {
          ...record,
          title: redactKnowledgeText(record.title || ''),
          text: redactKnowledgeText(record.text || ''),
          locator: redactKnowledgeText(record.locator || ''),
        };
        return { ...sanitized, hash: stableRecordHash(sanitized) };
      });
    const known = new Set(index.records.map(record => record.hash || stableRecordHash(record)));
    const sources = {};
    const newRecords = [];
    for (const source of Object.keys(SOURCE_LABELS)) {
      const collector = collectors[source];
      if (typeof collector !== 'function') continue;
      try {
        const result = await collector({ state: state.sources[source] || {}, now });
        sources[source] = result?.status === 'ok' ? { ...result, records: result.records || [] } : {
          status: 'unread', error: result?.error || 'collector_failed', records: [],
        };
      } catch (error) {
        sources[source] = { status: 'unread', error: error.message, records: [] };
      }
      if (sources[source].status !== 'ok') continue;
      for (const record of sources[source].records) {
        const normalized = normalizeRecord(record, source, date);
        if ((!normalized.text && !normalized.locator) || !isKnowledgeRecordSafe(normalized)) continue;
        if (!known.has(normalized.hash)) {
          known.add(normalized.hash);
          newRecords.push(normalized);
        }
      }
      state.sources[source] = {
        ...state.sources[source],
        cursor: sources[source].cursor ?? state.sources[source]?.cursor,
        lastSuccessAt: generatedAt,
      };
    }
    const dayRecords = [...index.records.filter(record => record.date === date), ...newRecords];
    const markdown = renderDailyWiki({ date, generatedAt, sources, records: dayRecords });
    const nextIndex = { version: 1, updatedAt: generatedAt, records: [...index.records, ...newRecords] };
    state.updatedAt = generatedAt;
    if (!dryRun) {
      await atomicWrite(dailyPath, markdown);
      await atomicWrite(indexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
      await atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
    }
    return { date, generatedAt, newRecordCount: newRecords.length, sources, markdown, state, index: nextIndex };
  } finally {
    await lock?.close();
    await rm(lockPath, { force: true });
  }
}
