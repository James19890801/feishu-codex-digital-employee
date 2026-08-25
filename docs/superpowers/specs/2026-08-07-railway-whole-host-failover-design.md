# Railway Whole-Host Failover Design

## Goal

Keep AIPR0S local-first while allowing a dedicated Railway service to receive and safely answer authorized DingTalk messages when the Mac is offline. Local execution remains primary; per-request local failure still falls back to Qoder through Cloudflare after three bounded attempts. Whole-host takeover begins after three missed 30-second heartbeats and remains available for messages arriving later in the outage.

## Architecture

Cloudflare remains the control plane. Its Worker and Durable Object own heartbeat evaluation, generation fencing, claim deduplication, recovery draining, Qoder invocation, and the metadata-only console. Railway replaces only the unavailable Cloudflare Container data plane.

The Railway service runs the existing DWS worker image continuously. It imports a dedicated cloud DWS authorization from sealed environment variables, injects the registered digital-human Channel code into DWS subprocesses, establishes the DWS event stream, polls the Cloudflare coordinator for a lease, and answers only when the coordinator reports the current generation as active. It never receives the local DWS Profile, local files, or local memory. The Channel is a static Alibaba routing identifier, not a login credential.

## Components

### Cloudflare coordinator

- Add an authenticated Railway lease endpoint under the existing internal bearer-token boundary.
- Return only coordinator state, generation, and whether the Railway runtime should activate.
- Continue using `ready`, `claim`, `complete`, and `qoder` as the authoritative mutation boundary.
- Evaluate heartbeat expiry during Railway lease polling so takeover does not depend on Cloudflare Container alarms.
- Retain generation fencing and close new claims during `DRAINING`.

### Railway DWS runtime

- Start an HTTP liveness server on Railway's injected `PORT`.
- Authenticate the dedicated DWS account at startup and keep the DWS event consumer connected while on standby.
- Poll the coordinator every 10 seconds with bounded exponential backoff and jitter.
- On a new `TAKING_OVER` generation, call `ready`, run a three-minute DWS `list-mentions` backfill for authorized groups, then accept current events.
- On `LOCAL_PRIMARY` or `DRAINING`, keep the process warm but do not create claims or send replies.
- Reconnect the DWS event stream after unexpected exit without terminating the whole service.

### Qoder Cloud Agent

- Keep the existing server-side Qoder adapter, pinned Agent version, Environment, request digest checks, L0/L1-only policy, retry handling, and session cleanup.
- Railway never receives the Qoder PAT; it asks Cloudflare to execute Qoder through the internal endpoint.

## Data Flow

1. The Mac sends signed heartbeats every 30 seconds to Cloudflare.
2. Railway polls the internal lease endpoint every 10 seconds.
3. After 90 seconds without a healthy local heartbeat, Cloudflare moves to `TAKING_OVER` and increments the generation.
4. Railway observes the new generation, confirms DWS authentication, calls `ready`, and performs a three-minute authorized-chat backfill.
5. Each eligible message is normalized and checked against chat, sender, content-type, age, and risk policy.
6. Railway obtains an idempotent claim, requests a Qoder response from Cloudflare, sends one UUID-stable natural DingTalk reply without exposing the selected runtime, and completes the claim. A bounded image first goes through Cloudflare Workers AI vision and only the resulting bounded description is sent to Qoder.
7. L2/L3 requests receive only the owner-confirmation handoff and perform no external mutation.
8. After three healthy local heartbeats, Cloudflare enters `DRAINING`; Railway stops new claims. Once in-flight work completes, Cloudflare returns to `LOCAL_PRIMARY`.

## Security and Secrets

Railway service variables hold `DINGTALK_DWS_AUTH_BUNDLE_B64`, `AIPROS_CLOUD_DWS_CHANNEL`, `AIPROS_DWS_HOME`, `AIPROS_COORDINATOR_URL`, `AIPROS_CONTAINER_TOKEN`, `AIPROS_ACCESS_MODE=blacklist`, `AIPROS_BLOCKED_CHAT_IDS`, `AIPROS_BLOCKED_SENDER_IDS`, and `RAILWAY_RUN_UID`. Blocked identities are synchronized from the active local main configuration's DingTalk `automaticCommunicationBlocklist`; legacy allowlists are not an authority. Values are never committed or printed. DWS built-in device OAuth is the default; `DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET` remain an optional all-or-nothing override for a self-created app. The coordinator token is independently revocable. Cloudflare retains the Qoder PAT and HMAC secret. A Railway Volume mounted at `/data` preserves the DWS 1.0.56 file-DEK and rotated refresh token. The original auth bundle is imported only when the persistent home is empty; later authentication failures fail closed and never overwrite rotated state.

The runtime fails closed if required values are absent, the DWS account is not authenticated, the lease is stale, the generation changes, the message matches the configured blacklist, or Cloudflare cannot issue a claim. No local identity material is copied to Railway.

## Reliability and Operations

- Railway health path is `/live`; readiness details remain non-public and are redacted from logs.
- Configure deployment draining so SIGTERM can finish in-flight completion calls.
- Use Railway `Always` restart policy when the account plan supports it. If the account only permits ten `On Failure` restarts, the deployment must not be labeled verified 7x24.
- Cloudflare remains the single source of truth, so Railway restarts cannot create duplicate replies.
- The status console will display runtime kind and last Railway lease age without exposing messages or credentials.

## Error Handling

- Lease polling uses capped retry and never assumes activation after a network error.
- DWS stream failures trigger reconnection; repeated authentication failure makes `/live` unhealthy only after startup diagnostics have been recorded.
- A failed Qoder call completes the claim with a bounded failure code and sends no fabricated answer.
- A DingTalk send failure completes the claim as failed; stable UUID prevents duplicate delivery if the transport result was ambiguous.
- A stale generation aborts the current message before sending.

## Testing and Acceptance

- Unit tests cover lease responses, expiry evaluation, Railway activation/deactivation, reconnection, generation changes, and fail-closed behavior.
- Container tests verify the Railway `PORT`, `/live`, DWS CLI presence, and signal handling.
- Worker dry-run and complete project checks must pass.
- Deployment evidence must include Railway build success, active deployment, redacted variable presence, health success, Cloudflare lease polling, and Qoder smoke success.
- Final 7x24 acceptance uses a controlled Mac stop, waits at least 90 seconds, sends an authorized message 30 minutes later, verifies exactly one cloud-labelled reply, restores the Mac, and verifies clean drain back to local primary.

## Rollback

Disable Railway lease activation in Cloudflare, stop the Railway service, revoke its coordinator token and dedicated DWS authorization, and keep the existing Cloudflare per-request Qoder fallback. No local data migration is required.
