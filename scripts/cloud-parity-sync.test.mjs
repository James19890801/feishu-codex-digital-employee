import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

test('dry run reports only digest and size without sending or printing private policy', () => {
  const root = mkdtempSync(join(tmpdir(), 'aipro-parity-cli-'));
  try {
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'config', 'config.local.json'), '{"allowAllChats":false}');
    writeFileSync(join(root, 'config', 'PERSONA.md'), 'PRIVATE PERSONA');
    writeFileSync(join(root, 'config', 'BIBLE.md'), 'PRIVATE BIBLE');
    writeFileSync(join(root, 'AGENTS.md'), 'PRIVATE INSTRUCTIONS');
    const db = new DatabaseSync(join(root, 'data', 'agent-state.sqlite'));
    for (const table of ['relationship_person', 'relationship_profile', 'relationship_fact',
      'relationship_episode', 'owner_consultation', 'rate_limit',
      'semantic_repeat_guard', 'discussion_session', 'outbound_reply_guard',
      'outbound_echo']) db.exec(`CREATE TABLE ${table} (id TEXT)`);
    db.exec('CREATE TABLE settings (scope TEXT, key TEXT, value TEXT, updated_at TEXT)');
    db.close();
    const run = spawnSync(process.execPath, ['scripts/cloud-parity-sync.mjs', '--dry-run', '--root', root],
      { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.match(output.digest, /^[a-f0-9]{64}$/);
    assert.ok(output.totalBytes > 0);
    assert.equal(run.stdout.includes('PRIVATE PERSONA'), false);
    assert.equal(run.stdout.includes('PRIVATE BIBLE'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
