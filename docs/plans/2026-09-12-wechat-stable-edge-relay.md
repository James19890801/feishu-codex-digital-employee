# WeChat Stable Edge Relay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the rotating Quick Tunnel callback with a fixed Cloudflare Worker endpoint that durably buffers inbound WeChat events and serves short-lived outbound artifacts.

**Architecture:** A Worker backed by one Durable Object namespace owns the inbound lease/ACK queue and an R2 bucket stores expiring artifacts. A macOS LaunchAgent polls the Worker over outbound HTTPS and replays each event into the existing loopback webhook; a Node import bootstrap uploads registered artifacts to R2. The existing Named Tunnel runs independently over HTTP/2 and can reconnect without changing configuration or restarting the main service.

**Tech Stack:** Node.js ESM, built-in `node:test`, Cloudflare Workers, Durable Objects, R2, Wrangler, macOS launchd, SQLite production state.

---

### Task 1: Edge relay contract

**Files:**
- Create: `cloud-relay/worker/src/contract.mjs`
- Create: `cloud-relay/worker/src/contract.test.mjs`

**Step 1:** Write failing tests for callback path validation, request limits, event digesting, bearer authentication, lease responses, ACK validation, artifact paths and signed canary responses.

**Step 2:** Run `node --test cloud-relay/worker/src/contract.test.mjs`; expect failures for missing exports.

**Step 3:** Implement the pure validation and response helpers without logging payload content.

**Step 4:** Run the focused tests; expect all to pass.

### Task 2: Durable Worker and R2 artifact service

**Files:**
- Create: `cloud-relay/worker/src/index.mjs`
- Create: `cloud-relay/worker/src/index.test.mjs`
- Create: `cloud-relay/worker/wrangler.jsonc`
- Create: `cloud-relay/worker/package.json`

**Step 1:** Write failing route tests with stubbed Durable Object and R2 bindings.

**Step 2:** Implement callback enqueue, authenticated lease/ACK/status, artifact PUT/GET, health and signed canary routes.

**Step 3:** Implement Durable Object storage records with digest deduplication, lease expiry and bounded retention.

**Step 4:** Run focused tests and `npx wrangler deploy --dry-run`; expect success.

### Task 3: Local relay agent

**Files:**
- Create: `scripts/wechat-edge-relay-agent.mjs`
- Create: `scripts/wechat-edge-relay-agent.test.mjs`

**Step 1:** Write failing tests for lease delivery, ACK-after-local-202, no ACK on failure, bounded exponential backoff and clean shutdown.

**Step 2:** Implement an outbound-only polling loop using the relay token from Keychain.

**Step 3:** Run focused tests; expect all to pass.

### Task 4: Fixed artifact upload bootstrap

**Files:**
- Create: `src/wechat-edge-artifact-bootstrap.mjs`
- Create: `src/wechat-edge-artifact-bootstrap.test.mjs`

**Step 1:** Write failing tests proving regular-file validation, size limits, authenticated upload and compatible artifact route output.

**Step 2:** Patch `GeWeWebhookServer.prototype.registerArtifact` at process bootstrap while retaining the original implementation as an explicit fallback only outside relay mode.

**Step 3:** Run focused tests; expect all to pass.

### Task 5: Cloud resources and credentials

**Files:**
- Modify: `cloud-relay/worker/wrangler.jsonc`

**Step 1:** Create the Durable Object namespace/migration and R2 bucket through Wrangler.

**Step 2:** Generate separate relay and artifact tokens, store local copies in macOS Keychain and remote copies as Worker Secrets.

**Step 3:** Deploy the Worker and record the generated `workers.dev` origin without storing secrets.

**Step 4:** Probe health, authentication rejection and signed canary behavior.

### Task 6: Production cutover

**Files:**
- Modify: `~/Library/Application Support/AIPRO/config/config.local.json`
- Modify: `~/Library/LaunchAgents/com.local.aipro-main.plist`
- Modify: `~/Library/LaunchAgents/com.local.aipro-cloudflare-tunnel.plist`
- Create: `~/Library/LaunchAgents/com.local.aipro-wechat-edge-relay.plist`

**Step 1:** Back up the production config and affected LaunchAgents.

**Step 2:** Set the fixed Worker origin, install the artifact bootstrap and relay LaunchAgent, and switch the tunnel service to the Named Tunnel supervisor with HTTP/2.

**Step 3:** Restart only the services whose definitions changed; confirm the main PID remains stable during an independent tunnel restart.

**Step 4:** Align the GeWe provider callback to the fixed URL and verify its registration.

### Task 7: Failure and recovery verification

**Files:**
- Create: `outputs/wechat-edge-relay-cutover-2026-09-12.json`

**Step 1:** Pause the local relay agent, submit a synthetic schema-valid webhook to the fixed callback, and verify cloud backlog increases.

**Step 2:** Resume the agent and verify the message is delivered once and ACKed without generating an outbound reply.

**Step 3:** Restart the Named Tunnel and verify callback URL and main PID remain unchanged.

**Step 4:** Run production health checks and capture redacted evidence.

**Step 5:** Reconcile WeChat and DingTalk inbound ledgers over the recovery overlap window, explicitly retaining known history-coverage gaps.

**Step 6:** Commit only the relay source, tests and documentation; do not stage unrelated dirty-worktree changes.

