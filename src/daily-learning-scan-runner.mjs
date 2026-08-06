import { fileURLToPath } from 'node:url';
import { runBufferedProcess } from './process-runner.mjs';

const WORKER_PATH = fileURLToPath(new URL('./daily-learning-scan-worker.mjs', import.meta.url));

export async function runLearningFileScan({
  roots = [], sinceMs = Date.now() - 24 * 60 * 60_000,
  runner = runBufferedProcess,
} = {}) {
  const payload = JSON.stringify({ roots, sinceMs });
  let stdout;
  try {
    ({ stdout } = await runner(process.execPath, [WORKER_PATH], {
      input: payload,
      timeoutMs: 30_000,
      killGraceMs: 2_000,
      maxStdoutBytes: 512 * 1024,
      maxStderrBytes: 128 * 1024,
    }));
  } catch (error) {
    const diagnostic = String(error?.stderr || '').trim().split('\n').at(-1) || '';
    const safeDiagnostic = diagnostic
      .replace(/\/Users\/[^/]+/g, '~')
      .replace(/[\r\n\0]/g, ' ')
      .slice(0, 500);
    throw new Error(`${error?.message || error}${safeDiagnostic ? ` (${safeDiagnostic})` : ''}`);
  }
  let result;
  try { result = JSON.parse(stdout); } catch {
    throw new Error('Daily learning file scanner returned invalid JSON');
  }
  if (!Array.isArray(result)) throw new Error('Daily learning file scanner returned invalid JSON');
  return result.slice(0, 160).map(item => ({
    path: String(item?.path || '').slice(0, 500),
    modifiedAt: String(item?.modifiedAt || '').slice(0, 40),
    excerpt: String(item?.excerpt || '').slice(0, 1_000),
  })).filter(item => item.path && item.excerpt);
}
