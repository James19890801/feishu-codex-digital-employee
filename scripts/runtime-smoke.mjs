import { join } from 'node:path';
import { config } from '../src/config.mjs';
import {
  AiRuntimeClient,
  discoverAiRuntimes,
  selectAiRuntime,
} from '../src/ai-runtime.mjs';

const runtimes = discoverAiRuntimes({ configuredCodexBin: config.codexBin });
const runtime = selectAiRuntime(runtimes, config.aiRuntime);
const runtimeDir = join(config.workdir, 'data', 'codex-runtime');
const env = { ...process.env };
if (runtime.id === 'codex') {
  env.CODEX_HOME = join(config.workdir, 'data', 'codex-home');
}
if (config.codexProxyUrl) {
  env.HTTP_PROXY = config.codexProxyUrl;
  env.HTTPS_PROXY = config.codexProxyUrl;
  env.ALL_PROXY = config.codexProxyUrl;
}
const client = new AiRuntimeClient({ runtime, env });
const startedAt = Date.now();
const { text } = await client.run('只回复：JAMES_AI_RUNTIME_OK', {
  cwd: runtimeDir,
  model: runtime.id === 'codex' ? config.codexModel : '',
  timeoutMs: Math.min(config.codexTimeoutMs, 90_000),
  maxStdoutBytes: 64 * 1024,
  maxStderrBytes: 256 * 1024,
});
if (!text.includes('JAMES_AI_RUNTIME_OK')) {
  throw new Error(`${runtime.label} smoke test returned an unexpected response`);
}
console.log(JSON.stringify({
  healthy: true,
  configured: config.aiRuntime,
  selected: runtime.id,
  label: runtime.label,
  detected: runtimes.filter(item => item.installed).map(item => ({
    id: item.id,
    available: item.available,
  })),
  elapsedMs: Date.now() - startedAt,
}));
