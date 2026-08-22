import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function isDirectExecution(importMetaUrl, argvPath) {
  if (!argvPath) return false;
  const modulePath = fileURLToPath(importMetaUrl);
  try {
    return realpathSync(resolve(argvPath)) === realpathSync(modulePath);
  } catch {
    return resolve(argvPath) === resolve(modulePath);
  }
}
