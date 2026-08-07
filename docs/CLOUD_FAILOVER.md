# AIPR0S Cloud Failover Runbook

## Current delivery state

| Layer | State | Evidence |
|---|---|---|
| Local runtime fallback | Implemented and locally tested | Three bounded local attempts, deny-first policy, signed Cloudflare request |
| Whole-Mac coordinator | Implemented and locally tested | 30s heartbeat, 90s takeover, generation fencing, claims, three-heartbeat drain |
| Qoder adapter | Implemented against the experimental Cloud Agent contract | Tool-free Session, one user event, SSE idle terminal, archive, 429/5xx retry |
| Standby DWS container | Implemented; Worker bundle dry-run verified | Independent auth import, auth-status gate, 3-minute backfill, event stream, UUID send |
| Container image build | Not verified on this Mac | Docker daemon is not available |
| Live Cloudflare/Qoder/DingTalk | Not activated | Requires explicit provisioning and secrets |
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

- Cloudflare account with Workers, SQLite-backed Durable Objects and Containers available. Containers require a paid Workers plan.
- Docker-compatible daemon for the first container-image build.
- Tool-free Qoder Cloud Agent and Environment. Qoder Cloud Agent is experimental; pin and re-test its API contract on every upgrade.
- Dedicated, revocable DingTalk OAuth authorization for cloud standby. Do not export the configured local DWS Profile/Channel.

## Secret names

Provision these with `wrangler secret put`; never put values in `wrangler.jsonc`, `.dev.vars.example`, Git or logs:

```text
AIPROS_NODE_ID
AIPROS_HMAC_SECRET
AIPROS_CONTAINER_TOKEN
AIPROS_INTERNAL_COORDINATOR_URL
AIPROS_ALLOWED_CHAT_IDS
AIPROS_ALLOWED_SENDER_IDS
QODER_PAT
QODER_AGENT_ID
QODER_AGENT_VERSION
QODER_ENVIRONMENT_ID
DINGTALK_CLIENT_ID
DINGTALK_CLIENT_SECRET
DINGTALK_DWS_AUTH_BUNDLE_B64
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

Before export, verify that this state contains only the dedicated cloud authorization and is not the local production Profile. Store the base64 output as `DINGTALK_DWS_AUTH_BUNDLE_B64`, then securely delete the export file. The container imports it into ephemeral storage with mode `0600`, runs a real `dws auth status`, and removes the import file.

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

## Build and deploy

```zsh
pnpm install
npm run test:cloud-failover
npm run cloud-failover:dry

cd cloud-failover/worker
pnpm exec wrangler secret put AIPROS_NODE_ID
# Repeat for every secret name above.
pnpm exec wrangler deploy
```

`cloud-failover:dry` validates the Worker bundle without rolling out the container. A real deploy must build the pinned `linux/amd64` image from `cloud-failover/container/Dockerfile`.

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

Set `cloudFailoverEnabled` to `false` and restart the local service. Then stop or delete the Cloudflare Worker/Container and revoke the dedicated DingTalk authorization, Qoder PAT, container token and HMAC secret. Local DWS Profile/Channel and local SQLite are unaffected because neither is copied into the cloud deployment.

## Retention and cost boundary

The Durable Object stores metadata, generations, digests, claims and bounded outcome codes only. It does not persist prompts or answers. Qoder receives cloud-eligible text; Session archive is lifecycle cleanup, not a cryptographic deletion guarantee. Set Cloudflare budget alerts and Qoder usage limits before activation.
