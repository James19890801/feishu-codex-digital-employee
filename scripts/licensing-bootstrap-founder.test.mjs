import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { provisionFounderFromRecoveryFile } from './licensing-bootstrap-founder.mjs';

const directory = await mkdtemp(join(tmpdir(), 'aipro-founder-bootstrap-'));
const inputPath = join(directory, 'initial.json');
const outputPath = join(directory, 'rotated.json');
await writeFile(inputPath, JSON.stringify({
  version: 1,
  holder: 'james-feng',
  issuerId: 'james-feng',
  displayName: 'James Feng',
  recoveryKit: { id: 'initial-id', secret: 'initial-secret' },
}));

let received;
await provisionFounderFromRecoveryFile({
  inputPath,
  outputPath,
  store: {},
  bootstrapFounderImpl: async request => {
    received = request;
    return {
      issuer: { id: 'james-feng' },
      recoveryKit: { id: 'rotated-id', secret: 'rotated-secret' },
    };
  },
  recover: async () => {},
  verifyEntitlement: async () => {},
});

assert.equal(received.holder, 'james-feng');
assert.deepEqual(received.recoveryKit, { id: 'initial-id', secret: 'initial-secret' });
const exported = JSON.parse(await readFile(outputPath, 'utf8'));
assert.deepEqual(exported.recoveryKit, { id: 'rotated-id', secret: 'rotated-secret' });
assert.equal(exported.holder, 'james-feng');
assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
assert.equal(JSON.stringify(exported).includes('initial-secret'), false);

console.log('LICENSING_BOOTSTRAP_FOUNDER_TEST_OK');
