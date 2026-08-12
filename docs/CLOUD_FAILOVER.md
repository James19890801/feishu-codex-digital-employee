# AIPR0S Cloud Failover Runbook

## Current delivery state

| Layer | State | Evidence |
|---|---|---|
| Local runtime fallback | Implemented and locally tested | Three bounded local attempts, deny-first policy, signed Cloudflare request |
| Whole-Mac coordinator | Implemented and locally tested | 30s heartbeat, 90s takeover, generation fencing, claims, three-heartbeat drain |
| Qoder adapter | Live provisioned and smoke-tested on 2026-08-12 | Tool-free Agent/Environment, Session, content-block event, SSE idle terminal, archive, 429/5xx retry |
| Railway standby DWS runtime | Live, coordinator-confirmed | Independent DWS authorization, always-warm event stream, mention-only 3-minute backfill, generation fencing and UUID send; Cloudflare readback reached `CLOUD_ACTIVE` with runtime `ACTIVE` |
| Railway image build | Live on Railway | Pinned `linux/amd64` Node image, CA certificates and DWS CLI layer build successfully; Cloudflare Container Registry is no longer required |
| Live Cloudflare/Qoder | Activated and smoke-tested on 2026-08-12 | Signed heartbeat reached Qoder through the Worker with the configured Agent and Environment; metadata-only console published |
| Live Railway DingTalk | Activated with restricted allowlists | Isolated DWS device authorization is persisted on the Railway volume; the registered routing Channel is injected into every DWS command; the local Profile is not copied. Full 7x24 acceptance still requires a controlled 30-minute Mac outage and one real late-message reply/readback |
| 7x24 availability | Not yet verified | Requires the controlled stop/reply/recovery acceptance below |

## Runtime contract

Two failover paths are intentionally separate:

1. **Per-message local-first handoff:** every new message starts locally. Only retryable runtime failures consume the maximum three local attempts. After the third failure, the local process sends a signed, sanitized L0/L1 handoff to Cloudflare. The message ID is converted locally into a one-way `handoffId`; Cloudflare atomically claims it, runs Qoder once, and caches only the sanitized result for 15 minutes so a lost HTTP response can be replayed without a second Qoder run. This does not change the global coordinator state, so the next message starts locally again and a recovered local runtime immediately regains priority.
2. **Whole-host takeover:** if the Mac cannot send heartbeats, three missed 30-second heartbeats move the coordinator to `TAKING_OVER`; Railway confirms its DWS event stream and moves it to `CLOUD_ACTIVE`. Three healthy local heartbeats start draining and return ownership to `LOCAL_PRIMARY`. The controlled 30-minute outage is an acceptance test, not a takeover delay.

If the per-message cloud gateway is unavailable, the local durable inbox leaves the message retryable rather than marking it complete. DingTalk sends use a stable message UUID, while the Cloudflare `handoffId` prevents duplicate Qoder generation across process and network retries.

When the active local service cannot yet be switched to this isolated branch, install the independent macOS heartbeat sidecar with `./scripts/install-cloud-failover-heartbeat-sidecar.sh`. It reads only the metadata-only local `/api/status`, stores no local content, and signs a healthy heartbeat only when the process, AI runtime and DWS channel are all healthy. An unhealthy heartbeat does not move the coordinator's last-healthy boundary, so three intervals still trigger Railway. Remove the sidecar after the integrated heartbeat is deployed to the active local service; never run both as separate authorities long term.

For a bounded cloud-only acceptance window, run `./scripts/start-cloud-runtime-window.sh 3`. It schedules a one-shot macOS restore job before disabling both the active local message service and heartbeat sidecar. After the window, the existing local checkout is restarted unchanged, the sidecar resumes, and the normal three-heartbeat drain returns ownership to local. The Dashboard remains available during the window.

- Local remains primary for every request. A later request always starts local-first again.
- Only timeout, process exit, network transport failure, or empty output consumes a local retry.
- Three attempts share the original model-call timeout. Permission, confirmation, business validation, quality dissatisfaction and malformed business output do not fail over.
- Cloud accepts text-only L0/L1. Files, images, mail, documents, repository content, local memory, credentials, L2 and L3 fail closed.
- Whole-host takeover starts after three missed 30-second heartbeats. It remains active without a time limit while the Mac is offline.
- Three consecutive healthy heartbeats enter `DRAINING`; new cloud claims stop and in-flight replies finish before local primary resumes.
- Every cloud reply starts with `【云端兜底】`. L2/L3 receives a本人确认 handoff and performs no action.

## Prerequisites

- Cloudflare account with Workers and SQLite-backed Durable Objects. Cloudflare Containers are not used.
- Railway account and service. Use a plan that supports `Always` restart before describing the runtime as verified 7x24.
- Docker-compatible daemon for local container-image verification.
- Tool-free Qoder Cloud Agent and Environment. Qoder Cloud Agent is experimental; pin and re-test its API contract on every upgrade.
- Dedicated, revocable DingTalk OAuth authorization for cloud standby. DWS built-in device OAuth is the default; a self-created DingTalk app is optional. Do not export the configured local DWS Profile. Alibaba commands must carry the same registered digital-human Channel code used during device login.

## Secret names

Provision coordinator and Qoder values with `wrangler secret put`; never put values in `wrangler.jsonc`, `.dev.vars.example`, Git or logs:

```text
AIPROS_NODE_ID
AIPROS_HMAC_SECRET
AIPROS_CONTAINER_TOKEN
CLOUDFLARE_CONSOLE_PASSWORD
QODER_PAT
QODER_AGENT_ID
QODER_AGENT_VERSION
QODER_ENVIRONMENT_ID
```

Provision these as sealed Railway service variables. Read back names only, never values:

```text
DINGTALK_DWS_AUTH_BUNDLE_B64
AIPROS_CLOUD_DWS_CHANNEL
AIPROS_DWS_HOME
AIPROS_COORDINATOR_URL
AIPROS_CONTAINER_TOKEN
AIPROS_ALLOWED_CHAT_IDS
AIPROS_ALLOWED_SENDER_IDS
RAILWAY_RUN_UID
```

`DINGTALK_CLIENT_ID` and `DINGTALK_CLIENT_SECRET` are optional overrides for a self-created app. Omit both to use DWS built-in device OAuth; supplying only one fails closed.

The same local HMAC value must be stored in macOS Keychain under the configured service/account:

```zsh
security add-generic-password -U \
  -s james-cloud-failover -a hmac-secret -w '<random-32-byte-secret>'
```

## Independent cloud DWS authorization

Use a dedicated DWS state on an isolated operator session or machine. AppKey/AppSecret alone cannot log in as a person.

```zsh
dws auth login --device

dws auth status --format json

dws auth export --base64 > dws-auth.b64
```

Run these commands with DWS 1.0.56, `DWS_DISABLE_KEYCHAIN=1`, the registered digital-human `DWS_CHANNEL`, and an isolated `HOME`; the user completes one device authorization in DingTalk. Before export, verify that this state contains only the dedicated cloud authorization and is not the local production Profile. Store the base64 output as `DINGTALK_DWS_AUTH_BUNDLE_B64`, and place the same public routing code in `AIPROS_CLOUD_DWS_CHANNEL`, then securely delete the export file. The Railway runtime imports the bundle once with mode `0600` into the persistent `AIPROS_DWS_HOME`, injects that Channel only into DWS subprocesses, verifies a real `dws auth status`, and records a bootstrap marker. Later restarts use the persisted, rotated credential state and fail closed instead of re-importing the original bundle. Mount a Railway Volume at `/data` and set `RAILWAY_RUN_UID=0`, because Railway mounts volumes as root.

## Configure the Mac

Set these non-secret fields in `config.local.json`:

```json
{
  "cloudFailoverEnabled": true,
  "cloudFailoverBaseUrl": "https://failover.example.com",
  "cloudFailoverNodeId": "aipros-node-001",
  "cloudFailoverHeartbeatMs": 30000,
  "cloudFailoverMissThreshold": 3,
  "cloudFailoverRecoveryThreshold": 3,
  "cloudFailoverLocalAttempts": 3,
  "cloudFailoverMaxPromptChars": 24000,
  "cloudFailoverKeychainService": "james-cloud-failover",
  "cloudFailoverKeychainAccount": "hmac-secret"
}
```

## Cloud console

The Worker root path serves a metadata-only status page protected with HTTP Basic authentication. Configure the username with the non-secret `CLOUDFLARE_CONSOLE_USERNAME` Worker variable; store the password only as the `CLOUDFLARE_CONSOLE_PASSWORD` Worker secret and in an operator password manager or Keychain. The page shows coordinator state, generation, heartbeat age, Railway runtime readiness and in-flight count. It never renders messages, prompts, identities, credentials or Qoder output.

An unauthenticated request must return `401`; an authenticated request must return `200` with the title `AIPR0S Cloud Failover` before the console is considered published.

## Build and deploy

```zsh
pnpm install
npm run test:cloud-failover
npm run cloud-failover:dry

# Idempotently create or reuse the restricted Qoder Agent and Environment.
QODER_PAT='<read-from-secret-store>' node scripts/qoder-cloud-provision.mjs

cd cloud-failover/worker
pnpm exec wrangler secret put AIPROS_NODE_ID
# Repeat for each Cloudflare secret name above.
pnpm exec wrangler deploy

# From the repository root after Railway login and variable provisioning:
railway up --path-as-root cloud-failover/container --ci
```

`cloud-failover:dry` validates the Worker bundle without any Container Registry access. Railway detects `cloud-failover/container/Dockerfile` when that directory is deployed as the service root. The committed Railway configuration uses `/live`, zero deployment overlap, 30-second draining and the `ALWAYS` restart policy. Zero overlap is required because one dedicated DWS identity supports one active event consumer; generation fencing and the mention-only backfill cover the short replacement window. Deployment acceptance must read the policy back from Railway; if the account rejects it, retain `ON_FAILURE` and do not claim verified 7x24 operation.

## Acceptance before claiming 7x24

1. Enable the local config and restart AIPR0S. Confirm signed heartbeat status is `LOCAL_PRIMARY`.
2. Run `npm run cloud-failover:smoke`; require exactly `AIPR0S_CLOUD_OK`.
3. Send a harmless authorized DingTalk message and confirm the local reply has no cloud label.
4. Perform a controlled stop of the local service. After at least 90 seconds, confirm state `CLOUD_ACTIVE`.
5. Thirty minutes later, send a new harmless group message that @mentions the digital human. It must receive one reply with `【云端兜底】`; this proves the cloud path is not limited to the outage instant. Ordinary group messages without an @mention must receive no cloud reply.
6. Send an L2 request. It must return a本人确认 handoff and make no change.
7. Restart the Mac service. After three healthy heartbeats, confirm `DRAINING` then `LOCAL_PRIMARY`.
8. Confirm no duplicate cloud/local reply and verify the stable DWS UUID plus claim ledger.

Only after all eight checks have current evidence may the deployment be described as 7x24 verified.

## Rollback

Set `cloudFailoverEnabled` to `false` and restart the local service. Disable Railway lease activation, stop the Railway service, and revoke the dedicated DingTalk authorization and Railway coordinator token. Delete the Cloudflare Worker only if per-request Qoder fallback is also being retired. The local DWS Profile and local SQLite are never copied; the static Channel code is only reused as an Alibaba organization routing header.

## Retention and cost boundary

The Durable Object stores metadata, generations, digests, claims and bounded outcome codes only. It does not persist prompts or answers. Qoder receives cloud-eligible text; Session archive is lifecycle cleanup, not a cryptographic deletion guarantee. Set Cloudflare budget alerts and Qoder usage limits before activation.
