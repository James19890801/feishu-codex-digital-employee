import { copyFile, stat, truncate } from 'node:fs/promises';

export async function rotateLogIfNeeded(path, maxBytes = 10 * 1024 * 1024) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  if (info.size <= maxBytes) return false;
  await copyFile(path, `${path}.1`);
  await truncate(path, 0);
  return true;
}
