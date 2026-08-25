# Online-first Blacklist Cloud Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore blacklist-mode DingTalk replies on the Mac and deliver a tested, deployed whole-host cloud takeover that preserves AI-Lab `online-first`, existing blocklist identities, message continuity, fencing and terminal delivery proof.

**Architecture:** Build on the existing Cloudflare/Railway failover branch inside an isolated integration worktree, then migrate the live checkout's AI-Lab router by test-first semantic integration. The Mac and Railway share blacklist semantics; Railway maintains an encrypted, bounded standby journal so messages received during the heartbeat decision window can be replayed exactly once after generation activation.

**Tech Stack:** Node.js ESM, built-in `node:test`/assert style scripts, SQLite, AES-256-GCM/HKDF, DingTalk DWS 1.0.56, Cloudflare Workers and Durable Objects, Railway, Qoder Cloud Agent, macOS LaunchAgent.

**Spec:** `docs/superpowers/specs/2026-08-25-online-first-blacklist-cloud-takeover-design.md`

## Global Constraints

- Local AI routing is `online-first`: AI-Lab pre-production primary and local Codex fallback only for retryable runtime failures.
- Local and cloud access mode is blacklist; the current four DingTalk blocklist entries remain the canonical authority.
- Direct messages are eligible unless blocked; group replies still require an explicit assistant mention.
- Heartbeat interval is 30 seconds; takeover and recovery thresholds are three healthy/missed intervals.
- Standby retention is at most three minutes and 100 encrypted rows.
- L2/L3 performs no mutation and returns only a human-confirmation handoff.
- Independent DWS binary/profile/channel boundaries remain unchanged; no Wukong fallback.
- No credential, Channel, Profile, DingTalk identity, message body or private configuration may enter Git, stdout or command arguments.
- The dirty primary checkout must not be reset, cleaned or overwritten.

---

### Task 1: Integrate the existing failover implementation without losing active-branch behavior

**Files:**
- Merge source: branch `codex/qoder-cloud-offline-failover`
- Resolve: `src/index.mjs`
- Resolve: `src/config.mjs`
- Resolve: `src/state.mjs`
- Resolve: `src/dashboard-model.mjs`
- Resolve: `src/dashboard-server.mjs`
- Resolve: `scripts/health-check.mjs`
- Resolve: `package.json`
- Resolve: `config.example.json`
- Resolve: `config.distribution.json`

**Interfaces:**
- Consumes: active branch at `d455f8389445a82a18290973ad2ecb43aff4644e` and cloud branch at `d56282f55cb837f0be63e8fb25e777c7c04c1a27`.
- Produces: one integration tree containing Cloudflare Worker, Railway container, `CloudFailoverClient`, `FailoverHeartbeat`, local-first retry routing and all active DingTalk takeover/retry behavior.

- [ ] **Step 1: Record the two branch tips and merge base**

Run:

```bash
git rev-parse HEAD codex/qoder-cloud-offline-failover
git merge-base HEAD codex/qoder-cloud-offline-failover
```

Expected: active tip `02d6411...` or its descendant, cloud tip `d56282f...`, and merge base `c356bb9...`.

- [ ] **Step 2: Merge without committing**

Run:

```bash
git merge --no-ff --no-commit codex/qoder-cloud-offline-failover
```

Expected: cloud-only files are added and overlapping active files are reported for semantic resolution.

- [ ] **Step 3: Resolve conflicts by preserving both contracts**

For every conflict, retain the active branch's durable inbox, response obligations, human takeover, stable-response and cross-org safety code, then add the cloud branch's client, heartbeat, state, Dashboard and scripts. Remove all conflict markers and run:

```bash
rg -n '^(<<<<<<<|=======|>>>>>>>)' . --glob '!node_modules/**'
git diff --check
```

Expected: no conflict markers and no whitespace errors.

- [ ] **Step 4: Run the pre-existing failover and active-branch tests**

Run:

```bash
npm run test:cloud-failover
npm test
```

Expected: both commands exit 0. Fix merge-resolution regressions without adding new behavior.

- [ ] **Step 5: Commit the integration baseline**

```bash
git add cloud-failover src scripts dashboard docs package.json pnpm-lock.yaml pnpm-workspace.yaml config.example.json config.distribution.json README.md
git commit -m "merge: integrate cloud failover baseline"
```

### Task 2: Migrate AI-Lab online-first routing into the integration tree

**Files:**
- Create: `src/ai-lab-runtime.mjs`
- Create: `src/ai-lab-runtime.test.mjs`
- Create: `src/online-first-runtime-router.mjs`
- Create: `src/online-first-runtime-router.test.mjs`
- Create: `scripts/configure-ai-lab-runtime.mjs`
- Create: `scripts/configure-ai-lab-runtime.test.mjs`
- Modify: `src/ai-runtime.mjs`
- Modify: `src/ai-runtime.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/index.mjs`
- Modify: `scripts/runtime-smoke.mjs`
- Modify: `scripts/health-check.mjs`
- Modify: `package.json`
- Modify: `config.example.json`
- Modify: `config.distribution.json`

**Interfaces:**
- Consumes: `AiRuntimeClient`, `LocalFirstRuntimeRouter` and cloud handoff from Task 1.
- Produces: `OnlineFirstRuntimeRouter.run(input)` and runtime detection for `ai-lab`, with a retryable error contract consumed by local-first/cloud fallback.

- [ ] **Step 1: Add the online-first and AI-Lab tests before production files**

Port the current checkout's test cases only. The key observable assertions are:

```js
assert.equal(selectAiRuntime(runtimes, 'online-first').id, 'ai-lab');
assert.equal(result.runtime.id, 'codex');
assert.equal(result.fallback.from, 'ai-lab');
assert.equal(result.fallback.to, 'codex');
assert.equal(result.fallback.reasonCode, 'network_error');
```

- [ ] **Step 2: Verify RED**

Run:

```bash
node src/ai-lab-runtime.test.mjs
node src/online-first-runtime-router.test.mjs
node scripts/configure-ai-lab-runtime.test.mjs
```

Expected: fail because the AI-Lab runtime and online-first router modules do not exist in the integration branch.

- [ ] **Step 3: Port the minimal production implementation**

Migrate the root checkout's AI-Lab runtime and online-first router semantically. Preserve the integrated cloud router outside it so the nesting is:

```text
LocalFirstRuntimeRouter(
  OnlineFirstRuntimeRouter(AI-Lab primary, Codex local fallback),
  CloudFailoverClient final retryable fallback
)
```

The AI-Lab credential remains in mode-0600 private configuration and is never committed.

- [ ] **Step 4: Verify GREEN and regression safety**

Run:

```bash
node src/ai-lab-runtime.test.mjs
node src/online-first-runtime-router.test.mjs
node scripts/configure-ai-lab-runtime.test.mjs
node src/ai-runtime.test.mjs
npm run test:cloud-failover
```

Expected: all commands exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/ai-lab-runtime.mjs src/ai-lab-runtime.test.mjs src/online-first-runtime-router.mjs src/online-first-runtime-router.test.mjs scripts/configure-ai-lab-runtime.mjs scripts/configure-ai-lab-runtime.test.mjs src/ai-runtime.mjs src/ai-runtime.test.mjs src/config.mjs src/index.mjs scripts/runtime-smoke.mjs scripts/health-check.mjs package.json config.example.json config.distribution.json
git commit -m "feat: combine online-first AI-Lab with cloud fallback"
```

### Task 3: Create a private canonical blacklist projection for Railway

**Files:**
- Create: `src/cloud-blacklist-projection.mjs`
- Create: `src/cloud-blacklist-projection.test.mjs`
- Create: `scripts/render-cloud-blacklist-bundle.mjs`
- Create: `scripts/render-cloud-blacklist-bundle.test.mjs`
- Modify: `package.json`
- Modify: `docs/CLOUD_FAILOVER.md`

**Interfaces:**
- Consumes: normalized entries from `normalizeCommunicationBlocklist(entries)`.
- Produces: `projectDingTalkCloudBlacklist(entries) -> { senderIds: string[], chatIds: string[], digest: string }` and a mode-0600 private JSON bundle.

- [ ] **Step 1: Write projection tests**

The production mutation caught by these tests is dropping an `openId`, `userId` or normalized `ids[]` value when syncing the local authority to Railway.

```js
const result = projectDingTalkCloudBlacklist([
  { channel: 'dingtalk', displayName: 'A', ids: ['open-a', 'staff-a'] },
  { channel: 'feishu', displayName: 'B', ids: ['ignored'] },
  { channel: 'dingtalk', displayName: 'C', ids: ['staff-a', 'open-c'] },
]);
assert.deepEqual(result.senderIds, ['open-a', 'open-c', 'staff-a']);
assert.deepEqual(result.chatIds, []);
assert.match(result.digest, /^[a-f0-9]{64}$/);
```

Also run the render script against a temporary private config and assert file mode `0600`, exact count, stable digest, and no identity values on stdout.

- [ ] **Step 2: Verify RED**

Run:

```bash
node src/cloud-blacklist-projection.test.mjs
node scripts/render-cloud-blacklist-bundle.test.mjs
```

Expected: fail because the projection and render modules do not exist.

- [ ] **Step 3: Implement projection and private rendering**

Implement deterministic sorting/deduplication. The private bundle has this shape:

```json
{
  "AIPROS_ACCESS_MODE": "blacklist",
  "AIPROS_BLOCKED_SENDER_IDS": "comma-separated-private-values",
  "AIPROS_BLOCKED_CHAT_IDS": "",
  "count": 4,
  "digest": "sha256-over-sorted-identities"
}
```

The script prints only `{ "ok": true, "count": 4, "digest": "..." }` and writes the private values only to the requested mode-0600 output path.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
node src/cloud-blacklist-projection.test.mjs
node scripts/render-cloud-blacklist-bundle.test.mjs
```

Expected: both exit 0 and captured stdout contains no fixture identity.

- [ ] **Step 5: Commit**

```bash
git add src/cloud-blacklist-projection.mjs src/cloud-blacklist-projection.test.mjs scripts/render-cloud-blacklist-bundle.mjs scripts/render-cloud-blacklist-bundle.test.mjs package.json docs/CLOUD_FAILOVER.md
git commit -m "feat: project local blacklist into cloud policy"
```

### Task 4: Route Railway replies correctly for direct and group chats

**Files:**
- Modify: `cloud-failover/container/src/worker.mjs`
- Modify: `cloud-failover/container/src/worker.test.mjs`
- Modify: `cloud-failover/container/src/policy.mjs`
- Modify: `cloud-failover/container/src/policy.test.mjs`

**Interfaces:**
- Consumes: `normalizeDwsMessage(raw) -> { chatType, chatId, senderId, ... }`.
- Produces: `deliveryTarget(message) -> { kind: 'direct', openDingTalkId } | { kind: 'group', openConversationId }` and terminal DWS send evidence.

- [ ] **Step 1: Write direct/group delivery tests**

The production mutation caught is using `--group` for a direct message or using a sender identity as a group conversation ID.

```js
assert.deepEqual(deliveryTarget({ chatType: 'p2p', senderId: 'sender-1', chatId: 'chat-1' }), {
  kind: 'direct', openDingTalkId: 'sender-1',
});
assert.deepEqual(deliveryTarget({ chatType: 'group', senderId: 'sender-1', chatId: 'chat-1' }), {
  kind: 'group', openConversationId: 'chat-1',
});
```

The worker integration test must inspect the captured DWS argv and require the direct form for p2p and `--group` only for group.

- [ ] **Step 2: Verify RED**

Run:

```bash
node cloud-failover/container/src/policy.test.mjs
node cloud-failover/container/src/worker.test.mjs
```

Expected: the new direct-message case fails because current production always uses group send.

- [ ] **Step 3: Implement minimal routing**

Build DWS send args from `deliveryTarget(message)` and retain the existing stable UUID, terminal `query-send-status`, takeover readback and completion call.

- [ ] **Step 4: Verify GREEN**

Run the two tests from Step 2. Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add cloud-failover/container/src/policy.mjs cloud-failover/container/src/policy.test.mjs cloud-failover/container/src/worker.mjs cloud-failover/container/src/worker.test.mjs
git commit -m "fix: deliver cloud replies to direct chats"
```

### Task 5: Persist and drain an encrypted bounded standby journal

**Files:**
- Create: `cloud-failover/container/src/standby-buffer.mjs`
- Create: `cloud-failover/container/src/standby-buffer.test.mjs`
- Modify: `cloud-failover/container/src/worker.mjs`
- Modify: `cloud-failover/container/src/worker.test.mjs`
- Modify: `cloud-failover/container/package.json`
- Modify: `cloud-failover/container/.env.railway.example`
- Modify: `docs/CLOUD_FAILOVER.md`

**Interfaces:**
- Consumes: normalized message, container token, node identity, current time and `/data` path.
- Produces: `StandbyMessageBuffer.open(options)`, `.put(message)`, `.drain({ now, handler })`, `.prune(now)` and `.close()`.

- [ ] **Step 1: Write buffer behavior tests**

Use a real temporary SQLite database. Tests must prove:

```js
await first.put(message);
await first.close();
const second = await StandbyMessageBuffer.open(sameOptions);
assert.equal((await second.list()).length, 1);
assert.equal((await second.drain({ now, handler })).completed, 1);
assert.equal((await second.list()).length, 0);
```

Add separate cases for duplicate digest, 101st-row eviction, three-minute expiry, wrong-key decryption failure and handler failure retaining the row. Expectations are literal counts, not values computed by the production helper.

- [ ] **Step 2: Verify RED**

Run:

```bash
node cloud-failover/container/src/standby-buffer.test.mjs
```

Expected: fail because `StandbyMessageBuffer` does not exist.

- [ ] **Step 3: Implement encrypted SQLite storage**

Use `node:sqlite`, `PRAGMA secure_delete=ON`, one table keyed by the SHA-256 message digest, HKDF-SHA256 key derivation and AES-256-GCM. Enforce `maxRows=100` and `ttlMs=180000` inside every write and drain transaction. Do not log payloads or identities.

- [ ] **Step 4: Verify GREEN for the standalone buffer**

Run the test from Step 2. Expected: exit 0.

- [ ] **Step 5: Write worker integration tests before wiring**

Add cases proving an eligible standby p2p event is buffered instead of skipped, a blocked sender is never buffered, activation drains oldest-first, and a buffer-open/decrypt error prevents `coordinator.ready()`.

- [ ] **Step 6: Verify integration RED**

Run:

```bash
node cloud-failover/container/src/worker.test.mjs
```

Expected: the new standby-buffer assertions fail against the current worker.

- [ ] **Step 7: Wire buffering and activation drain**

Split static access/response validation from generation validation. Buffer only static-policy-eligible events while `activeGeneration===0`; on activation, set the fenced generation, drain through the normal claim/send path, run group-mention backfill, then announce readiness. Any journal integrity error fails closed.

- [ ] **Step 8: Verify GREEN and commit**

Run:

```bash
node cloud-failover/container/src/standby-buffer.test.mjs
node cloud-failover/container/src/worker.test.mjs
npm run test:cloud-failover
```

Expected: all exit 0.

```bash
git add cloud-failover/container/src/standby-buffer.mjs cloud-failover/container/src/standby-buffer.test.mjs cloud-failover/container/src/worker.mjs cloud-failover/container/src/worker.test.mjs cloud-failover/container/package.json cloud-failover/container/.env.railway.example docs/CLOUD_FAILOVER.md
git commit -m "feat: preserve messages across cloud takeover"
```

### Task 6: Make integrated heartbeat authoritative and compatible with online-first

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/ai-runtime.test.mjs`
- Modify: `src/index.mjs`
- Modify: `src/failover-heartbeat.test.mjs`
- Modify: `scripts/cloud-failover-heartbeat-sidecar.mjs`
- Modify: `scripts/cloud-failover-heartbeat-sidecar.test.mjs`
- Modify: `scripts/install-cloud-failover-heartbeat-sidecar.sh`
- Modify: `docs/CLOUD_FAILOVER.md`

**Interfaces:**
- Consumes: `online-first` runtime health, DWS connection state and signed `CloudFailoverClient.heartbeat`.
- Produces: one integrated heartbeat authority and a sidecar that remains restart-compatible only for rollback.

- [ ] **Step 1: Write compatibility and authority tests**

Add a test configuration with `aiRuntime='online-first'` and cloud failover enabled; require config load and an integrated heartbeat snapshot with `runtimeHealthy=true`. Add a lifecycle test proving process shutdown calls `heartbeat.stop()` exactly once and no sidecar is needed when integrated heartbeat is active.

- [ ] **Step 2: Verify RED**

Run the focused config, heartbeat and sidecar tests. Expected: the online-first restart fixture or authority assertion fails before implementation.

- [ ] **Step 3: Implement minimal compatibility**

Accept `online-first` and `ai-lab` in the integrated config validation, preserve the existing health snapshot, and update sidecar installation to refuse concurrent installation when the integrated runtime reports a fresh heartbeat.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
node src/failover-heartbeat.test.mjs
node scripts/cloud-failover-heartbeat-sidecar.test.mjs
npm run check
```

Expected: all exit 0.

```bash
git add src/config.mjs src/index.mjs src/failover-heartbeat.test.mjs scripts/cloud-failover-heartbeat-sidecar.mjs scripts/cloud-failover-heartbeat-sidecar.test.mjs scripts/install-cloud-failover-heartbeat-sidecar.sh docs/CLOUD_FAILOVER.md
git commit -m "fix: make online-first heartbeat authoritative"
```

### Task 7: Prepare and verify the deployable artifact

**Files:**
- Verify only: no production-file changes are planned in this task
- Verify: `config.local.json` via redacted programmatic read only; never stage it

**Interfaces:**
- Consumes: completed integration branch.
- Produces: tested commit suitable for Cloudflare, Railway and the local LaunchAgent.

- [ ] **Step 1: Run complete verification**

```bash
npm test
npm run test:cloud-failover
npm run check
npm run cloud-failover:dry
git diff --check
git status --short
```

Expected: every command exits 0; status contains only intentional tracked changes or is clean.

- [ ] **Step 2: Run secret/privacy scan**

Scan tracked changes for private config filenames, API-key prefixes, Channel/Profile values and DingTalk identities using the repository privacy tooling plus a bounded `git diff --cached`. Expected: no secret or identity material.

- [ ] **Step 3: Render the private blacklist bundle**

Run the new renderer against the live private configuration into a caller-created mode-0700 temporary directory. Require reported count `4`, stable digest and mode `0600`; do not print the bundle.

- [ ] **Step 4: Commit any verification-only corrections**

Stage only intended source/test/doc files and commit with a narrow message. Do not stage `config.local.json`, `data/`, logs or private bundles.

### Task 8: Deploy Cloudflare, Railway and the local service

**Files:**
- External: existing Cloudflare Worker deployment
- External: existing Railway standby service and volume
- Local private mutation: `config.local.json`
- Local service: macOS LaunchAgent and Dashboard

**Interfaces:**
- Consumes: verified branch, private blacklist bundle and existing sealed credentials.
- Produces: live `LOCAL_PRIMARY` coordinator state with integrated heartbeat and blacklist-mode local admission.

- [ ] **Step 1: Create a local configuration snapshot**

Use the existing configuration snapshot mechanism and record only its non-secret snapshot ID. Verify the current blocklist count is four before mutation.

- [ ] **Step 2: Deploy Cloudflare**

From `cloud-failover/worker`, run the authenticated Wrangler deploy. Then require unauthenticated root `401`, signed `/v1/status` JSON, protocol version `1` and no coordinator error.

- [ ] **Step 3: Synchronize Railway blacklist privately**

Use Railway CLI 5.37.7's stdin form so identity values never appear in command arguments or stdout:

```bash
railway variable set AIPROS_ACCESS_MODE --stdin --skip-deploys
railway variable set AIPROS_BLOCKED_SENDER_IDS --stdin --skip-deploys
railway variable set AIPROS_BLOCKED_CHAT_IDS --stdin --skip-deploys
```

Feed each value from the private bundle through stdin. Do not use `--json` or
`--kv`, because those forms include raw values. Read back only the known variable
names through the Railway service metadata/dashboard and compare the locally
computed count and digest.

- [ ] **Step 4: Deploy Railway with zero overlap**

Deploy `cloud-failover/container`, verify the committed `ALWAYS` restart policy, mounted `/data` volume, `/live=200`, authenticated `/ready`, DWS event readiness and one event-consumer process.

- [ ] **Step 5: Switch the live Mac to blacklist mode**

Programmatically change only `allowAllChats` from `false` to `true`; preserve the four blocklist objects byte-for-byte and preserve `aiRuntime=online-first`, AI-Lab credentials, DWS profile/channel and all unrelated config.

- [ ] **Step 6: Install the integrated local service**

Run the repository service installer from the integration worktree, then verify Dashboard process alive, DingTalk authenticated/connected, SQLite integrity, zero pending/failed/dead rows, AI-Lab runtime smoke and coordinator `LOCAL_PRIMARY` with fresh heartbeat.

- [ ] **Step 7: Remove the obsolete sidecar**

Only after Step 6 proves integrated heartbeat, boot out `com.local.aipros-cloud-failover-heartbeat` and remove its LaunchAgent plist. Verify coordinator heartbeats continue for at least two intervals from the integrated service.

### Task 9: Exercise takeover, recovery and reply evidence

**Files:**
- Runtime evidence only: Dashboard API, signed coordinator status, SQLite audit/echo ledger and private DWS readback.

**Interfaces:**
- Consumes: live deployment from Task 8.
- Produces: separate `deployed`, `takeover_verified`, `auto_reply_verified` and `7x24_verified` statuses.

- [ ] **Step 1: Run synthetic policy acceptance**

Require tests and runtime probes to show all four original identities project into Railway, a blocked fixture cannot buffer/claim/send, p2p uses direct delivery and non-@ group traffic is ignored.

- [ ] **Step 2: Start a recoverable controlled cloud window**

Use `scripts/start-cloud-runtime-window.sh 3`, which schedules restoration before stopping the local service and integrated heartbeat. Do not stop the Dashboard.

- [ ] **Step 3: Verify takeover state sequence**

Poll signed metadata status until `LOCAL_PRIMARY -> TAKING_OVER -> CLOUD_ACTIVE` with one generation increment, fresh Railway readiness and zero unexplained in-flight claims.

- [ ] **Step 4: Verify automatic reply when an authorized inbound exists**

Do not send an unsolicited inbound message. If a consenting tester or naturally arriving eligible message is available during the window, require exactly one terminal `SUCCESS + messageId`, one coordinator completion, same-conversation private DWS readback and no operational cloud prefix. If no eligible inbound occurs, retain `auto_reply_verified=false` while continuing infrastructure recovery tests.

- [ ] **Step 5: Verify recovery**

Allow the scheduled restore to start the integrated local service. Require three fresh healthy heartbeats, `DRAINING`, then `LOCAL_PRIMARY`; require zero duplicate claims/sends and healthy local queues.

- [ ] **Step 6: Run post-deploy verification**

```bash
npm run runtime-smoke
npm run health
npm run cloud-failover:smoke
```

Expected: local runtime smoke selects AI-Lab, health has no issues, and cloud smoke prints exactly `AIPR0S_CLOUD_OK`.

- [ ] **Step 7: Record the evidence boundary**

Report each of `deployed`, `takeover_verified`, `auto_reply_verified` and `7x24_verified` independently. `7x24_verified=true` requires a later harmless eligible message during an extended controlled cloud window; never infer it from process health alone.
