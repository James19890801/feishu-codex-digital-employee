# AIPRO Licensing Operations

## User experience

An unlicensed installation exposes only the loopback dashboard, the ten-digit
activation field, language selection, and developer contact. Core message
polling, WebSocket listeners, AI runtimes, Multica, memory, and outbound replies
remain stopped. After a successful activation, the signed device entitlement is
stored in macOS Keychain and normal startup is allowed.

James Feng and Zhao Yingzhi are independent Founder authorities. A Founder
device with a valid issuer key sees **Invite Studio** in the dashboard. Each
generation creates exactly ten unique, numeric, one-time codes. An ordinary
licensed device cannot call the generation endpoint even if its user modifies
the browser interface.

## Hosted components

- Cloudflare Worker: activation, issuer challenges, invitation generation, and
  Founder recovery.
- D1: invitation, entitlement, issuer, challenge, and recovery state.
- Cloudflare KV: private, replaceable James contact-card image.
- Worker secrets: license-signing private key and independent invitation and
  recovery hashing peppers.

No private signing key, hashing pepper, recovery secret, invitation plaintext,
device private key, issuer private key, or entitlement token belongs in Git,
logs, screenshots, support messages, or the browser DOM.

## Founder recovery

Current recovery files are generated with mode `0600` and are intentionally
outside the repository. Every successful recovery consumes the input secret,
revokes the previous issuer registration, and writes a newly rotated kit. Keep
the newest kit in an encrypted password manager and an offline encrypted copy.
The old kit must be marked obsolete after a successful rotation.

On a replacement Mac, install AIPRO, set the service URL and public key, then
run the Founder recovery script with both an input and a new output path. Never
reuse an existing output path. The script enrolls new device and issuer keys in
Keychain, verifies the Founder entitlement locally, and writes the rotated kit
only after the remote recovery succeeds.

## Availability and network behavior

Licensed startup is offline and fail-safe: an activation-service outage does
not interrupt Feishu, DingTalk, WeCom, Multica, memory, or audit. New activation
and invite generation need the Worker. `licensingProxyUrl` may specify a local
HTTP or HTTPS proxy when direct Cloudflare access is unavailable. Credentials,
query strings, paths, and fragments are rejected in that configuration value.

The licensing subsystem is isolated from IM channel lifecycles. A licensing
network timeout during an already licensed run cannot restart or disconnect a
channel. A missing, corrupt, expired, wrong-device, or tampered entitlement is
fail-closed before any channel or runtime is initialized.

## Deployment checklist

1. Apply `licensing/worker/schema.sql` to the configured D1 database.
2. Configure Worker secrets; never place them in `wrangler.toml`.
3. Upload the contact card to the configured private KV namespace.
4. Deploy the Worker and test `/v1/health` and `/v1/contact-card`.
5. Bootstrap each Founder and immediately back up the rotated recovery kit.
6. Configure `licensingServiceUrl`, `licensingPublicKey`, and product `AIPRO`.
7. Enable `licensingEnforced` only after the current machine verifies as
   Founder.
8. Run the full local test and syntax suites, Worker tests, dashboard browser
   regression, one real ten-code generation, and one clean-device activation.
9. Restart the supervised dashboard and core services, then verify that every
   existing IM channel retains its previous health state.
