import { config } from '../src/config.mjs';
import { runBufferedProcess } from '../src/process-runner.mjs';

const { stdout } = await runBufferedProcess(config.pythonBin, [
  '-c',
  'import docx, pypdf; print("PYTHON_HELPERS_OK")',
], {
  timeoutMs: 15_000,
  maxStdoutBytes: 64 * 1024,
  maxStderrBytes: 128 * 1024,
});

if (!stdout.includes('PYTHON_HELPERS_OK')) {
  throw new Error('Python helper dependencies are unavailable');
}

console.log('PYTHON_HELPERS_OK');
