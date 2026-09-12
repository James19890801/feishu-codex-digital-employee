import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';

const execFileAsync = promisify(execFile);
const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const PATCHED = Symbol.for('aipro.wechatEdgeArtifactRelay.patched');

function contentType(fileName) {
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.zip': 'application/zip',
  })[extname(fileName).toLowerCase()] || 'application/octet-stream';
}

function relayOrigin(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Artifact relay origin must be an HTTPS origin');
  }
  return url.origin;
}

export async function uploadRelayArtifact({
  path,
  fileName,
  ttlMs = 5 * 60_000,
  relayOrigin: origin,
  artifactToken,
  fetchImpl = globalThis.fetch,
  tokenFactory = () => randomBytes(32).toString('base64url'),
}) {
  const source = String(path || '');
  const sourceInfo = await lstat(source);
  if (sourceInfo.isSymbolicLink()) throw new Error('GeWe artifact must be a regular file');
  const resolved = await realpath(source);
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('GeWe artifact must be a regular file');
  if (info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) throw new Error('GeWe artifact size is invalid');
  const safeName = basename(String(fileName || '')).trim().slice(0, 180);
  if (!safeName) throw new Error('GeWe artifact file name is required');
  const token = String(artifactToken || '');
  if (token.length < 24) throw new Error('Artifact relay token is invalid');
  const artifactKey = String(tokenFactory());
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(artifactKey)) throw new Error('Artifact key is invalid');
  const ttl = Math.max(30, Math.min(900, Math.ceil(Number(ttlMs) / 1_000) || 300));
  const url = `${relayOrigin(origin)}/relay/artifacts/${artifactKey}/${encodeURIComponent(safeName)}?ttl=${ttl}`;
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': contentType(safeName),
      'content-length': String(info.size),
    },
    body: createReadStream(resolved),
    duplex: 'half',
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Artifact relay upload failed with HTTP ${response.status}`);
  const payload = await response.json();
  if (!/^\/webhooks\/gewe\/[A-Za-z0-9_-]{24,128}\/artifacts\/[A-Za-z0-9_-]{24,128}\//.test(payload?.publicPath || '')) {
    throw new Error('Artifact relay returned an invalid public path');
  }
  return payload.publicPath;
}

async function readArtifactToken() {
  const service = process.env.AIPRO_RELAY_KEYCHAIN_SERVICE || 'com.local.aipro.wechat-edge-relay';
  const account = process.env.AIPRO_ARTIFACT_KEYCHAIN_ACCOUNT || 'production-artifact';
  const result = await execFileAsync('/usr/bin/security', [
    'find-generic-password', '-w', '-s', service, '-a', account,
  ], { encoding: 'utf8', timeout: 10_000, maxBuffer: 16 * 1024 });
  return String(result.stdout || '').trim();
}

export function patchArtifactRegistration(WebhookServer, options) {
  if (!WebhookServer?.prototype || WebhookServer.prototype[PATCHED]) return false;
  Object.defineProperty(WebhookServer.prototype, PATCHED, { value: true });
  WebhookServer.prototype.registerArtifact = function registerArtifact(input = {}) {
    return uploadRelayArtifact({ ...input, ...options });
  };
  return true;
}

async function bootstrap() {
  const origin = process.env.AIPRO_RELAY_ORIGIN;
  if (!origin) return;
  const artifactToken = await readArtifactToken();
  const currentPath = process.env.AIPRO_CURRENT_PATH || process.env.AIPRO_RESOURCE_ROOT;
  if (!currentPath) throw new Error('AIPRO current release path is required for artifact relay bootstrap');
  const runtime = await import(pathToFileURL(join(currentPath, 'src', 'im-channel-runtime.mjs')).href);
  patchArtifactRegistration(runtime.GeWeWebhookServer, {
    relayOrigin: origin,
    artifactToken,
  });
}

await bootstrap();
