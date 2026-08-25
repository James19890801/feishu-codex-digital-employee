# Railway Whole-Host Failover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy an always-warm Railway DWS runtime that takes over authorized DingTalk replies after three missed local heartbeats while Cloudflare remains the coordinator and Qoder execution boundary.

**Architecture:** Remove the unavailable Cloudflare Container data plane while preserving the existing Durable Object coordinator. Add an authenticated lease protocol that Railway polls every 10 seconds; the Railway process keeps DWS connected, activates only for the current takeover generation, and uses existing claim, Qoder, completion, and recovery fencing.

**Tech Stack:** Node.js ESM, Node test/assert, Cloudflare Workers and SQLite Durable Objects, Qoder Cloud Agents API, DWS CLI, Docker, Railway Config as Code and Railway CLI.

## Global Constraints

- Local execution remains primary and whole-host takeover starts only after three missed 30-second heartbeats.
- Cloud accepts text-only L0/L1; L2/L3 receives only the owner-confirmation handoff.
- Railway never receives local DWS Profile/Channel, local files, local memory, the Qoder PAT, or the heartbeat HMAC secret.
- All Railway and DingTalk credentials remain sealed service variables and must never be committed or printed.
- Generation fencing, idempotent claims, stable DingTalk UUIDs, three-minute backfill, and three-heartbeat recovery draining remain authoritative.
- Do not claim verified 7x24 until the controlled 30-minute outage acceptance passes and Railway supports unbounded restart.

---

### Task 1: Cloudflare Railway lease protocol

**Files:**
- Modify: `cloud-failover/worker/src/domain.mjs`
- Modify: `cloud-failover/worker/src/domain.test.mjs`
- Modify: `cloud-failover/worker/src/index.mjs`
- Modify: `cloud-failover/worker/src/routes.mjs`
- Modify: `cloud-failover/worker/src/index.test.mjs`
- Modify: `cloud-failover/worker/wrangler.jsonc`

**Interfaces:**
- Produces: `FailoverCoordinatorService.lease(now): Promise<Status>`; `FailoverCoordinator.lease(): Promise<Status>`; `POST /internal/runtime/lease|ready|claim|complete|qoder` with Bearer authentication.
- Preserves: legacy `/internal/container/ready|claim|complete|qoder` aliases for rollback compatibility.

- [ ] **Step 1: Write failing domain and route tests**

Add a domain assertion that `lease(90_000)` transitions a coordinator with no heartbeat from `LOCAL_PRIMARY` to `TAKING_OVER` generation `1`. Add route assertions that an authorized `POST /internal/runtime/lease` returns that state, an unauthorized request returns `401`, and `/internal/runtime/ready` delegates the current generation.

- [ ] **Step 2: Run tests and verify red state**

Run: `pnpm --dir cloud-failover/worker test`

Expected: FAIL because `lease` and `/internal/runtime/*` do not exist.

- [ ] **Step 3: Implement the minimal coordinator protocol**

Implement `lease(now = Date.now()) { return this.evaluate(now); }`, expose it on the Durable Object, and route the five Railway operations through the same constant-time Bearer boundary used by the old container routes. The route must ignore client-supplied time and call `stub.lease()`.

Remove `StandbyContainer`, `@cloudflare/containers`, `STANDBY_CONTAINER`, and the `containers` block. Replace alarm container startup/health/stop behavior with `await this.service.evaluate(Date.now())` followed by rescheduling. Add migration `v2` with `deleted_classes: ["StandbyContainer"]` so the already-deployed namespace is explicitly retired while `FailoverCoordinator` storage remains untouched.

- [ ] **Step 4: Run focused tests and Worker dry-run**

Run: `pnpm --dir cloud-failover/worker test && npm run cloud-failover:dry`

Expected: all Worker tests pass and dry-run lists only `FAILOVER_COORDINATOR`, with no Container image build.

- [ ] **Step 5: Commit**

```bash
git add cloud-failover/worker
git commit -m "feat: add railway runtime lease protocol"
```

### Task 2: Always-warm Railway runtime

**Files:**
- Modify: `cloud-failover/container/src/worker.mjs`
- Modify: `cloud-failover/container/src/worker.test.mjs`
- Create: `cloud-failover/container/src/runtime.mjs`
- Create: `cloud-failover/container/src/runtime.test.mjs`
- Modify: `cloud-failover/container/package.json`

**Interfaces:**
- Consumes: `CoordinatorClient.lease()`, `ready(generation)`, `claim(input)`, `complete(input)`, and `qoder(input)`.
- Produces: `RailwayFailoverRuntime.tick(): Promise<LeaseResult>`; `RailwayFailoverRuntime.start(): Promise<void>`; `StandbyDwsWorker.initialize()`, `activate(generation)`, and `deactivate()`.

- [ ] **Step 1: Write failing lifecycle tests**

Add tests proving: `initialize()` authenticates and starts one event consumer; standby events return `{ skipped: "standby" }`; `activate(3)` calls `ready(3)`, enables generation `3`, and backfills allowed chats; `deactivate()` closes new processing; a second activation of generation `3` is idempotent; `tick()` activates on `TAKING_OVER`, remains active on matching `CLOUD_ACTIVE`, and deactivates on `DRAINING` or `LOCAL_PRIMARY`.

- [ ] **Step 2: Run tests and verify red state**

Run: `pnpm --dir cloud-failover/container test`

Expected: FAIL because lifecycle and Railway runtime interfaces are missing.

- [ ] **Step 3: Split DWS lifecycle from activation**

Refactor authentication and event-stream startup into `initialize()`. Track `activeGeneration` separately from the last observed generation. Make `processMessage()` return `standby` before normalization/claim when inactive. Move the existing three-minute chat backfill into `activate(generation)`, call coordinator `ready` before opening claims, and make `deactivate()` set `activeGeneration` to zero without terminating the event stream.

- [ ] **Step 4: Add the Railway poll loop**

Implement a testable `RailwayFailoverRuntime` with a 10-second base delay, capped 60-second exponential backoff, jitter injection, abortable sleep, and no activation on lease errors. `start()` initializes DWS, then repeats `tick()` until aborted. A matching `CLOUD_ACTIVE` generation must remain active without another `ready` call.

- [ ] **Step 5: Serve Railway liveness and handle shutdown**

Listen on `Number(process.env.PORT || 8788)`. `/live` returns `200` with only `{ ok: true }`; `/ready` returns `200` only when DWS is authenticated and includes no identity or secret. On `SIGTERM` or `SIGINT`, abort the poll loop, deactivate the worker, close the HTTP server, and exit after bounded cleanup.

- [ ] **Step 6: Run container tests**

Run: `pnpm --dir cloud-failover/container test`

Expected: lifecycle, polling, liveness, and existing policy tests pass.

- [ ] **Step 7: Commit**

```bash
git add cloud-failover/container/src cloud-failover/container/package.json
git commit -m "feat: run dws failover continuously on railway"
```

### Task 3: Railway deployment configuration and runbook

**Files:**
- Create: `cloud-failover/container/railway.json`
- Create: `cloud-failover/container/.env.railway.example`
- Modify: `cloud-failover/container/Dockerfile`
- Modify: `docs/CLOUD_FAILOVER.md`
- Create: `scripts/railway-failover-smoke.mjs`
- Create: `scripts/railway-failover-smoke.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: Railway Docker deployment rooted at `cloud-failover/container`; `npm run railway-failover:smoke` for metadata-only liveness and coordinator lease verification.

- [ ] **Step 1: Write the failing smoke test**

Test that the smoke script requires `RAILWAY_PUBLIC_URL`, requests `/live`, rejects non-200 or non-`{ok:true}` responses, calls Cloudflare `/internal/runtime/lease` using `AIPROS_CONTAINER_TOKEN`, and never prints token values.

- [ ] **Step 2: Run the test and verify red state**

Run: `node scripts/railway-failover-smoke.test.mjs`

Expected: FAIL because the smoke script does not exist.

- [ ] **Step 3: Add Railway config as code**

Create `railway.json` using the official schema, Dockerfile builder, `/live` healthcheck, 300-second timeout, `ON_FAILURE` restart with 10 retries as the portable default, 20-second deployment overlap, and 30-second draining. Document switching to `ALWAYS` after confirming a paid Railway plan.

Update the Dockerfile to expose the runtime port while relying on Railway's injected `PORT`. Add an example file containing names only for the seven required runtime variables plus `PORT=8788`; use non-secret sample markers and no real values.

- [ ] **Step 4: Implement smoke and update runbook**

Implement redacted HTTP checks with explicit timeouts. Update the delivery-state table and instructions so Railway is the whole-host runtime, Cloudflare Containers are retired, the login/deploy command is `railway up --path-as-root cloud-failover/container`, and the exact acceptance boundary remains unchanged.

- [ ] **Step 5: Run tests and build the image**

Run: `node scripts/railway-failover-smoke.test.mjs && docker build --platform linux/amd64 -t aipros-railway-failover:test cloud-failover/container`

Expected: smoke tests pass and Docker produces a Linux amd64 image with the DWS CLI layer.

- [ ] **Step 6: Commit**

```bash
git add cloud-failover/container docs/CLOUD_FAILOVER.md scripts/railway-failover-smoke.mjs scripts/railway-failover-smoke.test.mjs package.json
git commit -m "feat: package whole-host failover for railway"
```

### Task 4: Full verification and Cloudflare rollout

**Files:**
- Verify only: all files changed by Tasks 1-3.

**Interfaces:**
- Consumes: complete Railway runtime and Cloudflare lease protocol.
- Produces: deployed Cloudflare coordinator without a Container Registry dependency.

- [ ] **Step 1: Run the complete local gate**

Run: `npm run check && npm test && npm run cloud-failover:dry`

Expected: syntax checks, all unit/integration tests, 94 mechanism acceptances, and Worker dry-run pass.

- [ ] **Step 2: Scan committed changes for secrets**

Run a diff-based scan for assigned values of `QODER_PAT`, `DINGTALK_CLIENT_SECRET`, `DINGTALK_DWS_AUTH_BUNDLE_B64`, `AIPROS_CONTAINER_TOKEN`, and console password. Expected: no committed credential values.

- [ ] **Step 3: Deploy Cloudflare Worker**

Run: `pnpm --dir cloud-failover/worker exec wrangler deploy`

Expected: Worker deploy succeeds without building or pushing a Cloudflare Container image. Verify the console account returns `200`, the old account returns `401`, and authorized `/internal/runtime/lease` returns a valid protocol state.

- [ ] **Step 4: Commit any verification-only documentation corrections**

```bash
git add docs/CLOUD_FAILOVER.md
git commit -m "docs: record railway failover verification"
```

### Task 5: Railway authentication, secrets, deployment, and remote readback

**Files:**
- No committed secret files.
- Railway remote service configuration only.

**Interfaces:**
- Consumes: the user's Railway account, dedicated DingTalk app credentials, and one interactive DWS device authorization.
- Produces: an active Railway deployment and redacted status evidence.

- [ ] **Step 1: Install and authenticate Railway CLI**

Install the official CLI without changing project dependencies, run `railway login`, and pause only for the browser/device-code authorization. Verify with `railway whoami` without printing tokens.

- [ ] **Step 2: Create or select the Railway project and service**

Use the existing Railway account, create/reuse project `aipros-cloud-failover`, environment `production`, and service `dws-standby`. Link the worktree only after reading back the exact project/environment/service selection.

- [ ] **Step 3: Provision secrets without exposing values**

Set the seven required runtime variables, including the Cloudflare coordinator URL. Generate/import the dedicated DWS auth bundle only after the user completes device login. Read back variable names, not values, and require the exact expected set.

- [ ] **Step 4: Deploy and verify Railway**

Run `railway up --path-as-root cloud-failover/container --ci`, wait for `SUCCESS`, read deployment logs for bounded error codes, generate a public domain for `/live` if needed, and run `npm run railway-failover:smoke`.

- [ ] **Step 5: Check plan and restart-policy boundary**

Read the deployed restart policy. If Railway permits `ALWAYS`, enable it and redeploy. Otherwise retain `ON_FAILURE` with ten retries and report that 7x24 remains unverified rather than overstating availability.

- [ ] **Step 6: Push both remotes**

```bash
git push origin codex/qoder-cloud-offline-failover
git push codeup codex/qoder-cloud-offline-failover
```

Expected: both remote branch heads equal the local commit.
