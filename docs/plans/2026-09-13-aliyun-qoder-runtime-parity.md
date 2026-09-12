# Alibaba Cloud / Qoder Runtime Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the existing Hong Kong relay the always-on authority for WeChat/DingTalk ingress, policy state, and outbound receipts, with the local Mac as preferred worker and Qoder as verified cloud reasoning fallback.

**Architecture:** Extend the isolated Node 22/SQLite WAL relay in `cloud-relay/aliyun` with a versioned policy store, fenced worker lease, and idempotent outbox. Keep the local application code as the source of policy decisions, export a narrowly allowlisted snapshot and change deltas, and use a cloud standby that invokes Qoder Managed Sessions. Do not enable cloud replies until a controlled two-channel cutover test passes.

**Tech Stack:** Node.js 22 `node:sqlite`, built-in test runner, existing GeWe relay, DingTalk DWS CLI, Qoder Cloud Agents CN REST/SSE, systemd/Nginx, macOS LaunchAgent/Keychain.

---

## Phase A — safe data and control foundations

### Task 1: Inventory parity state and create an export allowlist

**Files:** Create `src/cloud-parity-manifest.mjs`, `src/cloud-parity-manifest.test.mjs`; inspect `src/config-store.mjs`, `src/human-takeover.mjs`, `src/conversation-history.mjs`, and all production `src/index.mjs` state writers.

1. Write failing tests for inclusion of `persona`, `bible`, inbound/outbound trigger rules, explicit allow/deny lists, human-takeover records, relation memories, pending owner decisions, and send receipts. Assert exclusion of passwords, access tokens, OAuth profiles, absolute local paths, unrelated backup DBs, and arbitrary directories.
2. Run `node --test src/cloud-parity-manifest.test.mjs`; expect failure because the exporter does not exist.
3. Implement `buildParityManifest({ config, persona, bible, state })` with explicit keys, stable JSON ordering, version, SHA-256 digest, per-section digest and byte count. Reject unknown/oversized data rather than copying it. Tests should use synthetic data, never production secrets.
4. Re-run the focused test; expect pass. Commit only these two files.

### Task 2: Store versioned policy snapshots on Alibaba

**Files:** Modify `cloud-relay/aliyun/store.mjs`; create `cloud-relay/aliyun/policy-store.test.mjs`.

1. Write failing tests for one current encrypted policy bundle, immutable version history, monotonically increasing sequence, SHA-256 verification, stale/duplicate update rejection, and rollback to the last validated version. Simulate concurrent writers and database reopen.
2. Run `node --test cloud-relay/aliyun/policy-store.test.mjs`; expect failure.
3. Add `policy_versions(version INTEGER PRIMARY KEY, digest TEXT, ciphertext BLOB, applied_at INTEGER, source TEXT)` and `policy_cursor(worker_id TEXT PRIMARY KEY, sequence INTEGER, digest TEXT)` in the relay's existing SQLite transaction. Encryption is AES-256-GCM with a dedicated key provided via a 0600 environment file; never derive it from the public callback URL or log it. Keep the existing `/relay/*` semantics unchanged.
4. Run focused and existing relay tests; expect pass. Commit.

### Task 3: Authenticated sync API and daily full reconciliation

**Files:** Modify `cloud-relay/aliyun/server.mjs`, `cloud-relay/aliyun/server.test.mjs`; create `src/cloud-parity-sync.mjs`, `src/cloud-parity-sync.test.mjs`, `src/cloud-parity-collector.mjs`, `src/cloud-parity-collector.test.mjs`, `scripts/cloud-parity-sync.mjs`, `scripts/install-cloud-parity-sync.sh` and their tests (use the existing LaunchAgent convention).

1. Test bearer/HMAC auth, request body limit, missing-key fail-closed, hash mismatch, duplicate sequence, and metadata-only status. Test a daily full comparison that uploads only changed sections and independently flags cloud drift; test immediate delta propagation for deny/human-takeover/approval changes.
2. Run the two focused tests; expect failure.
3. Implement `PUT /parity/snapshot`, `POST /parity/delta`, `GET /parity/status` under a dedicated token (not the GeWe callback secret), with explicit schema and ciphertext-only persistence. The local client reads the current allowlisted state, uses a local Keychain secret, and records last successful sequence; the daily LaunchAgent schedules one full reconciliation, while critical mutations await delta acknowledgement before confirming completion.
4. Run focused tests and the existing 16 relay tests; expect pass. Commit. Stage the endpoint without the schedule or cloud reply switch enabled.

### Task 4: Fenced worker lease and durable outbox

**Files:** Modify `cloud-relay/aliyun/store.mjs`, `cloud-relay/aliyun/server.mjs`; create `cloud-relay/aliyun/leadership.test.mjs`, `cloud-relay/aliyun/outbox.test.mjs`.

1. Test 89-second primary grace, configurable takeover threshold, one generation per transition, stale generation rejection, duplicate webhook claim, lost send acknowledgement, crash/reopen, cloud drain, and three healthy recovery heartbeats.
2. Run focused tests; expect failure.
3. Add transactional `leadership`, `claims`, `outbox`, and `send_receipts` tables. Derive idempotency keys from `(channel, provider_message_id, action_kind)`. Expose signed heartbeat, lease, claim, prepare-send, record-receipt, and status endpoints. Recheck generation and current deny/human-takeover policy immediately before provider send; never retry ambiguous sends without reconciliation.
4. Run focused and relay regression tests; expect pass. Commit.

## Phase B — full cloud worker and channels

### Task 5: Qoder Managed runtime adapter

**Files:** Create `src/qoder-managed-runtime.mjs`, `src/qoder-managed-runtime.test.mjs`; consult `cloud-failover/worker/src/qoder-client.mjs` without copying its Cloudflare secret assumptions.

1. Test Session create with the user-supplied Agent/Environment IDs, `user.message`, SSE `Last-Event-ID` resume, final response extraction, timeouts/429/5xx, 4xx fail-closed, archive, and a `requires_action` custom-tool round trip with strict policy authorization. Assert no channel credential, whole DB, or unrelated memory enters the request.
2. Run focused test; expect failure.
3. Implement a `QoderManagedRuntime` with injected `fetch`, PAT supplier, input policy, and redacted audit. The CN base URL is `https://api.qoder.com.cn/api/v1/cloud`; do not use Qoder Deployments as the inbound service. Pin an Agent version after configuring its persona and minimal tool set.
4. Run focused test; expect pass. Commit.

### Task 6: Cloud standby application using the same policy modules

**Files:** Create `cloud-parity/standby.mjs`, `cloud-parity/standby.test.mjs`, `cloud-parity/aipro-cloud-parity.service`, `cloud-parity/README.md`; modify shared policy modules only through adapter seams with tests.

1. Test cloud worker refuses activation for missing policy version, Qoder failure, absent channel credential, or stale generation. Test native/text @, 小詹 mention, quoted follow-up, allow/deny, human takeover, pending owner confirmation, and no fabricated success for unsupported desktop/Multica operations.
2. Run focused test; expect failure.
3. Instantiate the existing channel-normalization and reply-policy modules under Linux. Read the verified bundle from Alibaba store, call Qoder only for authorized reasoning, enqueue outbound intents through the fenced outbox, and record a capability parity matrix in status. Keep all other websites and processes on the host untouched.
4. Run focused and package tests; expect pass. Commit.

### Task 7: Always-on DingTalk ingress and central outbound adapters

**Files:** Create `cloud-parity/dingtalk-ingress.mjs`, `cloud-parity/channel-send.mjs` and corresponding tests; adapt `src/im-channel-runtime.mjs`, `src/index.mjs` behind feature flags; preserve existing WeChat relay paths.

1. Test independent DWS login/status, receive-only duplicate stream behavior, normalized message IDs, restart overlap and disconnected intervals. Test real send receipt capture for both channels and the prevention of two sends from concurrent local/cloud intents.
2. Run focused tests; expect failure.
3. Provision independent DWS auth in an isolated server profile (never copy the local profile). Start the cloud DingTalk listener continuously, even while local leads. Route both channel receipts through the coordinator. Enable local consumption from the central inbox only after a shadow comparison with direct local events shows no missing message classes.
4. Run focused/regression tests; expect pass. Commit. If DWS cannot authenticate or duplicate streams cannot be reconciled, stop rollout and report DingTalk coverage as incomplete.

## Phase C — rollout and proof

### Task 8: Security, migration, and live Qoder smoke

**Files:** Modify `cloud-relay/aliyun/deploy.sh`, `cloud-relay/aliyun/backup.sh`, `cloud-relay/aliyun/monitor.sh`; create `scripts/cloud-parity-smoke.mjs`, tests and a redacted runbook.

1. Add tests for secret-free distribution, 0600 credential files, encrypted backup restore, disk/RAM alarms, no new open inbound ports, and rollback to the existing Mac/WeChat relay path.
2. Deploy into separate systemd units on Alibaba; do not overwrite the current relay or the other site. Verify Qoder Agent version/environment with a harmless response before enabling production.
3. Run `node --test cloud-relay/aliyun/*.test.mjs src/cloud-parity-*.test.mjs src/qoder-managed-runtime.test.mjs cloud-parity/*.test.mjs` and root `npm test`/`npm run check`; expect all pass or document pre-existing failures separately.
4. Commit the deployment/runbook changes and record the exact versions deployed.

### Task 9: Chaos test and acceptance ledger

**Files:** Create `outputs/cloud-parity-acceptance-2026-09-13.md`; keep secrets and raw messages out of it.

1. Test a synthetic duplicate event and a harmless real WeChat/DingTalk message while local leads; require one send receipt each and current policy digests equal on both sides.
2. Stop only the local production worker under a timed recovery plan; confirm heartbeat expiry, cloud lease generation, actual Qoder reply and provider receipt in both original conversations. Leave the local Mac itself on so rollback is possible.
3. Test denial/human takeover, quote/@ trigger, Qoder failure, standby restart, and repeated callbacks. Require no unauthorized send and no duplicate reply.
4. Restart local worker, wait for three healthy heartbeats and cloud drain, send another harmless message, and prove the new local generation owns it. Reconcile inbox/outbox against receipts; classify historical coverage gaps explicitly as `not fully checked` where provider history is unavailable.
5. Enable daily full sync only after a successful manual run; observe the next scheduled run and report its last success timestamp and matching digest. Do not claim 7x24 parity until all enabled capabilities pass.

## Execution discipline

Work only in `codex/cloud-runtime-parity` in the existing clean isolated worktree. The main checkout has unrelated uncommitted user work; do not merge, reset, or overwrite it. Each task is gated by a failing test and a focused passing test, then a commit. Keep the old relay running as rollback until the final acceptance ledger is green. User-provided Qoder identifiers and credentials belong in protected runtime configuration, not this plan, source, shell logs, or Git.
