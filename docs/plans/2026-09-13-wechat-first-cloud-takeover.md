# WeChat-first Cloud Takeover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the existing Alibaba/Qoder cloud standby safely take over WeChat independently of DingTalk.

**Architecture:** Keep the Alibaba relay as the single durable ingress and send coordinator. Give WeChat its own fail-closed readiness gate and cloud event consumer, then wire production heartbeat, policy and send ledgers before enabling real takeover. DingTalk remains local-only.

**Tech Stack:** Node.js ESM, node:test, SQLite, GeWe HTTP API, Alibaba relay, Qoder Cloud Agent.

---

### Task 1: Independent WeChat readiness and standby

**Files:** `cloud-parity/readiness.mjs`, `cloud-parity/readiness.test.mjs`, `cloud-parity/standby.mjs`, `cloud-parity/standby.test.mjs`.

1. Add failing tests: a WeChat-scoped assessment is ready with `dingtalkIngress=false` and `dingtalkSend=false`, but rejects each missing WeChat capability, stale policy digest, or unacknowledged critical cursor. A WeChat standby constructor needs only a WeChat sender and rejects DingTalk events.
2. Run `node --test cloud-parity/readiness.test.mjs cloud-parity/standby.test.mjs`; require the new tests to fail first.
3. Make `evaluateCloudReadiness(input, { channels: ['wechat'] })` require common capabilities plus the requested channel capabilities. Keep the default two-channel gate unchanged for compatibility. Let `CloudStandby` accept explicit enabled channels; validate the sender for each enabled channel and reject all others before claiming.
4. Rerun focused tests and commit.

### Task 2: Production parity and main heartbeat

**Files:** `src/index.mjs`, `src/config.mjs`, `src/aliyun-control-client.mjs`, `src/aliyun-control-client.test.mjs`, `cloud-relay/aliyun/server.mjs`, `cloud-relay/aliyun/store.mjs`.

1. Test that only the real main process sends a monotonically sequenced heartbeat with policy digest, critical-state cursor and WeChat readiness; a stale, rejected or mismatched heartbeat cannot authorize promotion.
2. Wire the authenticated production control client and encrypted policy snapshot acknowledgement. Do not use a sidecar health ping as policy readiness.
3. Require the coordinator to bind readiness to its stored main heartbeat and acknowledged policy/cursor, never caller-supplied values.
4. Run focused tests and commit. Keep all secrets out of logs and Git.

### Task 3: Single fenced WeChat sender and cloud worker

**Files:** `cloud-relay/aliyun/server.mjs`, `cloud-relay/aliyun/store.mjs`, `cloud-parity/channel-send.mjs`, `cloud-parity/standby.mjs`, new `cloud-parity/wechat-worker.mjs` and tests.

1. Test duplicate callbacks, lease generation changes between reasoning and send, missing GeWe message ID, ambiguous provider result, human takeover and quoted/group mentions.
2. Add a server-side send authority that rechecks generation and policy at send time. Ensure local and cloud automated sends use the same one-shot intent ledger. Never automatically retry an ambiguous provider send.
3. Launch the WeChat-only standby in receive/shadow mode, consuming the Alibaba queue and the existing Qoder Agent only while a valid cloud generation is active.
4. Run focused tests and commit.

### Task 4: Staged deployment and live acceptance

**Files:** `cloud-relay/aliyun/README.md`, `outputs/cloud-parity-acceptance-2026-09-13.md`, deployment configuration and scripts.

1. Verify server credentials by name/presence only, the actual GeWe send response schema, encrypted state parity, main heartbeat, queue and provider receipt readback. Do not expose tokens or message content.
2. Deploy cloud worker with sending disabled, replay harmless fixtures, and compare decisions with the local worker.
3. Send a real harmless WeChat test under cloud authority and verify exactly one provider-confirmed receipt. Then perform a controlled Mac stop, late-arriving WeChat message, and duplicate-free handback.
4. Record counts, timestamps and any GeWe history gap as **未查全**. Enable automatic WeChat promotion only after every WeChat gate passes. Do not wait for DingTalk, and do not claim full 7×24 history coverage.
