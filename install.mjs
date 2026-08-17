import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const installer = join(packageRoot, 'payload', 'scripts', 'install-aicoding.mjs');
const result = spawnSync(process.execPath, [installer, packageRoot], {
  cwd: packageRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
