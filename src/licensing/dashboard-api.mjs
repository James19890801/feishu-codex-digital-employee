import { signEnvelope } from './crypto.mjs';
import { evaluateLicenseGuard } from './guard.mjs';

class LicensingDashboardError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LicensingDashboardError';
    this.code = code;
  }
}

function invitationRequest(value = {}) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw new LicensingDashboardError('Invitation request is invalid.', 'invalid_invitation_request');
  }
  const allowed = new Set(['customerNote', 'invitationDays', 'licenseDays']);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new LicensingDashboardError('Invitation request is invalid.', 'invalid_invitation_request');
  }
  const request = {};
  if (value.customerNote !== undefined) {
    const note = String(value.customerNote).trim();
    if (note.length > 200) {
      throw new LicensingDashboardError('Invitation note is too long.', 'invalid_invitation_request');
    }
    if (note) request.customerNote = note;
  }
  for (const key of ['invitationDays', 'licenseDays']) {
    if (value[key] === undefined) continue;
    const number = Number(value[key]);
    if (!Number.isInteger(number) || number < 1 || number > 3650) {
      throw new LicensingDashboardError('Invitation duration is invalid.', 'invalid_invitation_request');
    }
    request[key] = number;
  }
  return request;
}

export class LicensingDashboardApi {
  constructor({
    store,
    client,
    publicKey,
    product = 'AIPRO',
    enforced = false,
    now = () => new Date(),
  }) {
    this.store = store;
    this.client = client;
    this.publicKey = publicKey;
    this.product = product;
    this.enforced = enforced;
    this.now = now;
  }

  async decision() {
    return evaluateLicenseGuard({
      enforced: this.enforced,
      store: this.store,
      publicKey: this.publicKey,
      product: this.product,
      now: this.now(),
    });
  }

  async status() {
    const decision = await this.decision();
    if (!decision.allowed) {
      return {
        ok: true,
        enforced: this.enforced,
        activated: false,
        reason: decision.reason,
        issuer: { authorized: false },
      };
    }
    let issuerView = { authorized: false };
    if (decision.edition === 'Founder') {
      try {
        const [issuer, marker] = await Promise.all([
          this.store.loadIssuerIdentity(),
          this.store.loadFounderMarker(),
        ]);
        if (issuer && marker?.edition === 'Founder' && marker.issuerId === issuer.issuerId) {
          issuerView = {
            authorized: true,
            id: issuer.issuerId,
            displayName: issuer.displayName,
          };
        }
      } catch {
        issuerView = { authorized: false };
      }
    }
    return {
      ok: true,
      enforced: this.enforced,
      activated: true,
      edition: decision.edition,
      ...(decision.expiresAt ? { expiresAt: decision.expiresAt } : {}),
      issuer: issuerView,
    };
  }

  async activate({ code } = {}) {
    const normalized = String(code || '').replace(/\s+/g, '');
    if (!/^\d{10}$/.test(normalized)) {
      throw new LicensingDashboardError('Enter a 10-digit invitation code.', 'invalid_invitation_format');
    }
    const device = await this.store.ensureDeviceIdentity();
    const result = await this.client.activate({
      code: normalized,
      deviceKeyHash: device.keyHash,
      installId: `install_${device.keyHash.slice(-24)}`,
    });
    await this.store.saveEntitlement(result.entitlement);
    const decision = await this.decision();
    if (!decision.allowed) {
      throw new LicensingDashboardError('Activated entitlement failed local verification.', 'invalid_entitlement');
    }
    const status = await this.status();
    return { ...status, activated: true };
  }

  async generate(value = {}) {
    const status = await this.status();
    if (!status.activated || !status.issuer.authorized) {
      throw new LicensingDashboardError('Issuer is not authorized.', 'issuer_not_authorized');
    }
    const issuer = await this.store.loadIssuerIdentity();
    const request = invitationRequest(value);
    const challengeResult = await this.client.issuerChallenge({ issuerId: issuer.issuerId });
    const challenge = challengeResult.challenge;
    if (!challenge?.id || !challenge?.nonce) {
      throw new LicensingDashboardError('Issuer challenge is invalid.', 'invalid_issuer_challenge');
    }
    const proof = signEnvelope({
      version: 1,
      action: 'invite.issue',
      issuerId: issuer.issuerId,
      challengeId: challenge.id,
      nonce: challenge.nonce,
      request,
    }, issuer.privateKey);
    const result = await this.client.generateInvites({
      issuerId: issuer.issuerId,
      proof,
      request,
    });
    if (!Array.isArray(result?.batch?.codes)
      || result.batch.codes.length !== 10
      || result.batch.codes.some(code => !/^\d{10}$/.test(code))
      || new Set(result.batch.codes).size !== 10) {
      throw new LicensingDashboardError('Invitation batch is invalid.', 'invalid_invitation_batch');
    }
    return {
      id: result.batch.id,
      codes: [...result.batch.codes],
      createdAt: result.batch.createdAt,
    };
  }
}
