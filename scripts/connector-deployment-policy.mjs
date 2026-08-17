import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function normalizedPath(value) {
  return String(value || '').trim().replaceAll('\\', '/').toLowerCase();
}

export function isForbiddenConnectorPath(path) {
  const normalized = normalizedPath(path);
  return normalized.includes('legacyBridge')
    || /\/(?:\.real)\/\.bin\/connector(?:\/|$)/u.test(normalized);
}

async function executablePath(candidate) {
  const absolute = resolve(String(candidate || '').trim());
  if (isForbiddenConnectorPath(absolute)) {
    throw new Error('LegacyBridge is not allowed; configure a standalone CONNECTOR CLI');
  }
  try {
    const canonical = await realpath(absolute);
    if (isForbiddenConnectorPath(canonical)) {
      throw new Error('LegacyBridge is not allowed; configure a standalone CONNECTOR CLI');
    }
    const info = await stat(canonical);
    if (!info.isFile() || (info.mode & 0o111) === 0) return '';
    return canonical;
  } catch (error) {
    if (String(error?.message || '').includes('LegacyBridge is not allowed')) throw error;
    return '';
  }
}

export async function resolveStandaloneConnector({
  explicitPath = '',
  home = '',
  candidates = [],
} = {}) {
  const explicit = String(explicitPath || '').trim();
  const paths = explicit
    ? [explicit]
    : (Array.isArray(candidates) && candidates.length
      ? candidates
      : [
          join(String(home || ''), '.npm-global', 'bin', 'connector'),
          join(String(home || ''), '.local', 'bin', 'connector-official'),
          join(String(home || ''), '.local', 'bin', 'connector'),
        ]);
  for (const candidate of paths) {
    const found = await executablePath(candidate);
    if (found) return found;
  }
  throw new Error(
    'A standalone CONNECTOR CLI is required. Install CONNECTOR outside LegacyBridge or set JAMES_CONNECTOR_BIN.',
  );
}
