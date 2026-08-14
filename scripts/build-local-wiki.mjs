import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildLocalWiki, inventoryKnowledgeSources } from '../src/local-wiki-index.mjs';
import { runBufferedProcess } from '../src/process-runner.mjs';

const dryRun = process.argv.includes('--dry-run');
const home = homedir();
const roots = [home];
const documentRoots = [join(home, 'Downloads')];
const outputDir = join(home, 'Library', 'Application Support', 'AIPRO', 'local-wiki');
const python = join(
  home, '.cache', 'codex-runtimes', 'codex-primary-runtime',
  'dependencies', 'python', 'bin', 'python3',
);
const extractor = join(process.cwd(), 'src', 'extract_file_text.py');

async function extractDocumentText(path) {
  const { stdout } = await runBufferedProcess(python, [extractor, path], {
    timeoutMs: 15 * 60_000,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 512 * 1024,
    env: {
      ...process.env,
      AIPRO_EXTRACT_MAX_CHARS: '600000',
      AIPRO_EXTRACT_MAX_PDF_PAGES: '1000',
      AIPRO_PDF_OCR_DISTRIBUTED: '1',
      AIPRO_PDF_OCR_SAMPLE_PAGES: '40',
      AIPRO_PDF_OCR_FRONTLOAD_PAGES: '12',
    },
  });
  return JSON.parse(stdout);
}

if (dryRun) {
  const inventory = await inventoryKnowledgeSources({
    htmlRoots: roots,
    documentRoots,
    outputDir,
  });
  console.log(JSON.stringify({
    mode: 'dry-run',
    candidateCount: inventory.files.length,
    htmlCount: inventory.files.filter(item => item.kind === 'html').length,
    documentCount: inventory.files.filter(item => item.kind === 'document').length,
    excludedCount: inventory.excludedCount,
  }, null, 2));
} else {
  const result = await buildLocalWiki({
    roots,
    documentRoots,
    outputDir,
    extractDocumentText,
  });
  console.log(JSON.stringify({ mode: 'build', ...result }, null, 2));
}
