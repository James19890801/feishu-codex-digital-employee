function normalizedTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function readablePage(page) {
  const text = String(page?.text || '').trim();
  return text.length >= 60 ? { ...page, text, source: 'public_web' } : null;
}

export function exactLocalArticlePage(index, title) {
  const expectedTitle = normalizedTitle(title);
  if (!expectedTitle || index?.version !== 1) return null;
  const sources = (Array.isArray(index.sources) ? index.sources : [])
    .filter(source => source?.kind === 'html' && normalizedTitle(source.title) === expectedTitle);
  if (sources.length !== 1) return null;
  const sourceHandle = String(sources[0].handle || '');
  if (!sourceHandle) return null;
  const text = (Array.isArray(index.chunks) ? index.chunks : [])
    .filter(chunk => chunk?.safe === true && chunk.sourceHandle === sourceHandle)
    .sort((a, b) => String(a.id || '').localeCompare(String(b.id || ''), 'en'))
    .map(chunk => String(chunk.text || '').trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 30_000);
  if (text.length < 60) return null;
  return {
    title: String(sources[0].title || title).trim().slice(0, 200),
    text,
    contentType: 'text/html',
    source: 'local_exact_title',
  };
}

export async function readOwnerArticlePage(url, { title = '' } = {}, {
  readPublicPage,
  loadLocalIndex,
} = {}) {
  if (typeof readPublicPage !== 'function' || typeof loadLocalIndex !== 'function') {
    throw new Error('Owner article reader requires public and local readers');
  }
  let publicError = null;
  try {
    const page = readablePage(await readPublicPage(url));
    if (page) return page;
  } catch (error) {
    publicError = error;
  }
  let localPage = null;
  try {
    localPage = exactLocalArticlePage(await loadLocalIndex(), title);
  } catch { /* keep the original public failure */ }
  if (localPage) return { ...localPage, url };
  if (publicError) throw publicError;
  throw new Error('article_text_unavailable');
}
