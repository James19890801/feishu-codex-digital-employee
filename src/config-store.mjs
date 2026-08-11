import {
  appendFile,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

const FILES = {
  config: 'config.local.json',
  persona: 'PERSONA.md',
  bible: 'BIBLE.md',
  knowledgeCatalog: 'knowledge-catalog.json',
};

function snapshotsDirectory(root) {
  return join(root, 'data', 'config-backups');
}

function assertSnapshotId(id) {
  if (!/^snapshot-[A-Za-z0-9_-]{4,80}$/.test(String(id || ''))) {
    throw new Error('Invalid snapshot ID');
  }
  return String(id);
}

function serializeDocuments(documents) {
  if (!documents?.config || typeof documents.config !== 'object' || Array.isArray(documents.config)) {
    throw new Error('Configuration document must be an object');
  }
  if (typeof documents.persona !== 'string' || typeof documents.bible !== 'string') {
    throw new Error('Persona and Bible documents must be strings');
  }
  if (!Array.isArray(documents.knowledgeCatalog)) {
    throw new Error('Knowledge catalog must be an array');
  }
  return {
    config: `${JSON.stringify(documents.config, null, 2)}\n`,
    persona: documents.persona.endsWith('\n') ? documents.persona : `${documents.persona}\n`,
    bible: documents.bible.endsWith('\n') ? documents.bible : `${documents.bible}\n`,
    knowledgeCatalog: `${JSON.stringify(documents.knowledgeCatalog, null, 2)}\n`,
  };
}

async function atomicWrite(path, content) {
  const temporary = `${path}.aipro-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function readConfigurationDocuments(root) {
  const [configText, persona, bible, catalogText] = await Promise.all([
    readFile(join(root, FILES.config), 'utf8'),
    readFile(join(root, FILES.persona), 'utf8'),
    readFile(join(root, FILES.bible), 'utf8'),
    readFile(join(root, FILES.knowledgeCatalog), 'utf8'),
  ]);
  let config;
  let knowledgeCatalog;
  try {
    config = JSON.parse(configText);
  } catch (error) {
    throw new Error(`Invalid config.local.json: ${error.message}`);
  }
  try {
    knowledgeCatalog = JSON.parse(catalogText);
  } catch (error) {
    throw new Error(`Invalid knowledge-catalog.json: ${error.message}`);
  }
  return { config, persona, bible, knowledgeCatalog };
}

export async function writeConfigurationDocuments(root, documents) {
  const serialized = serializeDocuments(documents);
  await atomicWrite(join(root, FILES.persona), serialized.persona);
  await atomicWrite(join(root, FILES.bible), serialized.bible);
  await atomicWrite(join(root, FILES.knowledgeCatalog), serialized.knowledgeCatalog);
  await atomicWrite(join(root, FILES.config), serialized.config);
}

export async function createConfigurationSnapshot(root, {
  id = `snapshot-${Date.now()}-${randomUUID().slice(0, 8)}`,
  createdAt = new Date().toISOString(),
  summary = 'Configuration snapshot',
  planId = '',
} = {}) {
  const snapshotId = assertSnapshotId(id);
  const documents = await readConfigurationDocuments(root);
  const serialized = serializeDocuments(documents);
  const parentDirectory = snapshotsDirectory(root);
  const directory = join(parentDirectory, snapshotId);
  await mkdir(parentDirectory, { recursive: true, mode: 0o700 });
  await mkdir(directory, { recursive: false });
  const metadata = {
    id: snapshotId,
    createdAt,
    summary: String(summary).slice(0, 300),
    planId: String(planId).slice(0, 120),
  };
  await Promise.all([
    writeFile(join(directory, FILES.config), serialized.config, { mode: 0o600 }),
    writeFile(join(directory, FILES.persona), serialized.persona, { mode: 0o600 }),
    writeFile(join(directory, FILES.bible), serialized.bible, { mode: 0o600 }),
    writeFile(join(directory, FILES.knowledgeCatalog), serialized.knowledgeCatalog, { mode: 0o600 }),
    writeFile(join(directory, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 }),
  ]);
  return metadata;
}

export async function listConfigurationSnapshots(root, limit = 20) {
  const directory = snapshotsDirectory(root);
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const snapshots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^snapshot-[A-Za-z0-9_-]{4,80}$/.test(entry.name)) continue;
    try {
      const metadata = JSON.parse(await readFile(join(directory, entry.name, 'metadata.json'), 'utf8'));
      snapshots.push({
        id: entry.name,
        createdAt: String(metadata.createdAt || ''),
        summary: String(metadata.summary || 'Configuration snapshot'),
        planId: String(metadata.planId || ''),
      });
    } catch {
      // Ignore incomplete backup directories; they are never offered for rollback.
    }
  }
  return snapshots
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

export async function restoreConfigurationSnapshot(root, id) {
  const snapshotId = assertSnapshotId(id);
  const directory = join(snapshotsDirectory(root), snapshotId);
  const [configText, persona, bible, catalogText] = await Promise.all([
    readFile(join(directory, FILES.config), 'utf8'),
    readFile(join(directory, FILES.persona), 'utf8'),
    readFile(join(directory, FILES.bible), 'utf8'),
    readFile(join(directory, FILES.knowledgeCatalog), 'utf8'),
  ]);
  const documents = {
    config: JSON.parse(configText),
    persona,
    bible,
    knowledgeCatalog: JSON.parse(catalogText),
  };
  await writeConfigurationDocuments(root, documents);
  return documents;
}

export async function appendConfigurationAudit(root, event) {
  await mkdir(join(root, 'data'), { recursive: true });
  const record = {
    at: new Date().toISOString(),
    ...event,
  };
  await appendFile(
    join(root, 'data', 'configuration-audit.jsonl'),
    `${JSON.stringify(record)}\n`,
    { mode: 0o600 },
  );
  return record;
}
