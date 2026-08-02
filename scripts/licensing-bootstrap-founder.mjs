import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { LicensingClient } from '../src/licensing/client.mjs';
import { evaluateEntitlement, verifyEnvelope } from '../src/licensing/crypto.mjs';
import {
  bootstrapFounder,
  LicensingStore,
  writeRecoveryKitFile,
} from '../src/licensing/store.mjs';

async function readRecoveryKit(filePath) {
  const parsed = JSON.parse(await readFile(filePath, 'utf8'));
  if (!parsed?.recoveryKit?.id
    || !parsed?.recoveryKit?.secret
    || !parsed?.holder
    || !parsed?.issuerId
    || !parsed?.displayName) {
    throw new Error('Recovery kit file is invalid.');
  }
  return parsed;
}

export async function provisionFounderFromRecoveryFile({
  inputPath,
  outputPath,
  store = new LicensingStore(),
  bootstrapFounderImpl = bootstrapFounder,
  recover,
  verifyEntitlement,
}) {
  if (!inputPath || !outputPath || typeof recover !== 'function' || typeof verifyEntitlement !== 'function') {
    throw new Error('Founder provisioning request is incomplete.');
  }
  const input = await readRecoveryKit(inputPath);
  const provisioned = await bootstrapFounderImpl({
    store,
    holder: input.holder,
    issuerId: input.issuerId,
    displayName: input.displayName,
    recoveryKit: input.recoveryKit,
    recover,
    verifyEntitlement,
  });
  await writeRecoveryKitFile(outputPath, {
    version: 1,
    holder: input.holder,
    issuerId: input.issuerId,
    displayName: input.displayName,
    recoveryKit: provisioned.recoveryKit,
  });
  return provisioned;
}

export async function runFounderCli(argv = process.argv.slice(2), env = process.env) {
  const [inputPath, outputPath] = argv;
  const serviceUrl = env.AIPRO_LICENSING_SERVICE_URL;
  const publicKey = env.AIPRO_LICENSE_PUBLIC_KEY;
  if (!inputPath || !outputPath || !serviceUrl || !publicKey) {
    throw new Error('Usage: set licensing environment, then pass input and rotated recovery-kit files.');
  }
  const client = new LicensingClient({
    serviceUrl,
    proxyUrl: env.AIPRO_LICENSING_PROXY_URL || '',
  });
  const provisioned = await provisionFounderFromRecoveryFile({
    inputPath,
    outputPath,
    recover: body => client.recoverFounder(body),
    verifyEntitlement: async (token, device) => {
      const entitlement = verifyEnvelope(token, publicKey);
      const evaluation = evaluateEntitlement(entitlement, {
        product: 'AIPRO',
        deviceKeyHash: device.keyHash,
      });
      return { ...evaluation, edition: entitlement.edition };
    },
  });
  process.stdout.write(`Founder authority enrolled for ${provisioned.issuer.id}. Rotated recovery kit saved.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFounderCli().catch(error => {
    process.stderr.write(`${error?.message || 'Founder bootstrap failed.'}\n`);
    process.exitCode = 1;
  });
}
