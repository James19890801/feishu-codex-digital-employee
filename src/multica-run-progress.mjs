import { createHash } from 'node:crypto';
import { multicaIssueUrl } from './multica-links.mjs';

const RUNNING = new Set(['RUNNING', 'IN_PROGRESS', 'PROCESSING', 'STARTED']);
const QUEUED = new Set(['PENDING', 'QUEUED', 'CREATED', 'WAITING']);
const COMPLETED = new Set(['COMPLETED', 'DONE', 'SUCCEEDED', 'SUCCESS']);
const FAILED = new Set(['FAILED', 'ERROR', 'CANCELLED', 'CANCELED', 'TIMED_OUT']);

function statusOf(run) {
  return String(run?.status || '').trim().toUpperCase();
}

function timestampOf(run) {
  return String(
    run?.completed_at || run?.updated_at || run?.started_at || run?.created_at || '',
  );
}

function resultText(run) {
  const result = run?.result;
  const value = typeof result === 'string'
    ? result
    : result?.output || result?.summary || result?.message || run?.output || '';
  const text = String(value || '').trim();
  return text.length > 1200 ? `${text.slice(0, 1199).trimEnd()}…` : text;
}

function chineseCount(value) {
  return ({ 1: '一次', 2: '两次', 3: '三次', 4: '四次', 5: '五次' })[value]
    || `${value} 次`;
}

export function looksLikeMulticaProgressRequest(text) {
  const normalized = String(text || '').trim();
  if (!normalized || /(?:创建|新建|新增).{0,8}(?:issue|任务)/i.test(normalized)) return false;
  return /(?:任务|issue|专家团|小队).{0,20}(?:进度|状态|干活|执行到|开始了吗|完成了吗|跑了吗|做得怎么样)|(?:进度|状态|干活|执行到|开始了吗|完成了吗).{0,20}(?:任务|issue|专家团|小队)/i
    .test(normalized);
}

export function desiredIssueStatusForRunState(runState, currentStatus) {
  const state = String(runState || '').trim().toLowerCase();
  const current = String(currentStatus || '').trim().toLowerCase();
  if (['done', 'cancelled'].includes(current)) return '';
  if (['queued', 'running'].includes(state) && ['backlog', 'todo'].includes(current)) {
    return 'in_progress';
  }
  if (state === 'completed'
    && ['backlog', 'todo', 'in_progress', 'in_review', 'blocked'].includes(current)) {
    return 'done';
  }
  if (state === 'failed'
    && ['backlog', 'todo', 'in_progress', 'in_review'].includes(current)) {
    return 'blocked';
  }
  return '';
}

export function summarizeMulticaRuns(issue, runs, { appUrl } = {}) {
  const normalizedRuns = Array.isArray(runs) ? runs.map(run => structuredClone(run)) : [];
  normalizedRuns.sort((a, b) => timestampOf(a).localeCompare(timestampOf(b)));
  const statuses = normalizedRuns.map(statusOf);
  let state = 'not_started';
  if (statuses.some(status => RUNNING.has(status))) state = 'running';
  else if (statuses.some(status => QUEUED.has(status))) state = 'queued';
  else if (statuses.some(status => FAILED.has(status))) state = 'failed';
  else if (statuses.length && statuses.every(status => COMPLETED.has(status))) state = 'completed';
  else if (statuses.length) state = 'unknown';

  const latest = normalizedRuns.at(-1) || null;
  const latestResult = [...normalizedRuns].reverse().map(resultText).find(Boolean) || '';
  const identifier = String(issue?.identifier || '当前 Issue');
  const title = String(issue?.title || '未命名 Issue');
  const stateLine = state === 'completed'
    ? `${chineseCount(normalizedRuns.length)}专家执行均已完成。`
    : state === 'running'
      ? `正在执行（共 ${normalizedRuns.length} 条运行记录）。`
      : state === 'queued'
        ? `已进入队列，等待执行（共 ${normalizedRuns.length} 条运行记录）。`
        : state === 'failed'
          ? `最近的专家执行失败或被取消（共 ${normalizedRuns.length} 条运行记录）。`
          : state === 'not_started'
            ? '还没有运行记录，任务尚未真正启动。'
            : `已有 ${normalizedRuns.length} 条运行记录，但状态暂时无法识别。`;
  const issueStatus = String(issue?.status || '未设置');
  const issueStateWarning = state === 'completed' && issueStatus !== 'done'
    ? `注意：专家工作已完成，但 Issue 本身仍是“${issueStatus === 'todo' ? '待处理' : issueStatus}”，这两个状态此前没有联动。`
    : '';
  const link = multicaIssueUrl(issue, appUrl);
  const text = [
    `${identifier} · ${title}`,
    stateLine,
    ...(latestResult ? [`最新交付：${latestResult}`] : []),
    ...(issueStateWarning ? [issueStateWarning] : []),
    ...(link ? [`查看：${link}`] : []),
  ].join('\n');
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(normalizedRuns.map(run => ({
      id: run.id,
      status: statusOf(run),
      updatedAt: timestampOf(run),
      result: resultText(run),
    }))))
    .digest('hex');
  return {
    state,
    text,
    fingerprint,
    runCount: normalizedRuns.length,
    latestUpdatedAt: timestampOf(latest),
  };
}
