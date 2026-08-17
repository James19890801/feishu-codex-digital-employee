export function assertInstallationAttestation(status, expected) {
  const actual = status?.installation || {};
  if (!expected?.id || actual.id !== expected.id) {
    throw new Error('Dashboard installation ID does not match this installation');
  }
  if (!expected?.buildSha || actual.buildSha !== expected.buildSha) {
    throw new Error('Dashboard build SHA does not match this installation');
  }
  if (!expected?.root || actual.root !== expected.root) {
    throw new Error('Dashboard installation root does not match this installation');
  }
  if (status?.process?.alive !== true || !Number.isInteger(status?.process?.pid)) {
    throw new Error('Core service is not running for this installation');
  }
  if (status?.database?.integrity !== 'ok') {
    throw new Error('Installed service database integrity check did not pass');
  }
  return true;
}
