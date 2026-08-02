import { readFile } from 'node:fs/promises';

import { evaluateEntitlement, verifyEnvelope } from '../src/licensing/crypto.mjs';
import { bootstrapFounder, LicensingStore } from '../src/licensing/store.mjs';

async function readRecoveryKit(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  if (!parsed?.recoveryKit?.id || !parsed?.recoveryKit?.secret) {
    throw new Error('Recovery kit file is invalid.');
  }
  return parsed;
}

async function main() {
  const [filePath] = process.argv.slice(2);
  const serviceUrl = process.env.AIPRO_LICENSING_SERVICE_URL;
  const publicKey = process.env.AIPRO_LICENSE_PUBLIC_KEY;
  if (!filePath || !serviceUrl || !publicKey) {
    throw new Error('Usage: set licensing environment, then pass a recovery-kit file.');
  }
  const input = await readRecoveryKit(filePath);
  const store = new LicensingStore();
  const provisioned = await bootstrapFounder({
    store,
    holder: input.holder,
    issuerId: input.issuerId,
    displayName: input.displayName,
    recoveryKit: input.recoveryKit,
    recover: async body => {
      const response = await fetch(new URL('/v1/founder/recover', serviceUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error('Founder recovery service rejected the request.');
      return response.json();
    },
    verifyEntitlement: async (token, device) => {
      const entitlement = verifyEnvelope(token, publicKey);
      const evaluation = evaluateEntitlement(entitlement, {
        product: 'AIPRO',
        deviceKeyHash: device.keyHash,
      });
      return { ...evaluation, edition: entitlement.edition };
    },
  });
  process.stdout.write(`Founder authority enrolled for ${provisioned.issuer.id}.\n`);
}

main().catch(error => {
  process.stderr.write(`${error?.message || 'Founder bootstrap failed.'}\n`);
  process.exitCode = 1;
});
