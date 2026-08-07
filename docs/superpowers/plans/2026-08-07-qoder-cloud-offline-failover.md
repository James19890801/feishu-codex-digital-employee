# Qoder Cloud Offline Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep AIPR0S local-first while adding three-attempt Qoder Cloud runtime fallback and Cloudflare-based whole-host takeover after three missed 30-second heartbeats.

**Architecture:** Local model calls pass through a policy-enforcing router and signed Cloudflare client. A Cloudflare Worker plus SQL-backed Durable Object owns heartbeat leases, generations, claims, Qoder Sessions, and recovery state; a pinned DWS Cloudflare Container starts only during takeover.

**Tech Stack:** Node.js ESM, built-in Web Crypto and `node:crypto`, Cloudflare Workers/Durable Objects/Containers, Wrangler 4, Qoder Cloud Agents REST/SSE API, `dingtalk-workspace-cli@1.0.56`, existing Node assertion tests.

## Global Constraints

- Local DWS Profile/Channel, SQLite, Persona, Bible, files, attachments, mail, documents, repository content, and long-term memory never enter cloud storage.
- Cloud execution is text-only L0/L1; L2/L3, business validation failures, secrets, files, images, and owner-confirmation flows fail closed.
- Three local attempts share the caller's existing total timeout budget; failures are not accumulated across unrelated messages.
- Heartbeat interval is 30 seconds; takeover and recovery each require three consecutive intervals.
- Cloud replies carry `【云端兜底】`; Wukong and alternate personal profiles remain prohibited.
- Secrets are provisioned only through macOS Keychain or Wrangler secrets and never committed.
- Live Cloudflare, Qoder, or DingTalk resource creation requires action-time approval.
- Branch is `codex/qoder-cloud-offline-failover`; verified changes are pushed to `codeup` and `origin`.

---

## File structure

- `src/cloud-failover-policy.mjs`: cloud eligibility, prompt sanitization, retry classification, audit-safe digests.
- `src/cloud-failover-client.mjs`: HMAC request signing, Cloudflare execute/heartbeat/status client.
- `src/local-first-runtime-router.mjs`: three-attempt local routing and cloud fallback.
- `src/failover-heartbeat.mjs`: non-overlapping 30-second heartbeat loop and health callbacks.
- `cloud-failover/worker/src/domain.mjs`: pure coordinator state machine and in-memory test repository.
- `cloud-failover/worker/src/auth.mjs`: Web Crypto HMAC verification and replay protection.
- `cloud-failover/worker/src/qoder-client.mjs`: Qoder REST/SSE adapter.
- `cloud-failover/worker/src/index.mjs`: Worker routes and Durable Object adapter.
- `cloud-failover/container/src/worker.mjs`: standby DWS backfill/live consumer and cloud reply pipeline.
- `cloud-failover/container/src/policy.mjs`: generation, authorization, message normalization, stable UUID rules.
- `cloud-failover/container/Dockerfile`: pinned Linux/amd64 DWS container.
- `cloud-failover/worker/wrangler.jsonc`: Worker, Durable Object, and Container bindings with secret names only.

---

### Task 1: Cloud eligibility and sanitization boundary

**Files:**
- Create: `src/cloud-failover-policy.mjs`
- Test: `src/cloud-failover-policy.test.mjs`

**Interfaces:**
- Produces: `classifyRuntimeFailure(error): { retryable: boolean, code: string }`
- Produces: `evaluateCloudEligibility(input): { eligible: boolean, reason: string }`
- Produces: `sanitizeCloudPrompt(prompt, options): { text: string, digest: string, bytes: number }`

- [ ] **Step 1: Write the failing policy tests**

```js
assert.deepEqual(classifyRuntimeFailure(new Error('process timed out')).retryable, true);
assert.equal(evaluateCloudEligibility({ level: 'L2', prompt: 'create event' }).reason, 'risk_level');
assert.equal(evaluateCloudEligibility({ level: 'L0', prompt: 'hello', images: [] }).eligible, true);
const safe = sanitizeCloudPrompt('token=secret-value /Users/name/private.txt', {
  forbiddenValues: ['secret-value'], maxChars: 24000,
});
assert.equal(safe.text.includes('secret-value'), false);
assert.equal(safe.text.includes('/Users/name'), false);
```

- [ ] **Step 2: Run RED**

Run: `node src/cloud-failover-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement minimal deterministic policy functions**

Use an allowlist for runtime-error codes/patterns and a deny-first eligibility check for risk level, images, attachments, mutation/confirmation flags, sensitive source kinds, credential patterns, and size. Replace forbidden values and absolute paths before hashing with SHA-256.

- [ ] **Step 4: Run GREEN**

Run: `node src/cloud-failover-policy.test.mjs`

Expected: `CLOUD_FAILOVER_POLICY_TEST_OK`.

- [ ] **Step 5: Commit**

```bash
git add src/cloud-failover-policy.mjs src/cloud-failover-policy.test.mjs
git commit -m "feat: enforce cloud failover data boundary"
```

---

### Task 2: Signed Cloudflare client and local-first runtime router

**Files:**
- Create: `src/cloud-failover-client.mjs`
- Create: `src/cloud-failover-client.test.mjs`
- Create: `src/local-first-runtime-router.mjs`
- Create: `src/local-first-runtime-router.test.mjs`

**Interfaces:**
- Consumes: Task 1 policy functions.
- Produces: `signFailoverRequest({ method, path, body, timestamp, nonce, secret })`
- Produces: `CloudFailoverClient.execute(input)`, `.heartbeat(input)`, `.status()`
- Produces: `LocalFirstRuntimeRouter.run(prompt, options, context)`

- [ ] **Step 1: Write failing HMAC and router tests**

```js
const result = await router.run('hello', { timeoutMs: 120000 }, { level: 'L0' });
assert.equal(localCalls, 3);
assert.equal(cloudCalls, 1);
assert.equal(result.runtime.id, 'qoder-cloud');
assert.deepEqual(attemptTimeouts, [40000, 40000, 40000]);
```

Also assert local success never calls cloud, a business error stops after one attempt, images never call cloud, and Cloudflare receives only sanitized text plus digest.

- [ ] **Step 2: Run RED**

Run: `node src/cloud-failover-client.test.mjs && node src/local-first-runtime-router.test.mjs`

Expected: both fail because modules are absent.

- [ ] **Step 3: Implement request signing/client**

Canonical signing string:

```text
METHOD\n/path\nunix_ms\nnonce\nsha256_hex(body)
```

Send `x-aipros-node`, `x-aipros-timestamp`, `x-aipros-nonce`, `x-aipros-content-sha256`, and `x-aipros-signature`. Require HTTPS, bounded JSON, AbortSignal timeout, `cache-control: no-store`, and a strict response shape.

- [ ] **Step 4: Implement the router**

Allocate `Math.floor(timeoutMs / attempts)` per attempt, preserve total deadline, use one- and two-second delay only while budget remains, classify every local error, and evaluate cloud policy after the third retryable error. Return cloud runtime metadata without changing configured runtime selection.

- [ ] **Step 5: Run GREEN and commit**

Run: `node src/cloud-failover-client.test.mjs && node src/local-first-runtime-router.test.mjs`

```bash
git add src/cloud-failover-client* src/local-first-runtime-router*
git commit -m "feat: route failed local calls to cloud"
```

---

### Task 3: Local configuration, heartbeat, runtime wiring, and health model

**Files:**
- Create: `src/failover-heartbeat.mjs`
- Create: `src/failover-heartbeat.test.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `src/index.mjs`
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `scripts/health-check.mjs`
- Modify: `scripts/check-config.mjs`

**Interfaces:**
- Consumes: `CloudFailoverClient`, `LocalFirstRuntimeRouter`, existing `AgentState` settings.
- Produces: `FailoverHeartbeat.start()` and `.stop()`.
- Produces health settings under `cloud_failover` and `health` without body content.

- [ ] **Step 1: Write failing heartbeat/config/dashboard tests**

Prove no overlapping heartbeat calls, stop is interruptible, failures do not stop local processing, config defaults are disabled/30s/3/3/3, invalid non-HTTPS URLs fail, and Dashboard maps `LOCAL_PRIMARY`, `CLOUD_ACTIVE`, `DRAINING`, and `DEGRADED`.

- [ ] **Step 2: Run RED**

Run: `node src/failover-heartbeat.test.mjs && node src/dashboard-model.test.mjs`

- [ ] **Step 3: Implement heartbeat and config**

Read the HMAC secret through the existing keychain helper pattern only when enabled. Build heartbeat metadata from status booleans and hashed message ID. Persist only timestamps, state, generation, attempt counts, codes, and error summaries.

- [ ] **Step 4: Wire the runtime router at the single `runAiRuntime()` boundary**

Keep `runAiRuntimeStartupProbe()` local-only. Mark generic natural-language replies L0/L1; mark A1 planning, mail, document-grounded, multimodal, pending confirmations, and mutation-adjacent calls cloud-ineligible unless an explicit safe context is supplied.

- [ ] **Step 5: Run tests and commit**

Run: `node src/failover-heartbeat.test.mjs && node src/ai-runtime.test.mjs && node src/dashboard-model.test.mjs && node scripts/distribution-defaults.test.mjs`

```bash
git add src config.example.json scripts
git commit -m "feat: wire local failover heartbeat and health"
```

---

### Task 4: Cloudflare coordinator domain and HMAC boundary

**Files:**
- Create: `cloud-failover/worker/package.json`
- Create: `cloud-failover/worker/src/domain.mjs`
- Create: `cloud-failover/worker/src/domain.test.mjs`
- Create: `cloud-failover/worker/src/auth.mjs`
- Create: `cloud-failover/worker/src/auth.test.mjs`
- Modify: `pnpm-workspace.yaml`

**Interfaces:**
- Produces: `FailoverCoordinatorService.heartbeat()`, `.evaluate()`, `.containerReady()`, `.claim()`, `.complete()`, `.status()`.
- Produces: `verifySignedRequest(request, env, replayStore, now)`.

- [ ] **Step 1: Write failing state-machine tests**

```js
await service.heartbeat({ at: 0, healthy: true, serviceStartId: 'start-1' });
assert.equal((await service.evaluate(89000)).state, 'LOCAL_PRIMARY');
assert.equal((await service.evaluate(90000)).state, 'TAKING_OVER');
assert.equal((await service.evaluate(90000)).generation, 1);
```

Repeat `evaluate(90000)` and assert generation remains 1. Add stale-generation claim rejection, duplicate message claim rejection, three-heartbeat drain, and drain completion tests.

- [ ] **Step 2: Write failing auth tests**

Test valid signature, body tamper, 91-second expiry, unknown node, and replayed nonce.

- [ ] **Step 3: Implement pure domain and auth modules**

Use repository methods so tests run in Node without Workers. State transitions compare current state/generation before every write. Store SHA-256 message digests only.

- [ ] **Step 4: Run GREEN and commit**

Run: `pnpm --dir cloud-failover/worker test`

```bash
git add cloud-failover/worker pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat: add failover coordinator state machine"
```

---

### Task 5: Qoder Cloud Agent REST/SSE adapter

**Files:**
- Create: `cloud-failover/worker/src/qoder-client.mjs`
- Create: `cloud-failover/worker/src/qoder-client.test.mjs`

**Interfaces:**
- Produces: `QoderCloudClient.execute({ prompt, digest, metadata }): Promise<{ text, sessionId, latencyMs }>`.

- [ ] **Step 1: Write failing protocol tests**

Fixtures must assert:

- `POST /sessions` uses `agent: { id, version }`, `environment_id`, flat string metadata, and no tools/resources/vaults/memory;
- `POST /sessions/{id}/events` sends exactly one `user.message`;
- SSE parsing joins `agent.message` and ends only at `session.status_idle`;
- archive runs in `finally` after terminal completion;
- 429/503 retry at 1s/2s/4s and 400 fails once with a redacted error.

- [ ] **Step 2: Run RED**

Run: `node cloud-failover/worker/src/qoder-client.test.mjs`

- [ ] **Step 3: Implement minimal REST/SSE client**

Use gateway `https://api.qoder.com/api/v1/cloud`, Bearer PAT, `Accept: text/event-stream`, bounded response sizes, and strict event parsing. Do not support tool confirmations because the configured Agent has no tools.

- [ ] **Step 4: Run GREEN and commit**

```bash
git add cloud-failover/worker/src/qoder-client*
git commit -m "feat: add qoder cloud agent adapter"
```

---

### Task 6: Cloudflare Worker routes, Durable Object persistence, and container control

**Files:**
- Create: `cloud-failover/worker/src/repository-do.mjs`
- Create: `cloud-failover/worker/src/repository-do.test.mjs`
- Create: `cloud-failover/worker/src/index.mjs`
- Create: `cloud-failover/worker/src/index.test.mjs`
- Create: `cloud-failover/worker/wrangler.jsonc`
- Create: `cloud-failover/worker/.dev.vars.example`

**Interfaces:**
- Routes: `POST /v1/heartbeat`, `POST /v1/runtime/execute`, `GET /v1/status`.
- Internal RPC: `startStandby(generation)`, `stopStandby(generation)`, `executeQoder(input)`.

- [ ] **Step 1: Write failing route/repository tests**

Assert exact JSON keys, size limits, HMAC requirement, no-store headers, metadata-only status, one coordinator instance by node ID, alarm rescheduling, and container start/stop exactly once per generation.

- [ ] **Step 2: Run RED**

Run: `node cloud-failover/worker/src/repository-do.test.mjs && node cloud-failover/worker/src/index.test.mjs`

- [ ] **Step 3: Implement storage and Worker**

Create SQL tables for coordinator state, nonce expiry, claims, and bounded outcomes. Request bodies and replies remain in memory only. Alarm handler calls pure domain `evaluate()` and then container lifecycle RPC.

- [ ] **Step 4: Add Wrangler configuration**

Bind the SQL-backed Durable Object and Cloudflare Container. List, but do not fill, `AIPROS_HMAC_SECRET`, `QODER_PAT`, `QODER_AGENT_ID`, `QODER_AGENT_VERSION`, `QODER_ENVIRONMENT_ID`, `DINGTALK_CLIENT_ID`, and `DINGTALK_CLIENT_SECRET`.

- [ ] **Step 5: Run GREEN/dry build and commit**

Run: `pnpm --dir cloud-failover/worker test && pnpm --dir cloud-failover/worker run deploy:dry`

```bash
git add cloud-failover/worker
git commit -m "feat: expose cloud failover worker"
```

---

### Task 7: Standby DWS Cloudflare Container

**Files:**
- Create: `cloud-failover/container/package.json`
- Create: `cloud-failover/container/Dockerfile`
- Create: `cloud-failover/container/src/policy.mjs`
- Create: `cloud-failover/container/src/policy.test.mjs`
- Create: `cloud-failover/container/src/worker.mjs`
- Create: `cloud-failover/container/src/worker.test.mjs`

**Interfaces:**
- Consumes coordinator internal claim/complete/Qoder APIs.
- Produces `/health`, `/generation`, and graceful SIGTERM drain endpoints inside the container only.

- [ ] **Step 1: Write failing container policy tests**

Assert authorized chat/sender, generation match, three-minute lower bound, stable UUID from channel/message ID, `【云端兜底】` prefix, L2/L3 owner handoff, no prompt/body logs, and rejection of `DWS_CHANNEL`, local profile, file, image, mail, and document inputs.

- [ ] **Step 2: Run RED**

Run: `node cloud-failover/container/src/policy.test.mjs && node cloud-failover/container/src/worker.test.mjs`

- [ ] **Step 3: Implement testable worker orchestration**

Inject process runner, clock, coordinator client, and DWS adapter. Build DWS commands from independent `--client-id`/`--client-secret`, never `--profile` or local `DWS_CHANNEL`. Consume NDJSON events, claim before Qoder, and complete with metadata only.

- [ ] **Step 4: Add pinned container build**

Use a pinned Node 24 slim base, `npm install --global dingtalk-workspace-cli@1.0.56`, non-root user, read-only application files, `NODE_ENV=production`, and a health endpoint. No secret uses `ARG` or `ENV` in the Dockerfile.

- [ ] **Step 5: Run tests and policy inspection, then commit**

Run: `node cloud-failover/container/src/policy.test.mjs && node cloud-failover/container/src/worker.test.mjs && rg -n "1.0.56|USER" cloud-failover/container/Dockerfile`

```bash
git add cloud-failover/container cloud-failover/worker/wrangler.jsonc
git commit -m "feat: add standby dws cloud container"
```

---

### Task 8: Distribution policy, documentation, and end-to-end verification

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `scripts/distribution-package.mjs`
- Modify: `scripts/distribution-package.test.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `README.md`
- Create: `docs/CLOUD_FAILOVER.md`
- Create: `scripts/cloud-failover-smoke.mjs`
- Create: `scripts/cloud-failover-smoke.test.mjs`

**Interfaces:**
- Produces: `npm run test:cloud-failover`, `npm run cloud-failover:dry`, and `npm run cloud-failover:smoke`.

- [ ] **Step 1: Add failing distribution and mechanism assertions**

Require all cloud modules/assets and reject committed PATs, AppSecrets, HMAC secrets, DWS profiles/channels, `.dev.vars`, Wrangler state, prompt fixtures containing private data, and container secret ENV values.

- [ ] **Step 2: Run RED**

Run: `node scripts/distribution-package.test.mjs && node src/mechanism-acceptance.test.mjs`

- [ ] **Step 3: Wire scripts and documentation**

Document implemented/draft/activated/verified states, Cloudflare Paid-plan Container prerequisite, exact Wrangler secret names, Qoder Agent no-tool contract, controlled stop/recovery acceptance, rollback, cost limits, and the fact that archived Qoder Sessions are not guaranteed deletion.

- [ ] **Step 4: Run targeted verification**

```bash
npm run test:cloud-failover
npm run cloud-failover:dry
npm run test:distribution-package
npm run test:mechanisms
```

- [ ] **Step 5: Run full verification**

```bash
npm run check
npm test
git diff --check
git status --short
```

Expected: all commands exit 0; mechanism acceptance reports zero failures; status contains only intentional source/docs changes.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml scripts src README.md docs cloud-failover
git commit -m "docs: complete cloud failover delivery"
```

- [ ] **Step 7: Provision only after action-time approval**

If the user approves persistent external creation and supplies/authorizes secrets, create the tool-free Qoder Agent/Environment, deploy Cloudflare Worker/Container, set secrets, run signed heartbeat readback, run harmless `AIPR0S_CLOUD_OK`, then perform controlled local-service stop/cloud reply/recovery acceptance. Otherwise report repository delivery as implemented but live failover as not activated.

- [ ] **Step 8: Push verified branch**

```bash
git push -u codeup codex/qoder-cloud-offline-failover
git push -u origin codex/qoder-cloud-offline-failover
```
