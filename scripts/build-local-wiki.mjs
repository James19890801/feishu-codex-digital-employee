import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildLocalWiki, inventoryKnowledgeHtml } from '../src/local-wiki-index.mjs';

const dryRun = process.argv.includes('--dry-run');
const roots = [homedir()];
const outputDir = join(homedir(), 'Library', 'Application Support', 'AIPRO', 'local-wiki');

if (dryRun) {
  const inventory = await inventoryKnowledgeHtml({ roots, outputDir });
  console.log(JSON.stringify({ mode: 'dry-run', candidateCount: inventory.files.length, excludedCount: inventory.excludedCount }, null, 2));
} else {
  const result = await buildLocalWiki({ roots, outputDir });
  console.log(JSON.stringify({ mode: 'build', ...result }, null, 2));
}
