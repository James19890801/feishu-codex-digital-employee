import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { generateSigningKeyPair } from '../src/licensing/crypto.mjs';

function randomSecret(bytes = 36) {
  return randomBytes(bytes).toString('base64url');
}

function digest(secret, pepper) {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

async function secureWrite(directory, name, value) {
  await writeFile(path.join(directory, name), value, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}

export async function generateProvisioningMaterial(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('Provisioning output directory must be absolute.');
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const license = generateSigningKeyPair();
  const invitationPepper = randomSecret(48);
  const recoveryPepper = randomSecret(48);
  const createdAt = new Date().toISOString();
  const holders = [
    { holder: 'james-feng', issuerId: 'issuer-james', displayName: 'James Feng', file: 'james-founder-recovery.json' },
  ].map(item => ({
    ...item,
    recoveryKit: { id: `recovery_${randomUUID()}`, secret: randomSecret(36) },
  }));

  await secureWrite(directory, 'license-private-key.txt', `${license.privateKey}\n`);
  await secureWrite(directory, 'license-public-key.txt', `${license.publicKey}\n`);
  await secureWrite(directory, 'invitation-pepper.txt', `${invitationPepper}\n`);
  await secureWrite(directory, 'recovery-pepper.txt', `${recoveryPepper}\n`);
  for (const item of holders) {
    await secureWrite(directory, item.file, `${JSON.stringify({
      version: 1,
      holder: item.holder,
      issuerId: item.issuerId,
      displayName: item.displayName,
      recoveryKit: item.recoveryKit,
    }, null, 2)}\n`);
  }
  const values = holders.map(item => `('${item.recoveryKit.id}', '${item.holder}', '${digest(item.recoveryKit.secret, recoveryPepper)}', 1, 'active', '${createdAt}')`);
  await secureWrite(directory, 'seed-recovery.sql', [
    'INSERT INTO recovery_credentials',
    '  (id, holder, secret_hash, generation, status, created_at)',
    `VALUES\n  ${values.join(',\n  ')};`,
    '',
  ].join('\n'));
  return { publicKey: license.publicKey, holders: holders.map(({ recoveryKit, ...item }) => ({
    ...item,
    recoveryId: recoveryKit.id,
  })) };
}

async function main() {
  const directory = process.argv[2];
  if (!directory) throw new Error('Usage: node scripts/licensing-provision-material.mjs <absolute-output-directory>');
  await generateProvisioningMaterial(directory);
  process.stdout.write(`Provisioning material created in ${directory}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${error?.message || 'Provisioning failed.'}\n`);
    process.exitCode = 1;
  });
}
