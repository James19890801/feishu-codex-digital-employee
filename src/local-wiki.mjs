import { readFile } from 'node:fs/promises';

function terms(query) {
  const chunks = String(query || '').toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9_-]{2,}/gu) || [];
  return [...new Set(chunks.flatMap(chunk => {
    if (!/^[\p{Script=Han}]+$/u.test(chunk) || chunk.length <= 2) return [chunk];
    return [chunk, ...Array.from({ length: chunk.length - 1 }, (_, index) => chunk.slice(index, index + 2))];
  }))];
}

export async function searchLocalWiki(query, {
  indexPath,
  senderId,
  ownerId,
  limit = 3,
  maxChars = 12000,
} = {}) {
  if (!senderId || senderId !== ownerId || !indexPath) return [];
  const needles = terms(query);
  if (!needles.length) return [];
  let index;
  try { index = JSON.parse(await readFile(indexPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  let used = 0;
  return (Array.isArray(index.records) ? index.records : [])
    .map(record => {
      const title = String(record.title || '').toLowerCase();
      const body = String(record.text || '').toLowerCase();
      const score = needles.reduce((total, term) => total + (title.includes(term) ? 4 : 0) + (body.includes(term) ? 1 : 0), 0);
      return { record, score };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || String(b.record.date || '').localeCompare(String(a.record.date || '')))
    .slice(0, limit)
    .flatMap(({ record }) => {
      const remaining = maxChars - used;
      if (remaining <= 0) return [];
      const text = String(record.text || '').slice(0, remaining);
      used += text.length;
      return [{ ...record, text }];
    });
}

export function localWikiContext(records = []) {
  if (!records.length) return '';
  return records.map(record => `《${record.title}》\n${record.text}\n来源：${record.locator || '本地知识库'}`).join('\n\n---\n\n');
}
