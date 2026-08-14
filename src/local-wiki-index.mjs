import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import {
  abstractPrivateKnowledge,
  isExcludedKnowledgePath,
  isLikelyKnowledgeHtml,
  isLikelyProfessionalKnowledgeFile,
  isSafeKnowledgeEvidence,
  opaqueSourceHandle,
  safeKnowledgeTitle,
} from './local-wiki-policy.mjs';

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return String(value).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? ' ';
  });
}

function textFromHtml(html) {
  return decodeEntities(String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|canvas|nav|footer|form|button)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|h[1-6]|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line && !/^(?:一键复制|复制全文|返回顶部|扫码关注)$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function chunkText(text, { targetChars = 1200, overlapChars = 120 } = {}) {
  const paragraphs = String(text || '').split(/\n+/).map(value => value.trim()).filter(Boolean);
  const chunks = [];
  let current = '';
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 1 > targetChars) {
      chunks.push(current);
      current = `${current.slice(-overlapChars)}\n${paragraph}`;
    } else {
      current += `${current ? '\n' : ''}${paragraph}`;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter(value => value.length >= 40);
}

export function tokenizeKnowledge(value = '') {
  const normalized = String(value || '').toLowerCase();
  const latin = normalized.match(/[a-z][a-z0-9+.#_-]{1,30}/g) || [];
  const chineseRuns = normalized.match(/[\u3400-\u9fff]{2,}/g) || [];
  const chinese = chineseRuns.flatMap(run => {
    const terms = [run];
    for (let size = 2; size <= Math.min(4, run.length); size += 1) {
      for (let index = 0; index + size <= run.length; index += 1) terms.push(run.slice(index, index + size));
    }
    return terms;
  });
  return [...new Set([...latin, ...chinese])].slice(0, 800);
}

export function extractKnowledgeFromHtml(html = '') {
  const source = String(html || '');
  const titleHtml = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    || source.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]
    || '知识条目';
  const title = safeKnowledgeTitle(textFromHtml(titleHtml));
  const abstracted = abstractPrivateKnowledge(textFromHtml(source));
  const chunks = abstracted.safe
    ? chunkText(abstracted.text).filter(isSafeKnowledgeEvidence)
    : [];
  return {
    title,
    text: abstracted.text,
    safe: abstracted.safe,
    redactionCount: abstracted.redactionCount,
    chunks,
  };
}

export function extractKnowledgeFromText(text = '', { title = '知识条目' } = {}) {
  const cleanTitle = basename(String(title || '知识条目'), extname(String(title || '')))
    .replace(/\s+/g, ' ')
    .trim();
  const abstracted = abstractPrivateKnowledge(String(text || ''));
  const chunks = abstracted.safe
    ? chunkText(abstracted.text).filter(isSafeKnowledgeEvidence)
    : [];
  return {
    title: safeKnowledgeTitle(cleanTitle),
    text: abstracted.text,
    safe: abstracted.safe,
    redactionCount: abstracted.redactionCount,
    chunks,
  };
}

async function walk(root, { outputDir = '', maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const files = [];
  let excludedCount = 0;
  const output = outputDir ? resolve(outputDir) : '';
  const visit = async path => {
    if ((output && resolve(path).startsWith(`${output}/`)) || isExcludedKnowledgePath(path)) {
      excludedCount += 1;
      return;
    }
    let info;
    try { info = await lstat(path); } catch { return; }
    if (info.isSymbolicLink()) { excludedCount += 1; return; }
    if (info.isDirectory()) {
      let entries;
      try { entries = await readdir(path); } catch { return; }
      for (const entry of entries) await visit(join(path, entry));
      return;
    }
    if (!info.isFile() || extname(path).toLowerCase() !== '.html' || info.size > maxFileBytes) return;
    let html;
    try { html = await readFile(path, 'utf8'); } catch { return; }
    if (isLikelyKnowledgeHtml({ path, html })) files.push({
      kind: 'html', path, html, bytes: info.size, mtimeMs: info.mtimeMs,
    });
  };
  await visit(root);
  return { files, excludedCount };
}

export async function inventoryKnowledgeHtml({ roots = [], outputDir = '' } = {}) {
  const files = [];
  let excludedCount = 0;
  for (const root of roots) {
    const result = await walk(resolve(root), { outputDir });
    files.push(...result.files);
    excludedCount += result.excludedCount;
  }
  return { files, excludedCount };
}

async function walkDocuments(root, {
  outputDir = '',
  maxFileBytes = DEFAULT_MAX_DOCUMENT_BYTES,
} = {}) {
  const files = [];
  let excludedCount = 0;
  const output = outputDir ? resolve(outputDir) : '';
  const visit = async path => {
    if ((output && resolve(path).startsWith(`${output}/`)) || isExcludedKnowledgePath(path)) {
      excludedCount += 1;
      return;
    }
    let info;
    try { info = await lstat(path); } catch { return; }
    if (info.isSymbolicLink()) { excludedCount += 1; return; }
    if (info.isDirectory()) {
      let entries;
      try { entries = await readdir(path); } catch { return; }
      for (const entry of entries) await visit(join(path, entry));
      return;
    }
    if (!info.isFile() || info.size > maxFileBytes || !isLikelyProfessionalKnowledgeFile(path)) return;
    files.push({ kind: 'document', path, bytes: info.size, mtimeMs: info.mtimeMs });
  };
  await visit(root);
  return { files, excludedCount };
}

export async function inventoryKnowledgeSources({
  htmlRoots = [],
  documentRoots = [],
  outputDir = '',
} = {}) {
  const html = await inventoryKnowledgeHtml({ roots: htmlRoots, outputDir });
  const files = [...html.files];
  let excludedCount = html.excludedCount;
  for (const root of documentRoots) {
    const result = await walkDocuments(resolve(root), { outputDir });
    files.push(...result.files);
    excludedCount += result.excludedCount;
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, excludedCount };
}

async function atomicJson(path, value) {
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

export async function buildLocalWiki({
  roots = [],
  documentRoots = [],
  outputDir,
  extractDocumentText,
} = {}) {
  if (!outputDir) throw new Error('Local Wiki outputDir is required');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  await mkdir(join(outputDir, 'wiki'), { recursive: true, mode: 0o700 });
  let previous = { sources: [] };
  try { previous = JSON.parse(await readFile(join(outputDir, 'index.json'), 'utf8')); } catch { /* first build */ }
  const previousSources = new Map((previous.sources || []).map(item => [item.handle, item]));
  const previousChunks = new Map();
  for (const chunk of previous.chunks || []) {
    if (!previousChunks.has(chunk.sourceHandle)) previousChunks.set(chunk.sourceHandle, []);
    previousChunks.get(chunk.sourceHandle).push(chunk);
  }
  const previousAliases = new Map((previous.aliases || []).map(item => [item.handle, item]));
  const inventory = await inventoryKnowledgeSources({
    htmlRoots: roots,
    documentRoots,
    outputDir,
  });
  const sources = [];
  const chunks = [];
  const aliases = [];
  const contentHashes = new Map();
  let updatedCount = 0;
  let unchangedCount = 0;
  let skippedSensitiveCount = 0;
  let duplicateCount = 0;
  let extractionFailureCount = 0;
  for (const file of inventory.files) {
    const handle = opaqueSourceHandle(file.path);
    const fingerprint = createHash('sha256')
      .update(`${file.kind}:${file.bytes}:${Math.trunc(file.mtimeMs)}`)
      .digest('hex');
    const previousSource = previousSources.get(handle);
    const previousAlias = previousAliases.get(handle);
    if (previousAlias?.fingerprint === fingerprint) {
      aliases.push(previousAlias);
      duplicateCount += 1;
      continue;
    }
    if (previousSource?.fingerprint === fingerprint && previousChunks.has(handle)) {
      if (contentHashes.has(previousSource.hash)) {
        aliases.push({ handle, fingerprint, hash: previousSource.hash });
        duplicateCount += 1;
        continue;
      }
      const reusedChunks = previousChunks.get(handle);
      sources.push(previousSource);
      chunks.push(...reusedChunks);
      contentHashes.set(previousSource.hash, handle);
      unchangedCount += 1;
      continue;
    }
    let extracted;
    if (file.kind === 'html') {
      extracted = extractKnowledgeFromHtml(file.html);
    } else {
      if (typeof extractDocumentText !== 'function') {
        throw new Error('Local Wiki document extractor is required');
      }
      try {
        const result = await extractDocumentText(file.path);
        const text = typeof result === 'string' ? result : result?.text;
        extracted = extractKnowledgeFromText(text, { title: basename(file.path) });
      } catch {
        extractionFailureCount += 1;
        continue;
      }
    }
    if (!extracted.safe || !extracted.chunks.length) { skippedSensitiveCount += 1; continue; }
    const hash = createHash('sha256').update(extracted.text).digest('hex');
    if (contentHashes.has(hash)) {
      aliases.push({ handle, fingerprint, hash });
      duplicateCount += 1;
      continue;
    }
    updatedCount += 1;
    sources.push({
      handle,
      hash,
      fingerprint,
      modifiedAt: new Date(file.mtimeMs).toISOString(),
      title: extracted.title,
      kind: file.kind,
    });
    contentHashes.set(hash, handle);
    extracted.chunks.forEach((text, index) => chunks.push({
      id: `${handle}_${index + 1}`,
      sourceHandle: handle,
      title: extracted.title,
      text,
      terms: tokenizeKnowledge(`${extracted.title}\n${text}`),
      safe: true,
    }));
    const wiki = `---\ntitle: ${JSON.stringify(extracted.title)}\nsource: ${handle}\ncontent_hash: ${hash}\n---\n\n# ${extracted.title}\n\n${extracted.text}\n`;
    await writeFile(join(outputDir, 'wiki', `${handle}.md`), wiki, { mode: 0o600 });
  }
  sources.sort((a, b) => a.handle.localeCompare(b.handle));
  chunks.sort((a, b) => a.id.localeCompare(b.id));
  aliases.sort((a, b) => a.handle.localeCompare(b.handle));
  const index = {
    version: 1,
    builtAt: new Date().toISOString(),
    roots: roots.length,
    sources,
    chunks,
    aliases,
    excludedCount: inventory.excludedCount,
    skippedSensitiveCount,
    duplicateCount,
    extractionFailureCount,
  };
  await atomicJson(join(outputDir, 'index.json'), index);
  await writeFile(join(outputDir, 'wiki', 'index.md'), [
    '# Local Wiki', '',
    ...sources.map(item => `- [${item.title}](./${item.handle}.md)`), '',
  ].join('\n'), { mode: 0o600 });
  return {
    sourceCount: sources.length,
    chunkCount: chunks.length,
    updatedCount,
    unchangedCount,
    excludedCount: inventory.excludedCount,
    skippedSensitiveCount,
    duplicateCount,
    extractionFailureCount,
  };
}
