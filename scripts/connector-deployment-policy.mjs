import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function normalizedPath(value) {
  return String(value || '').trim().replaceAll('\\', '/').toLowerCase();
}

export function isForbiddenDwsPath(path) {
  const normalized = normalizedPath(path);
  return normalized.includes('wukong')
    || normalized.includes('legacybridge')
    || /\/(?:\.real)\/\.bin\/(?:dws|connector)(?:\/|$)/u.test(normalized);
}

export const isForbiddenConnectorPath = isForbiddenDwsPath;

export function bundledDwsPath(installRoot, platform = process.platform) {
  return join(
    String(installRoot || ''),
    'node_modules',
    'dingtalk-workspace-cli',
    'vendor',
    platform === 'win32' ? 'dws.exe' : 'dws',
  );
}

async function executablePath(candidate) {
  const absolute = resolve(String(candidate || '').trim());
  if (isForbiddenDwsPath(absolute)) {
    throw new Error('Wukong is not allowed; LegacyBridge is not allowed; use the standalone DWS CLI');
  }
  try {
    const canonical = await realpath(absolute);
    if (isForbiddenDwsPath(canonical)) {
      throw new Error('Wukong is not allowed; LegacyBridge is not allowed; use the standalone DWS CLI');
    }
    const info = await stat(canonical);
    if (!info.isFile() || (info.mode & 0o111) === 0) return '';
    return canonical;
  } catch (error) {
    if (/Wukong is not allowed/iu.test(String(error?.message || ''))) throw error;
    return '';
  }
}

export async function resolveStandaloneDws({
  explicitPath = '',
  home = '',
  installRoot = '',
  platform = process.platform,
  candidates = [],
} = {}) {
  const explicit = String(explicitPath || '').trim();
  const paths = explicit
    ? [explicit]
    : (Array.isArray(candidates) && candidates.length
      ? candidates
      : [
          ...(installRoot ? [bundledDwsPath(installRoot, platform)] : []),
          join(String(home || ''), '.npm-global', 'bin', platform === 'win32' ? 'dws.cmd' : 'dws'),
          join(String(home || ''), '.local', 'bin', platform === 'win32' ? 'dws.exe' : 'dws'),
        ]);
  for (const candidate of paths) {
    const found = await executablePath(candidate);
    if (found) return found;
  }
  throw new Error(
    'A standalone DWS CLI is required. Install dingtalk-workspace-cli or set JAMES_DWS_BIN.',
  );
}

export async function resolveStandaloneConnector(options = {}) {
  return resolveStandaloneDws(options);
}
