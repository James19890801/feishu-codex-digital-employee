# AIPR0S Cloud Failover Runbook

## Current delivery state

| Layer | State | Evidence |
|---|---|---|
| Local runtime fallback | Implemented and locally tested | Three bounded local attempts, deny-first policy, signed Cloudflare request |
| Whole-Mac coordinator | Implemented and locally tested | 30s heartbeat, 90s takeover, generation fencing, claims, three-heartbeat drain |
| Qoder adapter | Live provisioned and smoke-tested on 2026-08-07 | Tool-free Agent/Environment, Session, content-block event, SSE idle terminal, archive, 429/5xx retry |
| Railway standby DWS runtime | Implemented and locally tested | Always-warm event stream, independent auth import, 10s coordinator lease, 3-minute backfill, generation fencing and UUID send |
| Railway image build | Locally verified | Pinned `linux/amd64` Node image and DWS CLI layer build successfully; Cloudflare Container Registry is no longer required |
| Live Cloudflare/Qoder | Activated and smoke-tested on 2026-08-07 | Signed heartbeat and exact `AIPR0S_CLOUD_OK` response passed; metadata-only console published |
| Live Railway DingTalk | Not activated | Requires Railway login/deploy plus dedicated cloud OAuth and DWS auth bundle; local Profile/Channel was not copied |
| 7x24 availability | Not yet verified | Requires the controlled stop/reply/recovery acceptance below |

## Runtime contract

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
- Dedicated, revocable DingTalk OAuth authorization for cloud standby. Do not export the configured local DWS Profile/Channel.

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
DINGTALK_CLIENT_ID
DINGTALK_CLIENT_SECRET
DINGTALK_DWS_AUTH_BUNDLE_B64
AIPROS_DWS_HOME
AIPROS_COORDINATOR_URL
AIPROS_CONTAINER_TOKEN
AIPROS_ALLOWED_CHAT_IDS
AIPROS_ALLOWED_SENDER_IDS
RAILWAY_RUN_UID
```

The same local HMAC value must be stored in macOS Keychain under the configured service/account:

```zsh
security add-generic-password -U \
  -s james-cloud-failover -a hmac-secret -w '<random-32-byte-secret>'
```

## Independent cloud DWS authorization

Use a dedicated DWS state on an isolated operator session or machine. AppKey/AppSecret alone cannot log in as a person.

```zsh
dws auth login --device \
  --client-id '<cloud-app-key>' \
  --client-secret '<cloud-app-secret>'

dws auth status --format json \
  --client-id '<cloud-app-key>' \
  --client-secret '<cloud-app-secret>'

dws auth export --base64 > dws-auth.b64
```

Before export, verify that this state contains only the dedicated cloud authorization and is not the local production Profile. Store the base64 output as `DINGTALK_DWS_AUTH_BUNDLE_B64`, then securely delete the export file. The Railway runtime imports it once with mode `0600` into the persistent `AIPROS_DWS_HOME`, verifies a real `dws auth status`, and records a bootstrap marker. Later restarts use the persisted, rotated credential state and fail closed instead of re-importing the original bundle. Mount a Railway Volume at `/data` and set `RAILWAY_RUN_UID=0`, because Railway mounts volumes as root.

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

`cloud-failover:dry` validates the Worker bundle without any Container Registry access. Railway detects `cloud-failover/container/Dockerfile` when that directory is deployed as the service root. The committed Railway configuration uses `/live`, 30-second draining and the portable `ON_FAILURE` ten-retry policy. Change it to `ALWAYS` only after the Railway account confirms that policy is available.

## Acceptance before claiming 7x24

1. Enable the local config and restart AIPR0S. Confirm signed heartbeat status is `LOCAL_PRIMARY`.
2. Run `npm run cloud-failover:smoke`; require exactly `AIPR0S_CLOUD_OK`.
3. Send a harmless authorized DingTalk message and confirm the local reply has no cloud label.
4. Perform a controlled stop of the local service. After at least 90 seconds, confirm state `CLOUD_ACTIVE`.
5. Thirty minutes later, send a new harmless message. It must receive one reply with `【云端兜底】`; this proves the cloud path is not limited to the outage instant.
6. Send an L2 request. It must return a本人确认 handoff and make no change.
7. Restart the Mac service. After three healthy heartbeats, confirm `DRAINING` then `LOCAL_PRIMARY`.
8. Confirm no duplicate cloud/local reply and verify the stable DWS UUID plus claim ledger.

Only after all eight checks have current evidence may the deployment be described as 7x24 verified.

## Rollback

Set `cloudFailoverEnabled` to `false` and restart the local service. Disable Railway lease activation, stop the Railway service, and revoke the dedicated DingTalk authorization and Railway coordinator token. Delete the Cloudflare Worker only if per-request Qoder fallback is also being retired. Local DWS Profile/Channel and local SQLite are unaffected because neither is copied into the cloud deployment.

## Retention and cost boundary

The Durable Object stores metadata, generations, digests, claims and bounded outcome codes only. It does not persist prompts or answers. Qoder receives cloud-eligible text; Session archive is lifecycle cleanup, not a cryptographic deletion guarantee. Set Cloudflare budget alerts and Qoder usage limits before activation.
