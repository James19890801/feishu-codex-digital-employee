# Personal WeChat Production Reliability Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fragile personal-WeChat quick-tunnel deployment with a fixed Cloudflare Named Tunnel, end-to-end health probes, bounded automatic recovery, and a Git-traceable production release layout isolated from development worktrees.

**Architecture:** Keep the current Node.js/SQLite message service as the business runtime, but place a separate reliability supervisor and a separate Named Tunnel connector beside it. The supervisor evaluates local callback, cloudflared, public-loopback, and GeWe provider health, persists factual state, and invokes one bounded recovery action at a time. Production runs from immutable Git-derived releases under `~/Library/Application Support/AIPRO`, while mutable configuration, data, logs, and Keychain secrets remain outside the release.

**Tech Stack:** Node.js ESM, `node:test`/`node:assert`, SQLite/atomic JSON, macOS LaunchAgent, `cloudflared` remotely-managed Named Tunnel, macOS Keychain, vanilla dashboard JavaScript, Git worktrees/tags.

---

## Execution rules

- Work only in `.worktrees/wechat-production-reliability` on branch `codex/wechat-production-reliability`.
- Use `@superpowers:test-driven-development` for every behavior change: write the test, observe the intended failure, then implement the minimum code.
- Do not copy `config.local.json`, Keychain secrets, runtime SQLite, production logs, or untracked files into Git or a release.
- Do not invoke real production `launchctl` from unit/integration tests. Inject a stub executable and temporary service domain.
- Do not modify the live LaunchAgents until Tasks 1–10 pass and the controlled rollout checklist begins.
- Keep commits small and scoped exactly as shown.

### Task 1: Define the reliability health and recovery policy

**Files:**
- Create: `src/wechat-reliability-policy.mjs`
- Create: `src/wechat-reliability-policy.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing state-model tests**

Cover these cases with a fake clock and deterministic random source:

```js
const first = evaluateWechatReliability({
  previous: emptyWechatReliabilityState(),
  sample: healthySample(),
  nowMs: 1_000,
});
assert.equal(first.state, 'starting');

const degraded = applySamples([
  failedPublicSample(), failedPublicSample(), failedPublicSample(),
]);
assert.equal(degraded.state, 'degraded');
assert.equal(degraded.failureLayer, 'public_callback');
assert.deepEqual(degraded.recovery, { action: 'restart_tunnel', attempt: 1 });

const open = applyRepeatedRecoveryFailures(6);
assert.equal(open.state, 'circuit_open');
assert.ok(open.circuitOpenUntilMs > open.checkedAtMs);
```

Also assert:

- one or two failures do not request a restart;
- provider failure maps to `provider_down`, not `restart_tunnel`;
- local failure requests `reconcile_main_service`;
- tunnel failure requests `reconcile_tunnel`;
- public-only failure requests tunnel recovery, then callback alignment;
- three consecutive successes clear failures and close the circuit;
- backoff is 10s, 30s, 60s, 120s, 300s plus injected jitter;
- at most five destructive actions occur per 15-minute window.

**Step 2: Run the test and verify RED**

Run: `node src/wechat-reliability-policy.test.mjs`

Expected: FAIL because `wechat-reliability-policy.mjs` does not exist.

**Step 3: Implement the pure policy**

Export only pure functions and serializable data:

```js
export function emptyWechatReliabilityState(nowMs = 0) { /* ... */ }
export function evaluateWechatReliability({ previous, sample, nowMs, random }) { /* ... */ }
export function recoveryDelayMs(attempt, random = Math.random) { /* ... */ }
export function isDestructiveRecovery(action) { /* ... */ }
```

Use explicit layers: `local_service`, `tunnel`, `public_callback`, `provider`, and `callback_registration`. Preserve every layer's last success, last failure, duration, and consecutive counts. Never infer public callback health from provider account health.

**Step 4: Run focused and regression tests**

Run:

```bash
node src/wechat-reliability-policy.test.mjs
node src/reliability.test.mjs
```

Expected: both pass.

**Step 5: Register the test and commit**

Add the focused test to `npm test` before the existing `src/reliability.test.mjs` entry.

```bash
git add package.json src/wechat-reliability-policy.mjs src/wechat-reliability-policy.test.mjs
git commit -m "feat: define WeChat reliability state machine"
```

### Task 2: Add an authenticated public-loopback canary

**Files:**
- Create: `src/wechat-reliability-canary.mjs`
- Create: `src/wechat-reliability-canary.test.mjs`
- Modify: `src/im-channel-runtime.mjs`
- Modify: `src/gewe-webhook.test.mjs`
- Modify: `package.json`

**Step 1: Write failing canary-domain tests**

Test a deterministic HMAC contract without binding a socket:

```js
const challenge = createCanaryChallenge({ secret: 's'.repeat(32), nowMs: 10_000, nonce: 'abc' });
assert.equal(verifyCanaryChallenge(challenge, {
  secret: 's'.repeat(32), nowMs: 10_500,
}).ok, true);
assert.equal(verifyCanaryChallenge({ ...challenge, signature: 'bad' }, {
  secret: 's'.repeat(32), nowMs: 10_500,
}).ok, false);
assert.equal(verifyCanaryChallenge(challenge, {
  secret: 's'.repeat(32), nowMs: 80_000,
}).reason, 'expired');
```

Require constant-time signature comparison, a 60-second validity window, bounded nonce length, and no callback-path secret in the URL.

**Step 2: Run and verify RED**

Run: `node src/wechat-reliability-canary.test.mjs`

Expected: FAIL because the module does not exist.

**Step 3: Implement the canary contract**

Use `node:crypto` HMAC-SHA256. The response body contains only:

```json
{"ok":true,"nonceDigest":"<sha256>","at":"<ISO timestamp>"}
```

Do not return the raw nonce, HMAC, callback path, app ID, or account identity.

**Step 4: Write failing webhook-server integration tests**

Start `GeWeWebhookServer` on an ephemeral port and assert:

- valid `GET /internal/reliability/canary?...` returns 200 and never calls `onMessage`;
- invalid/expired signatures return 404, not a detailed authentication error;
- POST webhook behavior and artifact routes remain unchanged;
- request/query size remains bounded.

**Step 5: Run and verify RED**

Run: `node src/gewe-webhook.test.mjs`

Expected: FAIL because the server does not route the canary.

**Step 6: Wire the canary into `GeWeWebhookServer`**

Pass a dedicated `canarySecret` and route only the fixed path. Keep the existing random GeWe callback path unchanged. Emit `callbackListening` only after the socket is bound.

**Step 7: Run tests and commit**

```bash
node src/wechat-reliability-canary.test.mjs
node src/gewe-webhook.test.mjs
git add package.json src/wechat-reliability-canary* src/gewe-webhook.mjs src/gewe-webhook.test.mjs
git commit -m "feat: add authenticated callback canary"
```

### Task 3: Build factual cloudflared and public probes

**Files:**
- Create: `src/wechat-reliability-probes.mjs`
- Create: `src/wechat-reliability-probes.test.mjs`
- Modify: `package.json`

**Step 1: Write failing probe tests**

Use a local fake HTTP server or injected `fetchImpl` to cover:

- local callback success/failure;
- cloudflared `/ready` success plus metrics containing active connections;
- `/ready` 200 with zero active connections is unhealthy;
- public canary success must match the expected nonce digest;
- HTTP timeout, DNS failure, 5xx and invalid JSON produce bounded error codes;
- GeWe provider account online, offline, authentication failure and network failure remain distinct;
- callback alignment records `lastRegisteredAt` only after `setCallback` returns success.

Example desired API:

```js
const sample = await collectWechatReliabilitySample({
  localUrl,
  metricsUrl,
  publicBaseUrl,
  canarySecret,
  provider: { checkOnline, alignCallback },
  fetchImpl,
  now,
});
assert.equal(sample.layers.public_callback.ok, true);
```

**Step 2: Run and verify RED**

Run: `node src/wechat-reliability-probes.test.mjs`

Expected: FAIL because the probe module does not exist.

**Step 3: Implement bounded probes**

- Local and metrics timeout: 3 seconds.
- Public canary timeout: 5 seconds.
- Provider timeout: reuse the existing bounded `GeWeChannel` request behavior.
- Normalize errors to short codes and never preserve response bodies containing secrets.
- Parse metrics narrowly; do not add a Prometheus dependency.
- Allow `metricsUrl` and `publicBaseUrl` only from validated configuration.

**Step 4: Run tests and commit**

```bash
node src/wechat-reliability-probes.test.mjs
node src/im-channel-runtime.test.mjs
git add package.json src/wechat-reliability-probes*
git commit -m "feat: probe WeChat ingress layers"
```

### Task 4: Persist reliability state independently of the main process

**Files:**
- Create: `src/wechat-reliability-store.mjs`
- Create: `src/wechat-reliability-store.test.mjs`
- Modify: `package.json`

**Step 1: Write failing atomic-store tests**

With a temporary directory, assert:

- a missing file returns an empty `starting` state;
- save uses a temporary file and atomic rename;
- file mode is `0600`;
- invalid/truncated state is quarantined and replaced without crashing the supervisor;
- events append as bounded JSONL without message text, IDs, secrets, URLs, or tokens;
- only the newest 2,000 events or configured byte limit are retained.

**Step 2: Run and verify RED**

Run: `node src/wechat-reliability-store.test.mjs`

Expected: FAIL because the store does not exist.

**Step 3: Implement the store**

Default paths are resolved from `AIPRO_HOME`:

```text
data/wechat-reliability-state.json
logs/wechat-reliability-events.jsonl
```

The state must remain readable even when the main SQLite database is locked or unavailable.

**Step 4: Run tests and commit**

```bash
node src/wechat-reliability-store.test.mjs
git add package.json src/wechat-reliability-store*
git commit -m "feat: persist independent WeChat health state"
```

### Task 5: Add the Named Tunnel connector wrapper

**Files:**
- Create: `scripts/cloudflare-named-tunnel-supervisor.mjs`
- Create: `scripts/cloudflare-named-tunnel-supervisor.test.mjs`
- Modify: `scripts/gewe-tunnel-supervisor.mjs`
- Modify: `scripts/gewe-tunnel-supervisor.test.mjs`
- Modify: `package.json`

**Step 1: Write failing argument and secret-boundary tests**

Assert the Named Tunnel command:

```js
assert.deepEqual(namedTunnelArguments({ metricsAddress: '127.0.0.1:17657' }), [
  'tunnel', '--no-autoupdate',
  '--edge-ip-version', '4',
  '--metrics', '127.0.0.1:17657',
  'run',
]);
```

Also assert:

- no token appears in command arguments or logs;
- the child receives the token only in `TUNNEL_TOKEN`;
- invalid metrics addresses are rejected;
- SIGTERM/SIGINT are forwarded and shutdown is bounded;
- abnormal child exit makes the wrapper exit nonzero so launchd can restart it;
- Quick Tunnel remains available only when an explicit fallback mode is set.

**Step 2: Run and verify RED**

Run: `node scripts/cloudflare-named-tunnel-supervisor.test.mjs`

Expected: FAIL because the wrapper does not exist.

**Step 3: Implement the wrapper**

Read the remotely-managed Tunnel Token from Keychain using a configured service/account. Spawn `cloudflared` with inherited safe environment plus `TUNNEL_TOKEN`; redact errors before logging. Pin IPv4 based on the verified incident evidence. Do not modify callback configuration because the Named Tunnel hostname is stable.

**Step 4: Convert Quick Tunnel to explicit emergency fallback**

Preserve the current auto-URL alignment behavior only behind `AIPRO_ALLOW_QUICK_TUNNEL_FALLBACK=true`. Default execution must refuse Quick Tunnel for a production runtime mode.

**Step 5: Run tests and commit**

```bash
node scripts/cloudflare-named-tunnel-supervisor.test.mjs
node scripts/gewe-tunnel-supervisor.test.mjs
git add package.json scripts/cloudflare-named-tunnel-supervisor* scripts/gewe-tunnel-supervisor*
git commit -m "feat: run fixed Cloudflare Named Tunnel"
```

### Task 6: Implement the independent recovery supervisor

**Files:**
- Create: `scripts/wechat-reliability-supervisor.mjs`
- Create: `scripts/wechat-reliability-supervisor.test.mjs`
- Modify: `src/service-reconciler.mjs`
- Modify: `src/service-reconciler.test.mjs`
- Modify: `package.json`

**Step 1: Write failing recovery-sequence tests**

Inject fake probes, store, clock, random source and operations. Assert exact ordered actions:

```js
assert.deepEqual(calls, [
  'reconcile_tunnel',
  'wait_tunnel_ready',
  'align_callback',
  'verify_public_canary',
]);
```

Cover:

- local failure reconciles the main LaunchAgent first;
- tunnel failure never restarts the main service until the local layer actually fails;
- public-only failure restarts the Tunnel once and then aligns callback;
- provider authentication/offline failure records `provider_down` without restart storm;
- callback registration failure retries only registration;
- concurrent ticks share one recovery lock;
- abort stops pending waits immediately;
- circuit-open performs probes but no destructive action;
- recovery exceptions are persisted and do not crash the loop;
- process fatal error exits nonzero so launchd restarts the supervisor.

**Step 2: Run and verify RED**

Run: `node scripts/wechat-reliability-supervisor.test.mjs`

Expected: FAIL because the supervisor does not exist.

**Step 3: Generalize the existing service reconciler**

Keep existing APIs compatible, but allow expected service definitions for main and Tunnel labels. Verification callbacks must be condition-based rather than fixed sleeps. Existing Dashboard restart tests must remain green.

**Step 4: Implement the supervisor loop**

- Default interval: 15 seconds, configurable within 10–300 seconds.
- Read GeWe/canary/Tunnel secrets from Keychain only when needed.
- Use the policy from Task 1 and state store from Task 4.
- Invoke `/bin/launchctl` only through injected, bounded operations.
- Align callback using the existing `GeWeChannel.setCallback` with the fixed hostname plus callback path secret.
- Write only structured, redacted events.

**Step 5: Run tests and commit**

```bash
node src/service-reconciler.test.mjs
node scripts/wechat-reliability-supervisor.test.mjs
git add package.json src/service-reconciler* scripts/wechat-reliability-supervisor*
git commit -m "feat: self-heal WeChat ingress failures"
```

### Task 7: Replace false-green dashboard and CLI health

**Files:**
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `src/dashboard-server.mjs`
- Modify: `scripts/health-check.mjs`
- Modify: `dashboard/app.js`
- Modify: `dashboard/index.html`
- Modify: `dashboard/i18n.js`
- Modify: `dashboard/visual-contract.test.mjs`

**Step 1: Write failing model tests**

Prove that:

- account online + public callback failed is `degraded`;
- local/Tunnel/public/provider layers all healthy is `online`;
- provider down has a distinct label;
- stale reliability state is degraded even if old `connected=true` remains in SQLite;
- the legacy `connected` field cannot override factual ingress state.

Expected dashboard shape:

```js
assert.deepEqual(view.channels.wechat.ingress, {
  localListening: true,
  tunnelReady: true,
  activeConnections: 4,
  publicReachable: true,
  callbackRegistered: true,
  providerOnline: true,
});
```

**Step 2: Run and verify RED**

Run: `node src/dashboard-model.test.mjs`

Expected: FAIL because the model lacks `ingress` and still trusts `connected`.

**Step 3: Read the independent state in Dashboard and CLI health**

Use a short cache and fail closed when the state is missing, invalid or older than three probe intervals. Add issue codes:

```text
wechat_local_callback_unavailable
wechat_tunnel_unavailable
wechat_public_callback_unavailable
wechat_provider_unavailable
wechat_callback_registration_stale
wechat_recovery_circuit_open
```

Do not mark global health red for a disabled WeChat channel.

**Step 4: Update the UI**

Show six factual rows, last public success, last callback registration, recovery attempt, next retry and circuit state. Do not expose the hostname's private path or any identity.

**Step 5: Run tests and commit**

```bash
node src/dashboard-model.test.mjs
node dashboard/visual-contract.test.mjs
node scripts/health-check.mjs --json || test $? -eq 1
git add src/dashboard-model* src/dashboard-server.mjs scripts/health-check.mjs dashboard/app.js dashboard/index.html dashboard/i18n.js dashboard/visual-contract.test.mjs
git commit -m "feat: expose end-to-end WeChat health"
```

### Task 8: Build immutable Git-derived production releases

**Files:**
- Create: `scripts/production-release.mjs`
- Create: `scripts/production-release.test.mjs`
- Create: `scripts/build-production-release.mjs`
- Modify: `scripts/distribution-package.mjs`
- Modify: `package.json`

**Step 1: Write failing release-domain tests**

In a temporary repository/root, assert:

- a dirty source tree is rejected;
- a detached clean commit is accepted;
- release version contains short commit SHA and timestamp/tag;
- allowlisted runtime files are copied but `.git`, `.worktrees`, tests, logs, `config.local.json`, `data`, `outputs`, backups and security reports are excluded;
- every file appears in a SHA-256 manifest;
- the release directory becomes read-only after build;
- `current` and `previous` symlinks switch atomically;
- failed validation leaves both symlinks unchanged;
- rollback restores `previous` without deleting releases.

**Step 2: Run and verify RED**

Run: `node scripts/production-release.test.mjs`

Expected: FAIL because the release module does not exist.

**Step 3: Implement release primitives**

Default layout:

```text
~/Library/Application Support/AIPRO/releases/<version>
~/Library/Application Support/AIPRO/current
~/Library/Application Support/AIPRO/previous
```

Reuse the existing distribution allowlist where possible; do not duplicate two drifting file lists.

**Step 4: Implement the CLI**

`build-production-release.mjs` accepts explicit source, support root and commit/tag. `--dry-run` prints the release plan without writing. Production mode refuses a dirty source or unverified manifest.

**Step 5: Run tests and commit**

```bash
node scripts/production-release.test.mjs
node scripts/distribution-package.test.mjs
git add package.json scripts/production-release* scripts/build-production-release.mjs scripts/distribution-package.mjs
git commit -m "feat: build immutable production releases"
```

### Task 9: Generate isolated production LaunchAgents and prevent sleep

**Files:**
- Create: `scripts/install-production-services.mjs`
- Create: `scripts/install-production-services.test.mjs`
- Modify: `scripts/install-service.sh`
- Modify: `scripts/install-service.test.mjs`
- Modify: `scripts/install-dashboard-service.sh`
- Modify: `scripts/install-dashboard-service.test.mjs`
- Modify: `package.json`

**Step 1: Write failing plist-generation tests**

With temporary HOME/support/release roots and stub launchctl, assert four independent labels:

```text
com.local.aipro-main
com.local.aipro-dashboard
com.local.aipro-cloudflare-tunnel
com.local.aipro-wechat-reliability
```

Assert:

- ProgramArguments point through `Application Support/AIPRO/current`, never a development repository;
- main and supervisor receive `AIPRO_HOME`, `AIPRO_RESOURCE_ROOT` and `DIGITAL_EMPLOYEE_CONFIG`;
- logs point to `Application Support/AIPRO/logs`;
- cloudflared metrics use the fixed loopback port;
- the main service runs under `/usr/bin/caffeinate -s` so AC-powered idle sleep cannot stop callbacks;
- production install rejects a worktree path, dirty release, missing manifest or writable release;
- tests cannot invoke `/bin/launchctl` when a test flag is active;
- install archives legacy plist definitions but does not delete them until rollout passes.

**Step 2: Run and verify RED**

Run:

```bash
node scripts/install-production-services.test.mjs
node scripts/install-service.test.mjs
node scripts/install-dashboard-service.test.mjs
```

Expected: new production test fails because the installer does not exist.

**Step 3: Implement idempotent plist generation and reconciliation**

Write plists atomically with mode `0600`. Bootstrap in dependency order: main, Tunnel, reliability supervisor, Dashboard. Use unique test labels and injected launchctl. Preserve the existing service-reconciler checks.

**Step 4: Run tests and commit**

```bash
node scripts/install-production-services.test.mjs
npm run test:install-service
npm run test:stability
git add package.json scripts/install-production-services* scripts/install-service* scripts/install-dashboard-service*
git commit -m "feat: isolate production LaunchAgents"
```

### Task 10: Add isolated reliability fault injection

**Files:**
- Create: `scripts/wechat-reliability-smoke.mjs`
- Create: `scripts/wechat-reliability-smoke.test.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `package.json`

**Step 1: Write failing orchestration tests**

Inject fake process, Tunnel, public endpoint, provider and launchctl adapters. Assert the smoke script performs and reports:

1. kill local service → main reconciliation;
2. kill cloudflared → Tunnel reconciliation;
3. keep local healthy but break public route → detect false green;
4. callback drift → callback alignment;
5. DNS/timeouts → bounded retry and circuit open;
6. bad release → automatic rollback;
7. recovery → three-success healthy transition.

The smoke report contains only layer, action, elapsed time and result.

**Step 2: Run and verify RED**

Run: `node scripts/wechat-reliability-smoke.test.mjs`

Expected: FAIL because the smoke script does not exist.

**Step 3: Implement isolated smoke mode**

Require `--isolated-root`, ephemeral ports and an injected/stub launchctl. Refuse to run if any configured label equals a production label unless `--controlled-live` and an explicit confirmation token are both provided.

**Step 4: Add acceptance contracts**

Add mechanism contracts for:

- public callback fact overrides legacy connected status;
- bounded automatic recovery;
- provider-down classification;
- immutable production release boundary;
- production LaunchAgents never point at a worktree.

**Step 5: Run tests and commit**

```bash
node scripts/wechat-reliability-smoke.test.mjs
node src/mechanism-acceptance.test.mjs
git add package.json scripts/wechat-reliability-smoke* src/mechanism-acceptance.test.mjs
git commit -m "test: inject WeChat reliability failures"
```

### Task 11: Document provisioning, recovery and rollback

**Files:**
- Create: `docs/WECHAT_PRODUCTION_RUNBOOK.md`
- Modify: `README.md`
- Modify: `docs/提交验收单.md`

**Step 1: Write the runbook**

Document:

- Cloudflare Named Tunnel creation and fixed hostname mapping;
- least-privilege remotely-managed Tunnel Token storage in Keychain;
- required port 7844 TCP/UDP and IPv4 pinning;
- fixed metrics/canary ports and paths;
- Git branch → clean commit → release → current/previous lifecycle;
- health states, SLO and alert meanings;
- safe manual recovery through the shared coordinator;
- rollback to the previous Git-derived release;
- the GeWe no-replay reliability boundary;
- Quick Tunnel emergency fallback and its explicit no-SLA warning;
- later two-node replica/leader prerequisites.

Do not include the real account, email, zone, hostname path secret, token, app ID or contact identifiers.

**Step 2: Update acceptance documentation**

Require evidence for public canary, four Tunnel connections, callback registration, live receive/reply, automatic tunnel restart and release rollback.

**Step 3: Validate links and commit**

```bash
rg -n "trycloudflare|Named Tunnel|callback|rollback|Keychain" docs/WECHAT_PRODUCTION_RUNBOOK.md README.md docs/提交验收单.md
git diff --check
git add README.md docs/WECHAT_PRODUCTION_RUNBOOK.md docs/提交验收单.md
git commit -m "docs: add WeChat production runbook"
```

### Task 12: Run the full pre-deployment gate

**Files:**
- Modify only if a verified regression requires it.

**Step 1: Verify syntax and focused suites**

```bash
npm run check
node src/wechat-reliability-policy.test.mjs
node src/wechat-reliability-canary.test.mjs
node src/wechat-reliability-probes.test.mjs
node src/wechat-reliability-store.test.mjs
node scripts/cloudflare-named-tunnel-supervisor.test.mjs
node scripts/wechat-reliability-supervisor.test.mjs
node scripts/production-release.test.mjs
node scripts/install-production-services.test.mjs
node scripts/wechat-reliability-smoke.test.mjs
```

Expected: all commands exit 0.

**Step 2: Run full regression and acceptance**

Use the existing config only through `DIGITAL_EMPLOYEE_CONFIG`; never copy it into the worktree.

```bash
DIGITAL_EMPLOYEE_CONFIG=/absolute/path/to/config.local.json npm test
npm audit --audit-level=high
```

Expected: all tests, posttests and mechanism acceptance pass; no high/critical vulnerabilities.

**Step 3: Run isolated fault injection**

```bash
node scripts/wechat-reliability-smoke.mjs --isolated-root "$(mktemp -d)"
```

Expected: every injected failure is detected and recovered or intentionally circuit-broken; no production labels are touched.

**Step 4: Review the branch**

```bash
git status --short
git log --oneline --decorate main..HEAD
git diff --check main...HEAD
git diff --stat main...HEAD
```

Expected: only planned source, tests and docs; no secrets, runtime files or package-lock artifact unless deliberately adopted.

### Task 13: Provision the Named Tunnel and perform controlled rollout

**Files:**
- Runtime-only configuration under `~/Library/Application Support/AIPRO`; no Git secret files.

**Step 1: Provision Cloudflare production ingress**

Use the `cloudflare-deploy` skill and official Cloudflare workflow to:

- authenticate the existing Cloudflare account;
- create a remotely-managed Named Tunnel dedicated to AIPRO WeChat;
- map a fixed HTTPS hostname to `http://127.0.0.1:17656`;
- store only the connector token in macOS Keychain;
- verify Cloudflare reports the connector healthy with four connections.

Do not expose the token in shell history, process arguments, logs or Git.

**Step 2: Build the first production release**

From the reviewed clean commit/tag:

```bash
node scripts/build-production-release.mjs --source "$WORKTREE" --support-root "$AIPRO_SUPPORT_ROOT"
```

Verify the manifest and immutable release before changing `current`.

**Step 3: Install production services**

Run the production installer with the fixed callback hostname and Keychain service/account names. Confirm all four LaunchAgents point at the release, not the development repository.

**Step 4: Switch GeWe callback**

Start main and Named Tunnel, wait for local, metrics and public canary health, then register the fixed GeWe callback. Only after successful registration retire the Quick Tunnel LaunchAgent.

**Step 5: Controlled live fault injection**

Perform one action at a time and verify recovery evidence:

1. terminate cloudflared;
2. observe Tunnel restart and four connections;
3. observe public canary recover;
4. observe callback alignment succeed;
5. send one direct personal-WeChat test message;
6. confirm audit path `received → durable enqueue → replied`;
7. restart the main service and confirm no duplicate reply.

**Step 6: Validate production isolation and power assertion**

Confirm:

- `ps` commands and LaunchAgents contain only `Application Support/AIPRO/current` paths;
- the current release SHA matches the intended Git tag;
- logs/data/config are outside the release;
- the server holds the intended caffeinate assertion while the main service runs;
- Dashboard shows all factual layers healthy.

**Step 7: Validate rollback**

Deploy an isolated intentionally unhealthy candidate or use the test release root, confirm automatic rollback, then verify the known-good production release remains healthy.

**Step 8: Final production report**

Record only:

- deployed Git tag/SHA;
- release version;
- health-layer results and timestamps;
- recovery durations from the controlled tests;
- Quick Tunnel retirement state;
- remaining external limitation: GeWe provider availability/redelivery.

Never include credentials, account identifiers, contact IDs, message text or callback secrets.
