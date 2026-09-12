import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { collectParityManifest } from './cloud-parity-collector.mjs';

test('collects configured documents and selected SQLite state without secrets', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aipro-parity-collect-'));
  try {
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'config', 'config.local.json'), JSON.stringify({
      allowAllChats: false, authorizedChatIds: ['one'], dingtalkProfile: 'secret-profile',
    }));
    writeFileSync(join(root, 'config', 'PERSONA.md'), 'Persona test');
    writeFileSync(join(root, 'config', 'BIBLE.md'), 'Bible test');
    writeFileSync(join(root, 'AGENTS.md'), 'Instructions test');
    const db = new DatabaseSync(join(root, 'data', 'agent-state.sqlite'));
    db.exec(`CREATE TABLE relationship_person (person_id TEXT);
      CREATE TABLE relationship_profile (person_id TEXT, summary TEXT, secret_token TEXT);
      CREATE TABLE relationship_fact (fact_id TEXT);
      CREATE TABLE relationship_episode (event_id TEXT);
      CREATE TABLE owner_consultation (id TEXT, status TEXT);`);
    db.prepare('INSERT INTO relationship_profile VALUES (?, ?, ?)').run('person-1', 'knows me', 'do-not-export');
    db.close();
    const manifest = await collectParityManifest({ root });
    assert.equal(manifest.sections.persona.data, 'Persona test');
    assert.equal(manifest.sections.instructions.data, 'Instructions test');
    assert.equal(manifest.sections.state.data.relationship_profile[0].summary, 'knows me');
    assert.equal(JSON.stringify(manifest).includes('secret-profile'), false);
    assert.equal(JSON.stringify(manifest).includes('do-not-export'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing required state table fails rather than reporting a complete sync', async () => {
  const root = mkdtempSync(join(tmpdir(), 'aipro-parity-missing-'));
  try {
    mkdirSync(join(root, 'config'));
    mkdirSync(join(root, 'data'));
    writeFileSync(join(root, 'config', 'config.local.json'), '{}');
    writeFileSync(join(root, 'config', 'PERSONA.md'), 'Persona');
    writeFileSync(join(root, 'config', 'BIBLE.md'), 'Bible');
    writeFileSync(join(root, 'AGENTS.md'), 'Instructions');
    const db = new DatabaseSync(join(root, 'data', 'agent-state.sqlite'));
    db.close();
    await assert.rejects(collectParityManifest({ root }), /relationship_person/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
