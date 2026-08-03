# AIPRO Invitation Licensing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Require clean AIPRO installations to enter a one-time ten-digit invitation code while giving the current James machine recoverable Founder and invite-issuer authority.

**Architecture:** A Cloudflare Worker with D1 atomically manages invitation state and signs device-bound entitlements; a private Cloudflare KV object stores the rotatable James contact card outside Git history. The local Node service stores device, issuer, and entitlement secrets only in macOS Keychain, verifies entitlements offline, leaves the loopback dashboard available for activation and developer contact, and gates the core IM worker before any channels start.

**Tech Stack:** Node.js ESM, Node `crypto`/Web Crypto, macOS Keychain CLI adapter, vanilla browser JavaScript, Cloudflare Workers, D1 SQLite, private Workers KV object storage, Wrangler, Node test scripts.

---

### Task 1: Implement portable licensing cryptography

**Files:**
- Create: `src/licensing/crypto.mjs`
- Create: `src/licensing/crypto.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Cover deterministic canonical JSON, Ed25519 key generation, device fingerprinting, signed entitlement round-trip, modified payload rejection, wrong-key rejection, malformed token rejection, and expired/not-yet-valid evaluation.

```js
const pair = generateSigningKeyPair();
const payload = { version: 1, product: 'AIPRO', licenseId: 'lic_test' };
const token = signEnvelope(payload, pair.privateKey);
assert.deepEqual(verifyEnvelope(token, pair.publicKey), payload);
assert.throws(() => verifyEnvelope(tamper(token), pair.publicKey));
```

**Step 2: Run test to verify it fails**

Run: `node src/licensing/crypto.test.mjs`
Expected: FAIL because `crypto.mjs` does not exist.

**Step 3: Write minimal implementation**

Use `generateKeyPairSync('ed25519')`, DER PKCS8/SPKI base64url serialization, `sign(null, ...)`, `verify(null, ...)`, a recursively sorted canonical JSON encoder, SHA-256 public-key fingerprints, strict token size limits, and stable error classes. Do not add a cryptography dependency.

**Step 4: Run test to verify it passes**

Run: `node src/licensing/crypto.test.mjs`
Expected: `LICENSING_CRYPTO_TEST_OK`.

**Step 5: Commit**

```bash
git add src/licensing/crypto.mjs src/licensing/crypto.test.mjs package.json
git commit -m "feat: add signed licensing envelopes"
```

### Task 2: Build the invitation and activation domain service

**Files:**
- Create: `licensing/worker/src/domain.mjs`
- Create: `licensing/worker/src/domain.test.mjs`
- Create: `licensing/worker/schema.sql`

**Step 1: Write the failing test**

Use an in-memory repository adapter to prove each batch contains exactly ten ten-digit unique codes, plaintext is returned once, stored records contain only keyed hashes and last-four digits, activation is atomic and device-bound, invalid/used/expired/revoked codes share a generic failure, and failed attempts enter cooldown.

```js
const batch = await service.generateBatch({ issuerId: 'issuer-james', count: 10 });
assert.equal(batch.codes.length, 10);
assert.equal(new Set(batch.codes).size, 10);
assert.equal(batch.codes.every(code => /^\d{10}$/.test(code)), true);
await service.activate({ code: batch.codes[0], deviceKeyHash: 'sha256:device-a' });
await assert.rejects(() => service.activate({ code: batch.codes[0], deviceKeyHash: 'sha256:device-b' }));
```

**Step 2: Run test to verify it fails**

Run: `node licensing/worker/src/domain.test.mjs`
Expected: FAIL because the domain service does not exist.

**Step 3: Write minimal implementation**

Generate digits from `crypto.getRandomValues`, use HMAC-SHA-256 with a server pepper, retry collisions against a repository uniqueness boundary, use a single conditional consume operation, and return structured error codes safe for generic public messages.

Create D1 tables for `issuers`, `issuer_challenges`, `invite_batches`, `invites`, `activations`, `rate_limits`, and `recovery_credentials`, including unique code-hash and one-activation-per-invite constraints.

**Step 4: Run test to verify it passes**

Run: `node licensing/worker/src/domain.test.mjs`
Expected: `LICENSING_DOMAIN_TEST_OK`.

**Step 5: Commit**

```bash
git add licensing/worker/src/domain.mjs licensing/worker/src/domain.test.mjs licensing/worker/schema.sql
git commit -m "feat: add one-time invitation domain"
```

### Task 3: Implement and locally test the Cloudflare Worker

**Files:**
- Create: `licensing/worker/src/index.mjs`
- Create: `licensing/worker/src/index.test.mjs`
- Create: `licensing/worker/wrangler.toml`
- Create: `licensing/worker/package.json`
- Modify: `pnpm-workspace.yaml`
- Modify: `.gitignore`

**Step 1: Write the failing test**

Test `GET /v1/health`, strict methods/content types/body sizes, generic activation errors, issuer challenge replay rejection, invalid issuer signature rejection, authorized ten-code generation, and recovery-secret rotation. Assert `Cache-Control: no-store` and request IDs on every API response.

**Step 2: Run test to verify it fails**

Run: `node licensing/worker/src/index.test.mjs`
Expected: FAIL because the Worker handler does not exist.

**Step 3: Write minimal implementation**

Export `fetch(request, env)` and inject repository/time/random adapters for tests. Validate exact JSON shapes. Authenticate issuer requests with a one-use challenge and Ed25519 signature. Import the license signing key only from Worker secrets. Do not enable browser CORS.

Set the D1 binding name to `DB`; declare secret names but never values. Ignore Wrangler state and local D1 files.

**Step 4: Run tests and Wrangler local smoke**

Run: `node licensing/worker/src/index.test.mjs`
Expected: `LICENSING_WORKER_TEST_OK`.

Run: `pnpm --dir licensing/worker exec wrangler deploy --dry-run`
Expected: Worker bundle succeeds without secret values in output.

**Step 5: Commit**

```bash
git add licensing/worker pnpm-workspace.yaml pnpm-lock.yaml .gitignore
git commit -m "feat: add AIPRO activation worker"
```

### Task 4: Add Keychain-backed local identity and recovery

**Files:**
- Create: `src/licensing/keychain.mjs`
- Create: `src/licensing/keychain.test.mjs`
- Create: `src/licensing/store.mjs`
- Create: `src/licensing/store.test.mjs`
- Create: `scripts/licensing-bootstrap-founder.mjs`
- Create: `scripts/licensing-recover-founder.mjs`
- Modify: `.gitignore`
- Modify: `package.json`

**Step 1: Write failing tests**

Inject an in-memory secret adapter and verify separate Keychain accounts for device private key, entitlement, issuer private key, and recovery state; `0o600` recovery export; secret redaction; corrupt-secret fail-closed behavior; Founder bootstrap order; replacement issuer enrollment; previous issuer revocation; and recovery rotation.

**Step 2: Run tests to verify they fail**

Run: `node src/licensing/keychain.test.mjs && node src/licensing/store.test.mjs`
Expected: FAIL because the modules do not exist.

**Step 3: Write minimal implementation**

Wrap `/usr/bin/security` through argument arrays only, never the shell. Store PKCS8 and entitlement values as generic passwords under `com.aipro.licensing`. Use opaque account identifiers. Never include secret output in thrown errors or logs.

Bootstrap must generate the device and issuer keys, call the recovery endpoint, write the Founder entitlement successfully, verify it locally, and only then write an issuer-enabled marker. Recovery kits remain untracked and are created with owner-only permissions.

**Step 4: Run tests to verify they pass**

Run: `node src/licensing/keychain.test.mjs && node src/licensing/store.test.mjs`
Expected: `LICENSING_KEYCHAIN_TEST_OK` and `LICENSING_STORE_TEST_OK`.

**Step 5: Commit**

```bash
git add src/licensing scripts/licensing-*.mjs package.json .gitignore
git commit -m "feat: add recoverable Keychain licensing identity"
```

### Task 5: Add the local activation client and fail-closed startup guard

**Files:**
- Create: `src/licensing/client.mjs`
- Create: `src/licensing/client.test.mjs`
- Create: `src/licensing/guard.mjs`
- Create: `src/licensing/guard.test.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `src/index.mjs`
- Modify: `scripts/health-check.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write failing tests**

Test timeouts, HTTPS-only production URL validation, response-size limits, secret-free errors, valid Founder/Business entitlement acceptance, wrong-device/expired/tampered entitlement rejection, clock rollback detection, dashboard-only unlicensed state, and no channel/runtime initialization before guard approval.

**Step 2: Run tests to verify they fail**

Run: `node src/licensing/client.test.mjs && node src/licensing/guard.test.mjs`
Expected: FAIL because the client and guard do not exist.

**Step 3: Write minimal implementation**

Add `licensingServiceUrl`, `licensingProductId`, and packaged-install enforcement configuration. Run the guard before `AgentState`, IM channel, Multica, AI runtime, and polling initialization. When blocked, keep the process in a low-cost wait loop or exit with a stable configuration status that LaunchAgent health understands; never start channel listeners.

**Step 4: Run focused and mechanism tests**

Run: `node src/licensing/client.test.mjs && node src/licensing/guard.test.mjs && node src/mechanism-acceptance.test.mjs`
Expected: all pass, and mechanism count increases with licensing cases.

**Step 5: Commit**

```bash
git add src/licensing src/config.mjs config.example.json src/index.mjs scripts/health-check.mjs src/mechanism-acceptance.test.mjs
git commit -m "feat: gate AIPRO core on device entitlement"
```

### Task 6: Add secure loopback licensing APIs

**Files:**
- Create: `src/licensing/dashboard-api.mjs`
- Create: `src/licensing/dashboard-api.test.mjs`
- Modify: `src/dashboard-server.mjs`
- Modify: `src/dashboard-api-security.mjs`
- Modify: `src/dashboard-api-security.test.mjs`

**Step 1: Write failing tests**

Test status without secret disclosure, ten-digit validation, activation, issuer challenge status, exactly-ten generation, copy-safe one-time batch response, invite listing with masked codes, revocation, recovery import, invalid origin/session/action rejection, and forced browser-UI authorization rejection.

**Step 2: Run tests to verify they fail**

Run: `node src/licensing/dashboard-api.test.mjs && node src/dashboard-api-security.test.mjs`
Expected: FAIL because licensing actions are not registered.

**Step 3: Write minimal implementation**

Add loopback routes under `/api/licensing/*`. Reuse host/origin/session/action checks for mutations. Authorize issuer mutations only after a live service challenge signed by the Keychain issuer key. Return status metadata but never private keys, full stored invitations, recovery secrets, or entitlement tokens.

**Step 4: Run tests to verify they pass**

Run: `node src/licensing/dashboard-api.test.mjs && node src/dashboard-api-security.test.mjs`
Expected: both pass.

**Step 5: Commit**

```bash
git add src/licensing/dashboard-api.mjs src/licensing/dashboard-api.test.mjs src/dashboard-server.mjs src/dashboard-api-security.mjs src/dashboard-api-security.test.mjs
git commit -m "feat: expose protected local licensing APIs"
```

### Task 7: Build the activation gate and Invite Studio

**Files:**
- Modify: `dashboard/index.html`
- Modify: `dashboard/styles.css`
- Modify: `dashboard/app.js`
- Modify: `dashboard/i18n.js`
- Modify: `dashboard/i18n.test.mjs`
- Modify: `dashboard/visual-contract.test.mjs`
- Create: `dashboard/licensing-ui.test.mjs`
- Create: `dashboard/contact-ui.test.mjs`
- Modify: `scripts/dashboard-browser-smoke.mjs`

**Step 1: Write failing contract tests**

Assert the approved English and Chinese identity narrative, a single ten-digit numeric activation field, localized activation errors, no operations console exposure while unlicensed, a global contact control in every license state, accessible contact dialog behavior, contact-card retry behavior, issuer-card absence for ordinary status, issuer-card presence only for authorized status, fixed batch size ten, code copy/CSV behavior, no secrets in DOM/localStorage, and unchanged existing control IDs/API contracts.

**Step 2: Run tests to verify they fail**

Run: `node dashboard/licensing-ui.test.mjs && node dashboard/contact-ui.test.mjs && node dashboard/visual-contract.test.mjs`
Expected: FAIL because licensing UI is absent.

**Step 3: Write minimal UI**

Add the approved bilingual product narrative and an accessible activation gate matching the established warm-neutral visual system. Accept digits only, normalize pasted whitespace, disable repeated submissions, and use generic invalid-code text. Add the global developer-contact control and modal/bottom sheet, loading the James contact card only on demand. Add the bottom-right Invite Studio card, defaulting to exactly ten invitations with copy-all, CSV download, masked history, notes, and revoke controls. Keep all secret-bearing state in memory only.

**Step 4: Run browser regression**

Run: `npm run dashboard-browser-smoke`
Expected: licensed desktop/wide/mobile views pass; mocked unlicensed and issuer views pass with zero console/resource errors, clipping, horizontal overflow, or unintended CJK in English mode.

**Step 5: Commit**

```bash
git add dashboard scripts/dashboard-browser-smoke.mjs package.json
git commit -m "feat: add one-step activation and Invite Studio"
```

### Task 8: Deploy, bootstrap Founder authority, and prove non-regression

**Files:**
- Modify: `README`
- Create: `docs/LICENSING.md`
- Create: `scripts/licensing-smoke.mjs`
- Create locally and upload without Git tracking: James contact-card asset
- Modify: `package.json`

**Step 1: Add deployment and recovery documentation**

Document Worker/D1 setup, secrets, current-machine bootstrap, two recovery kits, new-machine recovery, issuer revocation, invitation lifecycle, activation privacy boundary, outage behavior, and the source-available limitation. Do not include live URLs, secrets, codes, or tokens in examples.

**Step 2: Run local release checks**

Run: `npm test && npm run check && npm run dashboard-browser-smoke`
Expected: all pass.

Run: `pnpm --dir licensing/worker exec wrangler deploy --dry-run`
Expected: bundle succeeds.

**Step 3: Deploy without exposing secrets**

Create/apply D1 migrations, create the private KV namespace/binding, strip metadata from the James contact card, upload it without Git tracking, set secrets through Wrangler secret input, deploy the Worker, and record only the public service URL in local configuration. Never put credentials in command arguments or logs.

**Step 4: Bootstrap before enforcement**

Generate and securely save separate James and Zhao Founder Recovery Kits. Enroll the current James issuer, obtain and locally verify the current machine's Founder entitlement, then enable enforcement and restart only the isolated/test instance first.

**Step 5: Run live acceptance**

Run: `npm run licensing-smoke`
Expected: contact-card endpoint returns only the expected image with safe headers; ten unique codes; first activation succeeds; duplicate/wrong-device/invalid/rate-limited cases fail; issuer replacement recovery succeeds; old issuer fails afterward.

Run: `npm run health && npm run event-health && npm run backup-smoke && npm run multica-smoke`
Expected: the current licensed installation is healthy; Feishu, DingTalk, Multica, SQLite, event stream, and backups remain healthy.

**Step 6: Commit**

```bash
git add README docs/LICENSING.md scripts/licensing-smoke.mjs package.json
git commit -m "docs: add AIPRO licensing operations guide"
```

### Task 9: Integrate and publish safely

**Files:**
- Review all changed files from Tasks 1-8.

**Step 1: Run final verification**

Run: `git diff --check && npm test && npm run check && npm run dashboard-browser-smoke && npm run health && npm run event-health && npm run backup-smoke`
Expected: all pass and current service state is healthy.

**Step 2: Review secret hygiene**

Run repository secret scans for PEM private keys, recovery material, invitation plaintext fixtures outside tests, Worker secret values, dashboard token exposure, and accidental configuration changes. Confirm only synthetic test values exist.

**Step 3: Merge without disturbing user files**

Merge the tested feature branch into `agent/aipro-commercial-platform-upgrade`, preserve unrelated untracked `outputs/` and `security_best_practices_report.md`, install dependencies with pnpm, and apply local Founder provisioning before restarting services.

**Step 4: Push and verify remote**

Push the integration branch through the configured system proxy if required. Verify local HEAD equals upstream HEAD and rerun health plus one non-mutating browser smoke test.
