import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { generateProvisioningMaterial } from './licensing-provision-material.mjs';

const directory = await mkdtemp(path.join(os.tmpdir(), 'james-provision-'));
const result = await generateProvisioningMaterial(directory);
assert.match(result.publicKey, /^[A-Za-z0-9_-]{40,256}$/);
for (const file of [
  'license-private-key.txt',
  'license-public-key.txt',
  'invitation-pepper.txt',
  'recovery-pepper.txt',
  'james-founder-recovery.json',
  'seed-recovery.sql',
]) {
  assert.equal((await stat(path.join(directory, file))).mode & 0o777, 0o600);
}
const james = JSON.parse(await readFile(path.join(directory, 'james-founder-recovery.json'), 'utf8'));
assert.equal(james.holder, 'james-feng');
assert.equal(james.issuerId, 'issuer-james');
assert.match(james.recoveryKit.secret, /^[A-Za-z0-9_-]{40,}$/);
assert.deepEqual(result.holders.map(holder => holder.holder), ['james-feng']);
assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('-founder-recovery.json')), ['james-founder-recovery.json']);
const sql = await readFile(path.join(directory, 'seed-recovery.sql'), 'utf8');
assert.equal(sql.includes(james.recoveryKit.secret), false);
assert.equal(sql.includes('f19881210'), false);
assert.match(sql, /INSERT INTO recovery_credentials/);

console.log('LICENSING_PROVISION_MATERIAL_TEST_OK');
