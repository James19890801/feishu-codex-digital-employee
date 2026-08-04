import { join } from 'node:path';
import { config } from '../src/config.mjs';
import { runBufferedProcess } from '../src/process-runner.mjs';

const codexHome = join(config.workdir, 'data', 'codex-home');
const runtimeDir = join(config.workdir, 'data', 'codex-runtime');
const env = { ...process.env, CODEX_HOME: codexHome };
if (config.codexProxyUrl) {
  env.HTTP_PROXY = config.codexProxyUrl;
  env.HTTPS_PROXY = config.codexProxyUrl;
  env.ALL_PROXY = config.codexProxyUrl;
}
const startedAt = Date.now();
const { stdout } = await runBufferedProcess(config.codexBin, [
  'exec',
  '--ephemeral',
  '--ignore-user-config',
  '--skip-git-repo-check',
  '--sandbox', 'read-only',
  '--color', 'never',
  '-m', config.codexModel,
  '-C', runtimeDir,
  '-',
], {
  cwd: runtimeDir,
  env,
  input: '只回复：DIGITAL_EMPLOYEE_CODEX_OK',
  timeoutMs: Math.min(config.codexTimeoutMs, 90_000),
  maxStdoutBytes: 64 * 1024,
  maxStderrBytes: 256 * 1024,
});
if (!stdout.includes('DIGITAL_EMPLOYEE_CODEX_OK')) {
  throw new Error('Codex smoke test returned an unexpected response');
}
console.log(JSON.stringify({
  healthy: true,
  model: config.codexModel,
  elapsedMs: Date.now() - startedAt,
}));
