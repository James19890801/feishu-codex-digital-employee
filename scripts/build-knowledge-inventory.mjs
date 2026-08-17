import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isExcludedIdentityText } from '../src/identity-policy.mjs';

const ALLOWED_DOMAINS = new Set([
  'webagent', 'ai-collaboration', 'digital-employee', 'ai-product-management',
]);
const ALLOWED_TYPES = new Set([
  'enterpriseChat_doc', 'enterpriseChat_minutes', 'local_document', 'local_repository',
  'multica_issue', 'code_repository',
]);
const CREDENTIAL_PATTERN = /(?:sk-[A-Za-z0-9_-]{20,}|(?:(?:access|refresh|api)[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._-]{12,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|app[_ -]?secret\s*[:=]\s*["']?[^\s"']{8,})/i;

function safeText(value, name, maxLength = 4000) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  if (text.length > maxLength) throw new Error(`${name} is too long`);
  if (isExcludedIdentityText(text) || CREDENTIAL_PATTERN.test(text)) {
    throw new Error(`${name} contains excluded or credential-like content`);
  }
  return text;
}

function normalizeSource(source) {
  if (!source || source.approved !== true) return null;
  if (!ALLOWED_DOMAINS.has(String(source.domain || ''))) return null;
  if (!ALLOWED_TYPES.has(String(source.type || ''))) return null;
  try {
    return {
      sourceId: safeText(source.sourceId, 'sourceId', 300),
      type: String(source.type),
      title: safeText(source.title, 'title', 500),
      locator: safeText(source.locator, 'locator', 2000),
      ownerId: String(source.ownerId || ''),
      readerIds: Array.isArray(source.readerIds) ? source.readerIds.map(String).slice(0, 100) : [],
      aliases: Array.isArray(source.aliases)
        ? source.aliases.map(value => safeText(value, 'alias', 300)).slice(0, 30)
        : [],
      sensitivity: ['public', 'internal', 'confidential'].includes(source.sensitivity)
        ? source.sensitivity : 'internal',
      status: 'active',
      freshnessAt: String(source.freshnessAt || ''),
      summary: safeText(source.summary, 'summary', 4000),
    };
  } catch {
    return null;
  }
}

export function buildKnowledgeInventory(manifests = []) {
  const sources = [];
  const ids = new Set();
  const locators = new Set();
  for (const candidate of Array.isArray(manifests) ? manifests : []) {
    const source = normalizeSource(candidate);
    if (!source || ids.has(source.sourceId) || locators.has(source.locator)) continue;
    ids.add(source.sourceId);
    locators.add(source.locator);
    sources.push(source);
  }
  sources.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return { version: 2, sources };
}

async function main(args) {
  const inputFlag = args.indexOf('--input');
  const outputFlag = args.indexOf('--output');
  if (inputFlag < 0 || outputFlag < 0 || !args[inputFlag + 1] || !args[outputFlag + 1]) {
    throw new Error('Usage: node scripts/build-knowledge-inventory.mjs --input manifest.json --output knowledge-catalog.json');
  }
  const inputPath = resolve(args[inputFlag + 1]);
  const outputPath = resolve(args[outputFlag + 1]);
  const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
  const manifest = Array.isArray(parsed) ? parsed : parsed.sources;
  const catalog = buildKnowledgeInventory(manifest);
  if (!catalog.sources.length) throw new Error('Approved knowledge inventory is empty');
  await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: outputPath, sources: catalog.sources.length })}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
