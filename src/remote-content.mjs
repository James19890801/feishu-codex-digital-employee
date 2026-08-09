import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import {
  defaultDispatcherFactory,
  validatedAddresses,
} from './web-reader.mjs';

const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);
const WEB_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'text/plain', 'application/json',
]);
const MIME_EXTENSIONS = new Map([
  ['application/pdf', '.pdf'],
  ['application/msword', '.doc'],
  ['application/vnd.ms-excel', '.xls'],
  ['application/vnd.ms-powerpoint', '.ppt'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.xlsx'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', '.pptx'],
  ['text/html', '.html'],
  ['application/json', '.json'],
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['audio/mpeg', '.mp3'],
  ['video/mp4', '.mp4'],
]);

export function classifyContentType(value = '') {
  const type = String(value || '').split(';')[0].trim().toLowerCase();
  if (WEB_TYPES.has(type)) return 'web';
  if (DOCUMENT_TYPES.has(type)) return 'document';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return 'file';
}

function decodedDispositionFileName(value = '') {
  const encoded = String(value).match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')); } catch { /* fallback */ }
  }
  return String(value).match(/filename\s*=\s*"([^"]+)"/i)?.[1]
    || String(value).match(/filename\s*=\s*([^;]+)/i)?.[1]?.trim()
    || '';
}

function safeFileName(value) {
  return basename(String(value || '').replaceAll('\0', '')).replace(/[\r\n]/g, '').slice(0, 180);
}

export function responseFileName({ contentDisposition = '', sourceUrl, mimeType = '' } = {}) {
  const disposition = safeFileName(decodedDispositionFileName(contentDisposition));
  const urlName = safeFileName(new URL(String(sourceUrl || '')).pathname);
  const extension = MIME_EXTENSIONS.get(String(mimeType).split(';')[0].toLowerCase()) || '.bin';
  const selected = disposition || urlName || `download${extension}`;
  return extname(selected) ? selected : `${selected}${extension}`;
}

async function limitedBytes(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxBytes) throw new Error('Remote content exceeds size limit');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error('Remote content exceeds size limit');
    return bytes;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('Remote content exceeds size limit');
        throw new Error('Remote content exceeds size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function downloadPublicContent(sourceUrl, outputDir, {
  fetchImpl = globalThis.fetch,
  lookup = dnsLookup,
  dispatcherFactory = defaultDispatcherFactory,
  timeoutMs = 20_000,
  maxBytes = 100 * 1024 * 1024,
  maxRedirects = 3,
} = {}) {
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  let current = new URL(String(sourceUrl || ''));
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    if (!['http:', 'https:'].includes(current.protocol)
      || current.username || current.password || current.port) {
      throw new Error('Only public HTTP(S) addresses without credentials or custom ports are allowed');
    }
    const records = await validatedAddresses(current, lookup);
    const dispatcher = dispatcherFactory(records, current);
    try {
      const response = await fetchImpl(current, {
        method: 'GET',
        headers: { accept: '*/*', 'user-agent': 'AIPRO-ContentResolver/1.0' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        dispatcher,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirect === maxRedirects) throw new Error('Remote content redirected too many times');
        const location = response.headers.get('location');
        if (!location) throw new Error('Remote content redirect has no location');
        current = new URL(location, current);
        continue;
      }
      if (!response.ok) throw new Error(`Remote content returned HTTP ${response.status}`);
      const mimeType = String(response.headers.get('content-type') || 'application/octet-stream')
        .split(';')[0].trim().toLowerCase();
      const fileName = responseFileName({
        contentDisposition: response.headers.get('content-disposition') || '',
        sourceUrl: current.href,
        mimeType,
      });
      const prefix = randomUUID();
      const finalPath = join(outputDir, `${prefix}-${fileName}`);
      const partialPath = `${finalPath}.part`;
      try {
        const bytes = await limitedBytes(response, maxBytes);
        await writeFile(partialPath, bytes, { mode: 0o600 });
        await rename(partialPath, finalPath);
        return {
          url: current.href,
          path: finalPath,
          fileName,
          mimeType,
          kind: classifyContentType(mimeType),
          bytes: bytes.byteLength,
        };
      } catch (error) {
        await rm(partialPath, { force: true }).catch(() => {});
        throw error;
      }
    } finally {
      await dispatcher?.close?.().catch?.(() => {});
    }
  }
  throw new Error('Remote content redirect handling failed');
}
