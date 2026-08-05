const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const SAFE_KQL_VALUE_PATTERN = /^[\p{L}\p{N}@._-]+$/u;
const KQL_OPERATOR_PATTERN = /^(?:AND|OR|NOT)$/iu;

function clean(value = '') {
  return String(value).trim().replace(/[。！!]+$/u, '').trim();
}

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 30)) : 10;
}

function shanghaiDayStart(now) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]),
  );
  return new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - 8 * 60 * 60 * 1000).toISOString();
}

export function escapeKqlValue(value) {
  const normalized = clean(value);
  if (!normalized) throw new TypeError('KQL value is required');
  if (CONTROL_CHARACTER_PATTERN.test(normalized)) throw new TypeError('KQL value contains a control character');
  if (SAFE_KQL_VALUE_PATTERN.test(normalized) && !KQL_OPERATOR_PATTERN.test(normalized)) return normalized;
  return `"${normalized.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
}

export function buildMailKql(filters = {}) {
  const clauses = [];
  if (filters.folderId != null) clauses.push(`folderId:${Number(filters.folderId)}`);
  if (filters.isRead != null) clauses.push(`isRead:${Boolean(filters.isRead)}`);
  if (filters.hasAttachments != null) clauses.push(`hasAttachments:${Boolean(filters.hasAttachments)}`);
  for (const [key, operator] of [['after', 'date>'], ['before', 'date<']]) {
    if (!filters[key]) continue;
    const value = new Date(filters[key]);
    if (Number.isNaN(value.getTime())) throw new TypeError(`Invalid ${key} date`);
    clauses.push(`${operator}${value.toISOString()}`);
  }
  for (const key of ['from', 'to', 'subject', 'body']) {
    if (filters[key]) clauses.push(`${key}:${escapeKqlValue(filters[key])}`);
  }
  return clauses.length ? clauses.join(' AND ') : 'folderId:2';
}

export function parseMailWriteDraft(input) {
  const text = clean(input);
  let match = text.match(/^回复全部第\s*(\d+)\s*封(?:邮件)?\s*[，,]?\s*正文[：:]\s*(.+)$/u);
  if (match) return { operation: 'reply_all', selection: Number(match[1]), recipient: '', cc: [], subject: '', content: clean(match[2]), note: '' };
  match = text.match(/^回复第\s*(\d+)\s*封(?:邮件)?\s*[，,]?\s*正文[：:]\s*(.+)$/u);
  if (match) return { operation: 'reply', selection: Number(match[1]), recipient: '', cc: [], subject: '', content: clean(match[2]), note: '' };
  match = text.match(/^转发第\s*(\d+)\s*封(?:邮件)?给\s*(.+?)\s*[，,]\s*附言[：:]\s*(.+)$/u);
  if (match) return { operation: 'forward', selection: Number(match[1]), recipient: clean(match[2]), cc: [], subject: '', content: '', note: clean(match[3]) };
  match = text.match(/^给\s*(.+?)\s*发邮件\s*[，,]\s*(.+)$/u);
  if (!match) return null;
  const recipient = clean(match[1]);
  const remainder = match[2];
  const cc = remainder.match(/(?:^|[，,])\s*抄送[：:]\s*(.+?)(?=[，,]\s*(?:主题|正文)[：:]|$)/u)?.[1]
    ?.split(/[、;；]/u).map(clean).filter(Boolean) ?? [];
  const subject = clean(remainder.match(/(?:^|[，,])\s*主题[：:]\s*(.+?)(?=[，,]\s*(?:抄送|正文)[：:]|$)/u)?.[1] ?? '');
  const content = clean(remainder.match(/(?:^|[，,])\s*正文[：:]\s*(.+)$/u)?.[1] ?? '');
  return { operation: 'send', selection: null, recipient, cc, subject, content, note: '' };
}

export function parseMailIntent(input, { now = new Date() } = {}) {
  const text = clean(input);
  const draft = parseMailWriteDraft(text);
  if (draft) return { kind: draft.operation === 'reply_all' ? 'reply' : draft.operation, selection: draft.selection, draft, limit: 10, filters: {} };

  const openMatch = text.match(/^打开第\s*(\d+)\s*封(?:邮件)?$/u);
  if (openMatch) return { kind: 'open', selection: Number(openMatch[1]), draft: null, limit: 10, filters: {} };

  const isMailSearch = /(?:邮件|收件箱|已发送)/u.test(text) && /(?:查|看看|最近|未读|已发送|收件箱|主题|正文)/u.test(text);
  if (!isMailSearch) return { kind: null, selection: null, draft: null, limit: 10, filters: {} };

  const filters = { folderId: /已发送/u.test(text) ? 1 : 2 };
  if (/未读/u.test(text)) filters.isRead = false;
  if (/带附件/u.test(text)) filters.hasAttachments = true;
  if (/今天/u.test(text)) filters.after = shanghaiDayStart(now);
  const fromMatch = text.match(/查\s*(.+?)发的/u);
  if (fromMatch) filters.from = clean(fromMatch[1]);
  const subjectMatch = text.match(/主题包含[：:]?\s*[「“"]?(.+?)[」”"]?(?=\s*(?:并且|且|带附件|的邮件|邮件|$))/u);
  if (subjectMatch) filters.subject = clean(subjectMatch[1]);
  const bodyMatch = text.match(/正文包含[：:]?\s*(.+?)(?=\s*的?邮件|$)/u);
  if (bodyMatch) filters.body = clean(bodyMatch[1]);
  const limit = clampLimit(text.match(/最近\s*(\d+)\s*封/u)?.[1]);
  return { kind: 'search', selection: null, draft: null, limit, filters };
}

export function isMailConfirmation(input) {
  return /^(?:确认|确认发送|发送)[。！!]?$/u.test(String(input).trim());
}

export function isMailCancellation(input) {
  return /^(?:取消|不发了|算了)[。！!]?$/u.test(String(input).trim());
}
