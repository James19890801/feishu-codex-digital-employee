import { realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

function normalizedPath(value) {
  return String(value || '').trim().replaceAll('\\', '/').toLowerCase();
}

export function isForbiddenDwsPath(path) {
  const normalized = normalizedPath(path);
  return normalized.includes('wukong')
    || /\/(?:\.real)\/\.bin\/dws(?:\/|$)/u.test(normalized);
}

async function executablePath(candidate) {
  const absolute = resolve(String(candidate || '').trim());
  if (isForbiddenDwsPath(absolute)) {
    throw new Error('Wukong is not allowed; configure a standalone DWS CLI');
  }
  try {
    const canonical = await realpath(absolute);
    if (isForbiddenDwsPath(canonical)) {
      throw new Error('Wukong is not allowed; configure a standalone DWS CLI');
    }
    const info = await stat(canonical);
    if (!info.isFile() || (info.mode & 0o111) === 0) return '';
    return canonical;
  } catch (error) {
    if (String(error?.message || '').includes('Wukong is not allowed')) throw error;
    return '';
  }
}

export async function resolveStandaloneDws({
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
          join(String(home || ''), '.npm-global', 'bin', 'dws'),
          join(String(home || ''), '.local', 'bin', 'dws-official'),
          join(String(home || ''), '.local', 'bin', 'dws'),
        ]);
  for (const candidate of paths) {
    const found = await executablePath(candidate);
    if (found) return found;
  }
  throw new Error(
    'A standalone DWS CLI is required. Install DWS outside Wukong or set JAMES_DWS_BIN.',
  );
}
