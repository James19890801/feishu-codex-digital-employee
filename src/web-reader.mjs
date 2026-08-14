import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent } from 'undici';

const ALLOWED_CONTENT_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'application/json',
]);
const TRAILING_PUNCTUATION = /[，。！？；：、）】》”’.,!?;:)\]}>'"]+$/;
const BROWSER_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
  + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15';
const WECHAT_ARTICLE_MAX_BYTES = 6 * 1024 * 1024;

function isWechatArticleUrl(url) {
  return url.hostname.toLowerCase() === 'mp.weixin.qq.com';
}

function ipv4Parts(address) {
  const parts = String(address).split('.').map(Number);
  return parts.length === 4 && parts.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

export function isPublicAddress(address) {
  const value = String(address || '').toLowerCase().split('%')[0];
  const version = isIP(value);
  if (!version) return false;
  if (version === 4) {
    const [a, b, c] = ipv4Parts(value);
    return !(a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)
      || (a >= 224));
  }
  if (value === '::' || value === '::1') return false;
  if (value.startsWith('fc') || value.startsWith('fd') || /^fe[89ab]/.test(value)) return false;
  if (value.startsWith('ff')) return false;
  if (value.startsWith('::ffff:') || value.startsWith('64:ff9b:')) return false;
  if (value.startsWith('2001:db8:') || value.startsWith('2001:0:')) return false;
  const firstGroup = parseInt(value.split(':')[0], 16);
  return Number.isInteger(firstGroup) && firstGroup >= 0x2000 && firstGroup <= 0x3fff;
}

export function extractHttpUrls(text = '', limit = 3) {
  const matches = String(text || '').match(/https?:\/\/[^\s<>，。！？；：、（）【】《》“”‘’]+/gi) || [];
  return [...new Set(matches.map(value => value
    .replace(TRAILING_PUNCTUATION, '')
    .replace(/&amp;/gi, '&')))]
    .filter(Boolean)
    .slice(0, Math.max(0, Number(limit) || 0));
}

export function resolveInboundLinkUrls({ text = '', linkCandidate = null, limit = 3 } = {}) {
  const maximum = Math.max(0, Number(limit) || 0);
  if (!maximum) return [];
  const candidates = [];
  const candidateUrl = String(linkCandidate?.url || '').trim();
  if (candidateUrl) {
    try {
      const parsed = new URL(candidateUrl);
      if (['http:', 'https:'].includes(parsed.protocol)) candidates.push(parsed.href);
    } catch { /* ignore malformed card URL */ }
  }
  candidates.push(...extractHttpUrls(text, maximum));
  return [...new Set(candidates)].slice(0, maximum);
}

function decodeEntities(value) {
  const named = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"],
    ['nbsp', ' '], ['ensp', ' '], ['emsp', ' '], ['copy', '©'],
  ]);
  return String(value || '')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => named.get(name.toLowerCase()) ?? match);
}

export function extractReadableWebText(html = '', maxChars = 40_000) {
  let value = String(html || '');
  value = value
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|canvas|noscript|template|nav|footer|header|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|article|main|h[1-6]|li|tr|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  return decodeEntities(value)
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, Math.max(1, Number(maxChars) || 40_000));
}

function pageTitle(html) {
  const match = String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? extractReadableWebText(match[1], 300) : '';
}

function githubRepositoryReadmeUrl(url) {
  if (url.hostname.toLowerCase() !== 'github.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length !== 2 || !/^[\w.-]+$/.test(parts[0]) || !/^[\w.-]+$/.test(parts[1])) return null;
  return new URL(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/HEAD/README.md`);
}

export async function validatedAddresses(url, lookup) {
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new Error('Web address is not public');
  }
  const records = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(record => !isPublicAddress(record.address))) {
    throw new Error('Web address is not public');
  }
  return records;
}

export function createPinnedLookup(records) {
  let index = 0;
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback;
    const settings = typeof options === 'object' && options !== null ? options : {};
    if (settings.all === true) {
      done(null, records.map(record => ({ address: record.address, family: record.family })));
      return;
    }
    const candidates = Number(settings.family)
      ? records.filter(record => record.family === Number(settings.family))
      : records;
    const record = candidates[index++ % candidates.length];
    if (!record) {
      const error = new Error('No validated address matches the requested family');
      error.code = 'ENOTFOUND';
      done(error);
      return;
    }
    done(null, record.address, record.family);
  };
}

export function defaultDispatcherFactory(records) {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(records),
    },
  });
}

async function limitedText(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Web page exceeds size limit');
  if (!response.body?.getReader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('Web page exceeds size limit');
    return new TextDecoder().decode(bytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error('Web page exceeds size limit');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readPublicWebPage(sourceUrl, {
  fetchImpl = globalThis.fetch,
  lookup = dnsLookup,
  dispatcherFactory = defaultDispatcherFactory,
  timeoutMs = 12_000,
  maxBytes = 2 * 1024 * 1024,
  maxChars = 40_000,
  maxRedirects = 3,
} = {}) {
  const requested = new URL(String(sourceUrl || ''));
  let current = githubRepositoryReadmeUrl(requested) || requested;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (!['http:', 'https:'].includes(current.protocol)
      || current.username || current.password || current.port) {
      throw new Error('Only public HTTP(S) web addresses without credentials or custom ports are allowed');
    }
    const records = await validatedAddresses(current, lookup);
    const dispatcher = dispatcherFactory(records, current);
    const wechatArticle = isWechatArticleUrl(current);
    try {
      const response = await fetchImpl(current, {
        method: 'GET',
        headers: {
          accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.8',
          'user-agent': wechatArticle ? BROWSER_USER_AGENT : 'AIPRO-WebReader/1.0',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === maxRedirects) throw new Error('Web page redirected too many times');
        const location = response.headers.get('location');
        if (!location) throw new Error('Web page redirect has no location');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`Web page returned HTTP ${response.status}`);
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new Error(`Unsupported web content type: ${contentType || 'unknown'}`);
      }
      const raw = await limitedText(
        response,
        wechatArticle ? Math.max(maxBytes, WECHAT_ARTICLE_MAX_BYTES) : maxBytes,
      );
      const html = ['text/html', 'application/xhtml+xml'].includes(contentType);
      const text = html ? extractReadableWebText(raw, maxChars) : raw.trim().slice(0, maxChars);
      if (!text) throw new Error('Web page has no readable text');
      if (wechatArticle && /(?:环境异常[\s\S]{0,80}(?:完成验证|验证)|完成验证后继续访问|访问过于频繁)/i.test(text)) {
        throw new Error('WeChat article requires browser verification');
      }
      return {
        url: requested.href,
        title: html ? pageTitle(raw) : '',
        contentType,
        text,
      };
    } finally {
      await dispatcher?.close?.().catch?.(() => {});
    }
  }
  throw new Error('Web page redirect handling failed');
}
