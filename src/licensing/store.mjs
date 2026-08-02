import { writeFile } from 'node:fs/promises';

import {
  canonicalJson,
  generateSigningKeyPair,
  publicKeyFingerprint,
  signEnvelope,
  verifyEnvelope,
} from './crypto.mjs';
import { KeychainSecretStore } from './keychain.mjs';

export const LICENSING_ACCOUNTS = Object.freeze({
  devicePrivateKey: 'device-private-key',
  devicePublicKey: 'device-public-key',
  entitlement: 'entitlement',
  issuerPrivateKey: 'issuer-private-key',
  issuerMetadata: 'issuer-metadata',
  recoveryState: 'recovery-state',
  founderMarker: 'founder-marker',
  clockState: 'clock-state',
});

class LicensingStoreError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LicensingStoreError';
    this.code = code;
  }
}

function parseRecord(value, code) {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('record');
    return parsed;
  } catch {
    throw new LicensingStoreError('Licensing identity is corrupt.', code);
  }
}

function validatePair(privateKey, publicKey, code) {
  try {
    const probe = { purpose: 'aipro-key-validation', version: 1 };
    const token = signEnvelope(probe, privateKey);
    const verified = verifyEnvelope(token, publicKey);
    if (canonicalJson(verified) !== canonicalJson(probe)) throw new Error('mismatch');
    return publicKeyFingerprint(publicKey);
  } catch {
    throw new LicensingStoreError('Licensing identity is corrupt.', code);
  }
}

export class LicensingStore {
  constructor({ secrets = new KeychainSecretStore() } = {}) {
    this.secrets = secrets;
  }

  async ensureDeviceIdentity() {
    const [privateKey, publicKey] = await Promise.all([
      this.secrets.get(LICENSING_ACCOUNTS.devicePrivateKey),
      this.secrets.get(LICENSING_ACCOUNTS.devicePublicKey),
    ]);
    if ((privateKey && !publicKey) || (!privateKey && publicKey)) {
      throw new LicensingStoreError('Licensing device identity is incomplete.', 'corrupt_device_identity');
    }
    if (privateKey && publicKey) {
      return {
        privateKey,
        publicKey,
        keyHash: validatePair(privateKey, publicKey, 'corrupt_device_identity'),
      };
    }
    const pair = generateSigningKeyPair();
    await this.secrets.put(LICENSING_ACCOUNTS.devicePrivateKey, pair.privateKey);
    try {
      await this.secrets.put(LICENSING_ACCOUNTS.devicePublicKey, pair.publicKey);
    } catch (error) {
      await this.secrets.remove(LICENSING_ACCOUNTS.devicePrivateKey).catch(() => {});
      throw error;
    }
    return { ...pair, keyHash: publicKeyFingerprint(pair.publicKey) };
  }

  async ensureIssuerIdentity({ issuerId, displayName }) {
    if (!/^[a-z0-9][a-z0-9-]{2,79}$/.test(issuerId || '')
      || typeof displayName !== 'string'
      || displayName.length < 2
      || displayName.length > 80) {
      throw new LicensingStoreError('Issuer identity request is invalid.', 'invalid_issuer_identity');
    }
    const [privateKey, metadataValue] = await Promise.all([
      this.secrets.get(LICENSING_ACCOUNTS.issuerPrivateKey),
      this.secrets.get(LICENSING_ACCOUNTS.issuerMetadata),
    ]);
    if ((privateKey && !metadataValue) || (!privateKey && metadataValue)) {
      throw new LicensingStoreError('Licensing issuer identity is incomplete.', 'corrupt_issuer_identity');
    }
    if (privateKey && metadataValue) {
      const metadata = parseRecord(metadataValue, 'corrupt_issuer_identity');
      if (metadata.issuerId !== issuerId || metadata.displayName !== displayName) {
        throw new LicensingStoreError('A different issuer identity is already enrolled.', 'issuer_identity_conflict');
      }
      const keyHash = validatePair(privateKey, metadata.publicKey, 'corrupt_issuer_identity');
      return { ...metadata, privateKey, keyHash };
    }
    const pair = generateSigningKeyPair();
    const metadata = { issuerId, displayName, publicKey: pair.publicKey };
    await this.secrets.put(LICENSING_ACCOUNTS.issuerPrivateKey, pair.privateKey);
    try {
      await this.secrets.put(LICENSING_ACCOUNTS.issuerMetadata, canonicalJson(metadata));
    } catch (error) {
      await this.secrets.remove(LICENSING_ACCOUNTS.issuerPrivateKey).catch(() => {});
      throw error;
    }
    return {
      ...metadata,
      privateKey: pair.privateKey,
      keyHash: publicKeyFingerprint(pair.publicKey),
    };
  }

  async loadIssuerIdentity() {
    const metadataValue = await this.secrets.get(LICENSING_ACCOUNTS.issuerMetadata);
    const privateKey = await this.secrets.get(LICENSING_ACCOUNTS.issuerPrivateKey);
    if (!metadataValue && !privateKey) return null;
    if (!metadataValue || !privateKey) {
      throw new LicensingStoreError('Licensing issuer identity is incomplete.', 'corrupt_issuer_identity');
    }
    const metadata = parseRecord(metadataValue, 'corrupt_issuer_identity');
    return {
      ...metadata,
      privateKey,
      keyHash: validatePair(privateKey, metadata.publicKey, 'corrupt_issuer_identity'),
    };
  }

  async saveEntitlement(token) {
    await this.secrets.put(LICENSING_ACCOUNTS.entitlement, token);
  }

  async loadEntitlement() {
    return this.secrets.get(LICENSING_ACCOUNTS.entitlement);
  }

  async saveRecoveryState(recoveryKit) {
    if (!recoveryKit || typeof recoveryKit.id !== 'string' || typeof recoveryKit.secret !== 'string') {
      throw new LicensingStoreError('Recovery state is invalid.', 'invalid_recovery_state');
    }
    await this.secrets.put(LICENSING_ACCOUNTS.recoveryState, canonicalJson(recoveryKit));
  }

  async loadRecoveryState() {
    return parseRecord(
      await this.secrets.get(LICENSING_ACCOUNTS.recoveryState),
      'corrupt_recovery_state',
    );
  }

  async saveFounderMarker(marker) {
    await this.secrets.put(LICENSING_ACCOUNTS.founderMarker, canonicalJson(marker));
  }

  async loadFounderMarker() {
    return parseRecord(
      await this.secrets.get(LICENSING_ACCOUNTS.founderMarker),
      'corrupt_founder_marker',
    );
  }

  async saveClockState(clockState) {
    if (!clockState || !Number.isFinite(Date.parse(clockState.lastSeenAt))) {
      throw new LicensingStoreError('Licensing clock state is invalid.', 'invalid_clock_state');
    }
    await this.secrets.put(LICENSING_ACCOUNTS.clockState, canonicalJson(clockState));
  }

  async loadClockState() {
    return parseRecord(
      await this.secrets.get(LICENSING_ACCOUNTS.clockState),
      'corrupt_clock_state',
    );
  }
}

export async function bootstrapFounder({
  store,
  holder,
  issuerId,
  displayName,
  recoveryKit,
  recover,
  verifyEntitlement,
}) {
  if (!(store instanceof LicensingStore)
    || typeof recover !== 'function'
    || typeof verifyEntitlement !== 'function'
    || !recoveryKit) {
    throw new LicensingStoreError('Founder provisioning request is invalid.', 'invalid_founder_request');
  }
  const device = await store.ensureDeviceIdentity();
  const issuer = await store.ensureIssuerIdentity({ issuerId, displayName });
  const response = await recover({
    recoveryId: recoveryKit.id,
    recoverySecret: recoveryKit.secret,
    holder,
    newIssuer: {
      id: issuer.issuerId,
      displayName: issuer.displayName,
      publicKey: issuer.publicKey,
    },
    deviceKeyHash: device.keyHash,
  });
  const evaluation = await verifyEntitlement(response.entitlement, device);
  if (!evaluation?.valid || evaluation.edition !== 'Founder') {
    throw new LicensingStoreError('Founder entitlement verification failed.', 'invalid_founder_entitlement');
  }
  await store.saveRecoveryState(response.recoveryKit);
  await store.saveEntitlement(response.entitlement);
  await store.saveFounderMarker({ edition: 'Founder', issuerId: response.issuer.id });
  return { issuer: response.issuer, entitlement: evaluation, recoveryKit: response.recoveryKit };
}

export async function writeRecoveryKitFile(filePath, payload) {
  if (typeof filePath !== 'string' || !payload || typeof payload !== 'object') {
    throw new LicensingStoreError('Recovery export is invalid.', 'invalid_recovery_export');
  }
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
}
