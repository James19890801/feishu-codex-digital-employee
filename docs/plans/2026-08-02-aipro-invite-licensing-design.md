# AIPRO Invitation Licensing Design

## Objective

Require ordinary new installations to activate AIPRO with a one-time ten-digit invitation code before the message-processing service can run, while keeping the dashboard available for activation and keeping already activated installations independent from activation-service availability.

The ordinary-user flow is deliberately limited to three actions: open AIPRO, enter the invitation code supplied by an authorized developer, and select **Activate AIPRO**.

## Product boundary

- The dashboard, documentation, adapters, and source remain visible in the public repository.
- Production operation requires a device-bound signed entitlement.
- The licensing feature deters ordinary download-and-run use; it cannot make a fully public local codebase impossible to patch.
- No IM credentials, chat content, Codex authentication, Multica data, or local files are sent to the activation service.
- The current James machine receives a Founder entitlement before enforcement is enabled.

## Roles and trust model

### Activation service

A small Cloudflare Worker owns the license-signing key through a deployment secret and stores invitation state in D1. The public verification key is embedded in AIPRO. The service signs device entitlements but never receives the device private key.

### Authorized issuer

The current James machine has an issuer key pair generated with cryptographically secure randomness. The private key is stored in macOS Keychain under a product-specific service name; the online service stores only its public key and issuer certificate. Zhao Yingzhi can enroll a separate machine and key later. Issuer requests use a short-lived server challenge and a signature, not a browser flag or a developer name.

### Founder recovery

Founder authority is recoverable independently of any developer computer. Initial provisioning produces separate, one-time recovery kits for James Feng and Zhao Yingzhi. The service stores only a keyed hash of each recovery secret. A recovery kit can enroll a replacement issuer key, revoke the previous issuer, obtain a replacement Founder entitlement, and rotate the recovery secret. Recovery material must be stored outside the developer computer in an encrypted password manager and an offline copy.

### Customer installation

Each installation generates its own device key pair and stores the private key in Keychain. Activation binds the entitlement to the SHA-256 fingerprint of the device public key. Copying only the entitlement to another computer does not satisfy device binding.

## Invitation format and lifecycle

- Exactly ten decimal digits.
- Generated with a cryptographically secure random-number generator.
- Generated in batches of exactly ten from the James dashboard.
- D1 enforces uniqueness; collisions are regenerated before the batch is returned.
- The service stores a keyed hash of the code plus the final four display digits, never retrievable plaintext.
- Plaintext codes are returned once to the issuer dashboard for copying or CSV export.
- Default invitation activation window: 30 days.
- Default resulting entitlement: one device, 365 days.
- States: `unused`, `activated`, `expired`, `revoked`.
- Activation uses an atomic conditional update so concurrent requests cannot consume one code twice.
- Failed activation is rate limited by privacy-preserving hashes of IP and installation ID.

## User experience

### Unlicensed installation

The dashboard serves an activation gate before the operations console. It includes one ten-digit input, an activation button, localized error text, and support instructions. Core IM workers stay inactive. The dashboard and its local activation endpoint remain available.

### Licensed installation

The signed entitlement is stored in Keychain. AIPRO verifies the service signature, product ID, validity period, and device-key fingerprint locally. No online request is required for ordinary service startup. Activation-service outages therefore cannot interrupt Feishu, DingTalk, Multica, memory, or audit on a licensed installation.

### Issuer installation

After the dashboard completes a server challenge with a registered issuer key, a compact **Invite Studio** card appears at the bottom right. Selecting **Generate 10 invites** creates one batch. The panel offers copy-all, CSV download, status inspection, customer notes, and revocation. The card is absent on ordinary installations. Server authorization is authoritative even if someone forces the HTML to render.

## Local components

- `src/licensing/crypto.mjs`: canonical encoding, public-key fingerprints, signing, verification, and token parsing.
- `src/licensing/keychain.mjs`: safe macOS Keychain access with redacted errors and test adapters.
- `src/licensing/store.mjs`: device identity, entitlement storage, issuer identity, and recovery-kit import/export orchestration.
- `src/licensing/client.mjs`: bounded HTTP client for activation, issuer challenges, invite generation, revocation, and recovery.
- `src/licensing/guard.mjs`: local entitlement evaluation and startup decision.
- `src/dashboard-server.mjs`: loopback-only licensing APIs; never returns private keys or stored entitlement tokens.
- `src/index.mjs`: license guard before channel clients, message polling, or AI runtime execution.
- `dashboard/*`: activation gate and issuer-only Invite Studio.

## Online components

- `licensing/worker/src/index.mjs`: Cloudflare Worker API.
- `licensing/worker/schema.sql`: D1 schema and indexes.
- `licensing/worker/wrangler.toml`: non-secret bindings and deployment configuration.
- Worker secrets: license-signing private key, invitation hashing pepper, recovery hashing pepper.
- Public endpoints: health and activation.
- Signed issuer endpoints: challenge, batch generation, batch status, revocation.
- Recovery endpoint: one-time recovery kit exchange with automatic rotation.

## API outline

- `GET /v1/health`
- `POST /v1/activate`
- `POST /v1/issuer/challenge`
- `POST /v1/issuer/invites`
- `GET /v1/issuer/invites`
- `POST /v1/issuer/invites/:id/revoke`
- `POST /v1/founder/recover`

Every response has a stable JSON envelope, request ID, explicit cache policy, and no secret echo. Issuer and recovery endpoints fail closed. CORS is unnecessary because the browser calls only the loopback dashboard server; the loopback server calls the Worker.

## Failure and recovery behavior

- Activation service unavailable: new activation and invite generation show a retryable maintenance error; licensed core operation continues.
- Invalid or used code: generic error without revealing whether a specific code exists.
- Concurrent activation: one succeeds; all others receive the same generic invalid-code response.
- Lost developer Mac: use a Founder Recovery Kit on the new Mac, register the new issuer key, revoke the old key, rotate recovery material, and resume generation. Customer entitlements remain valid.
- Lost customer Mac: issue a new invitation or use a future transfer workflow; an entitlement is not transferable by copying files.
- Clock rollback: reject validity checks earlier than the locally stored last-known valid time, but do not make the first release depend on an always-online clock service.
- Corrupt Keychain item: dashboard reports recovery-required; core stays inactive instead of silently bypassing licensing.

## Security requirements

- Never derive a private key from a developer-provided word or password.
- Never commit private keys, Worker secrets, recovery kits, invitation plaintext, or entitlement tokens.
- Use standard platform cryptography; do not implement custom encryption.
- Compare sensitive hashes in constant time where applicable.
- Redact activation code, entitlement, recovery secret, and signatures from logs and audit detail.
- Validate all Worker request schemas and reject unknown or oversized fields.
- Restrict local mutation endpoints with the existing dashboard session/origin/action controls.
- Add fail-closed tests proving that rendering an issuer card cannot authorize invite generation.

## Rollout

1. Deploy the Worker and D1 schema.
2. Provision the service signing key and peppers through Worker secrets.
3. Bootstrap the current James issuer and generate two Founder Recovery Kits.
4. Activate the current Mac with a Founder entitlement.
5. Verify Feishu, DingTalk, Multica, health, event stream, and backup paths.
6. Enable enforcement for packaged/new installations.
7. Keep the currently running checkout unchanged until the isolated worktree passes all regression and recovery tests.

## Acceptance criteria

- An unlicensed clean installation cannot start core message processing.
- The dashboard remains accessible and accepts exactly ten digits.
- One valid code activates exactly one device once.
- A used, expired, revoked, malformed, brute-forced, or concurrently submitted code cannot activate.
- Invite Studio appears only after a valid issuer challenge and creates exactly ten unique numeric codes.
- A forced client-side issuer UI cannot call the protected server endpoint.
- Founder recovery enrolls a replacement issuer and revokes the previous issuer.
- Existing licensed operation remains healthy while the activation service is unavailable.
- Existing Feishu, DingTalk, Multica, privacy, takeover, loop-prevention, memory, and audit tests remain green.

