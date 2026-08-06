import { opendir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, normalize, relative, resolve, sep } from 'node:path';

const SHANGHAI_OFFSET = '+08:00';
const ALLOWED_TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.jsonl', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.go', '.rs', '.java', '.swift', '.html', '.css', '.scss', '.less', '.xml',
  '.yml', '.yaml', '.toml', '.ini', '.csv', '.sql', '.sh', '.zsh', '.fish',
]);
const DENIED_SEGMENTS = new Set([
  '.git', '.svn', '.hg', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.npm',
  '.cache', '.trash', '.codex', '.agents', '.config', 'library', 'keychains',
  'node_modules', 'vendor', 'dist',
  'build', '__pycache__', '.venv', 'venv', 'coverage', 'database-backups',
]);
const SENSITIVE_BASENAME = /^(?:\.env(?:\..*)?|auth(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|p12|pfx|key|keychain-db))$/i;

function shanghaiDateKey(value) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
}

function normalizedLearningHour(hour) {
  const numeric = Number(hour);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(23, Math.trunc(numeric))) : 1;
}

export function nextDailyLearningAt(now = new Date(), hour = 1) {
  const normalizedHour = normalizedLearningHour(hour);
  const today = shanghaiDateKey(now);
  const candidate = new Date(`${today}T${String(normalizedHour).padStart(2, '0')}:00:00${SHANGHAI_OFFSET}`);
  if (candidate.getTime() > now.getTime()) return candidate;
  return new Date(candidate.getTime() + 24 * 60 * 60_000);
}

export function shouldRunDailyLearning({ now = new Date(), lastCompletedDate = '', hour = 1 } = {}) {
  const today = shanghaiDateKey(now);
  const scheduled = new Date(`${today}T${String(normalizedLearningHour(hour)).padStart(2, '0')}:00:00${SHANGHAI_OFFSET}`);
  return now.getTime() >= scheduled.getTime() && String(lastCompletedDate || '') !== today;
}

export function learningDateKey(now = new Date()) {
  return shanghaiDateKey(now);
}

export function isLearningPathAllowed(filePath) {
  const normalizedPath = normalize(String(filePath || ''));
  if (!normalizedPath) return false;
  const segments = normalizedPath.split(sep).filter(Boolean).map(value => value.toLowerCase());
  if (segments.some(segment => DENIED_SEGMENTS.has(segment))) return false;
  const name = basename(normalizedPath);
  if (SENSITIVE_BASENAME.test(name)) return false;
  if (/\.(?:sqlite|sqlite3|db|log|wal|shm|lock|dmg|pkg|app|zip|7z|rar|tar|gz)$/i.test(name)) return false;
  return true;
}

export function redactLearningText(value, { home = process.env.HOME || '' } = {}) {
  let text = String(value || '');
  text = text.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[REDACTED_PRIVATE_KEY]');
  text = text.replace(/\b(?:gh[pousr]_|github_pat_|sk-(?:proj-)?|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/g, '[REDACTED_TOKEN]');
  text = text.replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED_ACCESS_KEY]');
  text = text.replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]');
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{12,}={0,2}\b/gi, '[REDACTED_AUTH]');
  text = text.replace(/\b(password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*([^\s,;]+)/gi, '$1=[REDACTED_SECRET]');
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED_EMAIL]');
  text = text.replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)/g, '[REDACTED_PHONE]');
  text = text.replace(/\b(?:ou|oc|om|cli|subId)_[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_ID]');
  if (home) text = text.replaceAll(resolve(home), '~');
  return text.replace(/\0/g, '').slice(0, 12_000);
}

function displayPath(filePath, root) {
  const rel = relative(root, filePath);
  return rel && !rel.startsWith('..') ? `~/${rel.split(sep).join('/')}` : basename(filePath);
}

export async function scanLearningFiles({
  roots = [],
  sinceMs = Date.now() - 24 * 60 * 60_000,
  maxFiles = 1_200,
  maxFileBytes = 1024 * 1024,
  maxExcerptChars = 2_000,
  maxDirectories = 2_500,
  maxDurationMs = 25_000,
  onDirectory = null,
} = {}) {
  const results = [];
  let visitedDirectories = 0;
  const deadlineAt = Date.now() + Math.max(1_000, Number(maxDurationMs) || 25_000);
  const visit = async (directory, root, depth) => {
    if (results.length >= maxFiles || depth > 10
      || visitedDirectories >= maxDirectories || Date.now() >= deadlineAt) return;
    if (!isLearningPathAllowed(directory) && resolve(directory) !== resolve(root)) return;
    visitedDirectories += 1;
    if (typeof onDirectory === 'function') onDirectory(directory);
    let stream;
    try { stream = await opendir(directory); } catch { return; }
    for await (const entry of stream) {
      if (results.length >= maxFiles || visitedDirectories >= maxDirectories
        || Date.now() >= deadlineAt) break;
      if (entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (!isLearningPathAllowed(path)) continue;
      if (entry.isDirectory()) {
        if (/\.app$/i.test(entry.name)) continue;
        await visit(path, root, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!ALLOWED_TEXT_EXTENSIONS.has(extension) && entry.name !== 'SKILL.md') continue;
      let info;
      try { info = await stat(path); } catch { continue; }
      if (info.mtimeMs < Number(sinceMs || 0) || info.size <= 0 || info.size > maxFileBytes) continue;
      let excerpt;
      try { excerpt = await readFile(path, 'utf8'); } catch { continue; }
      results.push({
        path: displayPath(path, root),
        modifiedAt: info.mtime.toISOString(),
        excerpt: redactLearningText(excerpt.slice(0, maxExcerptChars)),
      });
    }
  };
  for (const root of roots.map(value => resolve(String(value || ''))).filter(Boolean)) {
    if (Date.now() >= deadlineAt) break;
    await visit(root, root, 0);
    if (results.length >= maxFiles) break;
  }
  return results;
}

export async function scanSkillCatalog({ roots = [], maxSkills = 500 } = {}) {
  const results = [];
  const visit = async (directory, depth) => {
    if (results.length >= maxSkills || depth > 4) return;
    let stream;
    try { stream = await opendir(directory); } catch { return; }
    for await (const entry of stream) {
      if (results.length >= maxSkills || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.git'].includes(entry.name)) continue;
        await visit(path, depth + 1);
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        let source;
        try { source = await readFile(path, 'utf8'); } catch { continue; }
        const frontMatter = source.match(/^---\s*\n([\s\S]*?)\n---/)?.[1] || '';
        const name = frontMatter.match(/^name:\s*["']?([^\n"']+)/m)?.[1]?.trim()
          || basename(directory);
        const description = frontMatter.match(/^description:\s*["']?([^\n"']+)/m)?.[1]?.trim()
          || '';
        if (name) results.push({
          name: redactLearningText(name).slice(0, 120),
          description: redactLearningText(description).slice(0, 300),
        });
      }
    }
  };
  for (const root of roots) await visit(resolve(String(root || '')), 0);
  return results.sort((left, right) => left.name.localeCompare(right.name));
}

export function normalizeLearningResult(value = {}) {
  const allowedCategories = new Set(['task', 'skill', 'error']);
  const lessons = (Array.isArray(value.lessons) ? value.lessons : [])
    .filter(item => allowedCategories.has(item?.category))
    .map(item => ({
      category: item.category,
      title: redactLearningText(item.title).replace(/\s+/g, ' ').trim().slice(0, 160),
      lesson: redactLearningText(item.lesson).replace(/\s+/g, ' ').trim().slice(0, 600),
    }))
    .filter(item => item.title && item.lesson)
    .slice(0, 60);
  const memoryRules = (Array.isArray(value.memoryRules) ? value.memoryRules : [])
    .map(item => redactLearningText(item).replace(/\s+/g, ' ').trim().slice(0, 500))
    .filter(Boolean)
    .slice(0, 30);
  const summary = redactLearningText(value.summary).replace(/\s+/g, ' ').trim().slice(0, 2_000);
  const counts = {
    tasks: lessons.filter(item => item.category === 'task').length,
    skills: lessons.filter(item => item.category === 'skill').length,
    errors: lessons.filter(item => item.category === 'error').length,
  };
  return {
    summary,
    memoryRules,
    lessons,
    counts,
    memory: [summary, ...memoryRules.map((rule, index) => `${index + 1}. ${rule}`)]
      .filter(Boolean).join('\n').slice(0, 12_000),
  };
}

export function parseLearningRuntimeOutput(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] || raw;
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('Daily learning runtime returned no JSON object');
  return normalizeLearningResult(JSON.parse(fenced.slice(start, end + 1)));
}

export function buildDailyLearningPrompt({
  previousMemory = '', conversations = [], audits = [], files = [], skills = [],
} = {}) {
  const evidence = {
    previousMemory: redactLearningText(previousMemory).slice(0, 12_000),
    conversations: conversations.slice(0, 80).map(item => ({
      role: item.role === 'assistant' ? 'assistant' : 'user',
      content: redactLearningText(item.content).slice(0, 600),
      at: item.createdAt || item.created_at || '',
    })),
    audits: audits.slice(0, 120).map(item => ({
      event: String(item.event || '').slice(0, 100),
      detail: redactLearningText(JSON.stringify(item.detail || {})).slice(0, 400),
      at: item.createdAt || item.created_at || '',
    })),
    files: files.slice(0, 50).map(item => ({
      path: redactLearningText(item.path).slice(0, 300),
      excerpt: redactLearningText(item.excerpt).slice(0, 600),
    })),
    skills: skills.slice(0, 180).map(item => ({
      name: redactLearningText(item.name).slice(0, 120),
      description: redactLearningText(item.description).slice(0, 160),
    })),
  };
  return `你是 AIPRO 的本地每日学习引擎。请复盘过去一天的对话、审计、工作文件和已安装 Skill，并刷新长期记忆。\n\n` +
    `要求：\n` +
    `1. 优先总结犯过的错误、根因和以后必须遵守的防错规则。\n` +
    `2. 提炼任务处理方法和可复用 Skill；不要声称完成证据中没有完成的事。\n` +
    `3. 不输出姓名、电话、邮箱、账号 ID、文件原文、聊天原文、密钥或内部链接。\n` +
    `4. previousMemory 是旧记忆：保留仍有效规则，合并重复项，淘汰已失效内容。\n` +
    `5. 只输出 JSON，不要 Markdown。结构必须是：\n` +
    `{"summary":"不超过300字","memoryRules":["长期规则"],"lessons":[{"category":"error|task|skill","title":"短标题","lesson":"脱敏后的经验"}]}\n\n` +
    `脱敏学习证据：\n${JSON.stringify(evidence)}`;
}

export class DailyLearningEngine {
  constructor({
    state,
    runAi,
    home = process.env.HOME || '',
    workdir = '',
    contentRoots = [],
    scanFiles = scanLearningFiles,
    scanSkills = scanSkillCatalog,
  } = {}) {
    if (!state || typeof state.learningEvidence !== 'function') {
      throw new Error('Daily learning requires a persistent AgentState');
    }
    if (typeof runAi !== 'function') throw new Error('Daily learning requires an AI runtime');
    this.state = state;
    this.runAi = runAi;
    this.home = resolve(home || '.');
    this.workdir = resolve(workdir || '.');
    this.contentRoots = [...new Set(
      (contentRoots.length ? contentRoots : [this.workdir]).map(value => resolve(value)),
    )];
    this.scanFiles = scanFiles;
    this.scanSkills = scanSkills;
  }

  async execute({ now = new Date(), reason = 'scheduled' } = {}) {
    const learningDate = learningDateKey(now);
    const runId = `daily-learning-${learningDate}`;
    const sourceToAt = now.toISOString();
    const fallbackFromAt = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
    const sourceFromAt = this.state.get('learning', 'last_source_to_at', fallbackFromAt);
    this.state.startLearningRun({
      id: runId,
      learningDate,
      startedAt: sourceToAt,
      sourceFromAt,
      sourceToAt,
    });
    this.state.audit('daily_learning_started', {
      detail: { learningDate, reason, sourceFromAt, sourceToAt },
    });
    try {
      this.state.set('learning', 'status', {
        state: 'running', stage: 'history', runId, startedAt: sourceToAt,
      });
      const evidence = this.state.learningEvidence(sourceFromAt, sourceToAt);
      this.state.set('learning', 'status', {
        state: 'running', stage: 'files', runId, startedAt: sourceToAt,
        chatsReviewed: evidence.conversations.length,
      });
      const learningRoots = this.contentRoots;
      const files = await this.scanFiles({
        roots: learningRoots,
        sinceMs: Date.parse(sourceFromAt),
      });
      this.state.set('learning', 'status', {
        state: 'running', stage: 'skills', runId, startedAt: sourceToAt,
        filesScanned: files.length, chatsReviewed: evidence.conversations.length,
      });
      const skills = await this.scanSkills({
        roots: [join(this.home, '.codex', 'skills'), join(this.home, '.agents', 'skills')],
      });
      this.state.set('learning', 'status', {
        state: 'running', stage: 'analyzing', runId, startedAt: sourceToAt,
        filesScanned: files.length, chatsReviewed: evidence.conversations.length,
      });
      const prompt = buildDailyLearningPrompt({
        previousMemory: this.state.get('learning', 'memory', ''),
        conversations: evidence.conversations,
        audits: evidence.audits,
        files,
        skills,
      });
      const runtime = await this.runAi(prompt);
      const learned = parseLearningRuntimeOutput(runtime?.text || runtime);
      const completedAt = new Date().toISOString();
      this.state.completeLearningRun(runId, {
        completedAt,
        summary: learned.summary,
        memory: learned.memory,
        filesScanned: files.length,
        chatsReviewed: evidence.conversations.length,
        tasksLearned: learned.counts.tasks,
        skillsLearned: learned.counts.skills,
        errorsLearned: learned.counts.errors,
        items: learned.lessons,
      });
      this.state.set('learning', 'last_source_to_at', sourceToAt);
      this.state.audit('daily_learning_completed', {
        detail: {
          learningDate,
          reason,
          filesScanned: files.length,
          chatsReviewed: evidence.conversations.length,
          tasksLearned: learned.counts.tasks,
          skillsLearned: learned.counts.skills,
          errorsLearned: learned.counts.errors,
        },
      });
      return { learningDate, ...learned };
    } catch (error) {
      this.state.failLearningRun(runId, error?.message || error);
      this.state.audit('daily_learning_failed', {
        detail: { learningDate, reason, error: String(error?.message || error).slice(0, 1000) },
      });
      throw error;
    }
  }
}
