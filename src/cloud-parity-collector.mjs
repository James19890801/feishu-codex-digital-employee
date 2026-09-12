import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildParityManifest, CLOUD_PARITY_STATE_COLUMNS } from './cloud-parity-manifest.mjs';

export async function collectParityManifest({ root }) {
  if (!root) throw new Error('parity root is required');
  const directory = resolve(root);
  const [configText, persona, bible, instructions] = await Promise.all([
    readFile(join(directory, 'config', 'config.local.json'), 'utf8'),
    readFile(join(directory, 'config', 'PERSONA.md'), 'utf8'),
    readFile(join(directory, 'config', 'BIBLE.md'), 'utf8'),
    readFile(join(directory, 'AGENTS.md'), 'utf8'),
  ]);
  const config = JSON.parse(configText);
  const db = new DatabaseSync(join(directory, 'data', 'agent-state.sqlite'), { readOnly: true });
  const state = {};
  try {
    db.exec('BEGIN');
    for (const table of Object.keys(CLOUD_PARITY_STATE_COLUMNS)) {
      try {
        state[table] = db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));
      } catch (error) {
        throw new Error(`parity state table unavailable: ${table}`, { cause: error });
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
  return buildParityManifest({ config, persona, bible, instructions, state });
}
