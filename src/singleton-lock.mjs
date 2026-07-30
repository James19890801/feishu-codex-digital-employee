import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function alreadyRunning(pid) {
  const error = new Error(`digital employee service is already running (pid ${pid})`);
  error.code = 'SERVICE_ALREADY_RUNNING';
  return error;
}

export async function acquireSingletonLock(path) {
  await mkdir(dirname(path), { recursive: true });
  const token = randomUUID();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = await open(path, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({
          pid: process.pid,
          token,
          startedAt: new Date().toISOString(),
        }));
      } finally {
        await handle.close();
      }

      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(await readFile(path, 'utf8'));
            if (current.token === token) await unlink(path);
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }

    let current;
    try {
      current = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw alreadyRunning('initializing');
    }
    if (isProcessAlive(Number(current.pid))) throw alreadyRunning(current.pid);

    const stalePath = `${path}.stale-${token}`;
    try {
      await rename(path, stalePath);
      await unlink(stalePath).catch(() => {});
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  throw alreadyRunning('unknown');
}
