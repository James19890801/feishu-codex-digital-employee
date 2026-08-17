import assert from 'node:assert/strict';
import { assertInstallationAttestation } from './installation-attestation.mjs';

const expected = {
  id: 'install-12345678',
  buildSha: 'a'.repeat(64),
  root: '/Users/learner/Library/Application Support/JamesDigitalHuman',
};
assert.equal(assertInstallationAttestation({
  installation: expected,
  process: { alive: true, pid: 1234 },
  database: { integrity: 'ok' },
}, expected), true);
assert.throws(() => assertInstallationAttestation({
  installation: { ...expected, id: 'stale-install' },
  process: { alive: true, pid: 999 },
  database: { integrity: 'ok' },
}, expected), /installation id/i);
assert.throws(() => assertInstallationAttestation({
  installation: expected,
  process: { alive: false, pid: null },
  database: { integrity: 'ok' },
}, expected), /core service/i);

console.log('INSTALLATION_ATTESTATION_TEST_OK');
