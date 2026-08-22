import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertRequiredConfigurationFiles } from './check-config.mjs';

const root = await mkdtemp(join(tmpdir(), 'aipro-check-config-'));
assert.throws(() => assertRequiredConfigurationFiles(root), /config\.local\.json/);
for (const file of ['config.local.json', 'PERSONA.md', 'BIBLE.md', 'knowledge-catalog.json']) {
  await writeFile(join(root, file), '{}\n', 'utf8');
}
assert.doesNotThrow(() => assertRequiredConfigurationFiles(root));

console.log('CHECK_CONFIG_TEST_OK');
