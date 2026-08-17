import { config } from '../src/config.mjs';
import { runBufferedProcess } from '../src/process-runner.mjs';

if (!config.pythonBin) {
  console.log('PYTHON_HELPERS_SKIPPED optional_runtime_not_configured');
  process.exit(0);
}

const { stdout } = await runBufferedProcess(config.pythonBin, [
  '-c',
  'import docx, openpyxl, pptx, pypdf, xlrd; print("PYTHON_HELPERS_OK")',
], {
  timeoutMs: 15_000,
  maxStdoutBytes: 64 * 1024,
  maxStderrBytes: 128 * 1024,
});

if (!stdout.includes('PYTHON_HELPERS_OK')) {
  throw new Error('Python helper dependencies are unavailable');
}

console.log('PYTHON_HELPERS_OK');
