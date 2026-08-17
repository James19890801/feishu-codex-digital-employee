# Service Stability Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent test/install activity from corrupting the production LaunchAgent and make every restart repair definition drift, stale locks, and incomplete recovery.

**Architecture:** Keep launchd as the single process supervisor, but add a tested reconciliation layer in front of every restart. Separate pure assessment/orchestration from macOS command adapters so fault injection never touches real launchd. Add a bounded shutdown guard and CI gates without changing message behavior.

**Tech Stack:** Node.js ESM, zsh LaunchAgent installers, macOS launchctl, node:test/assert-style executable tests, GitHub Actions, pnpm.

---

### Task 1: Isolate installer tests from production launchd

**Files:**
- Modify: `scripts/install-service.sh`
- Modify: `scripts/install-dashboard-service.sh`
- Modify: `scripts/install-service.test.mjs`
- Create: `scripts/install-dashboard-service.test.mjs`

**Step 1: Write the failing tests**

Create two launchctl executables: an injected stub that records calls and a PATH trap that records `REAL_PATH_LAUNCHCTL_USED`. Run each installer with `ACHONG_LAUNCHCTL=<injected stub>`, `ACHONG_SERVICE_RETRIES=1`, and `ACHONG_SERVICE_WAIT_SECONDS=0`. Assert the injected log contains `bootout/bootstrap/kickstart` as appropriate and the trap log is empty.

**Step 2: Run tests and verify RED**

Run:

```bash
node scripts/install-service.test.mjs
node scripts/install-dashboard-service.test.mjs
```

Expected: FAIL because both scripts currently resolve `launchctl` through PATH and ignore `ACHONG_LAUNCHCTL`.

**Step 3: Implement explicit command injection**

In each installer add:

```zsh
LAUNCHCTL="${ACHONG_LAUNCHCTL:-/bin/launchctl}"
SERVICE_RETRIES="${ACHONG_SERVICE_RETRIES:-10}"
SERVICE_WAIT_SECONDS="${ACHONG_SERVICE_WAIT_SECONDS:-1}"
```

Replace all `launchctl` calls with `"$LAUNCHCTL"`, and fixed brace loops/sleeps with `seq` plus the injected bounds. Production therefore uses the absolute system binary; tests use only the stub.

**Step 4: Run tests and verify GREEN**

Run the two test files. Expected: both print their `*_TEST_OK` marker; trap logs remain empty.

**Step 5: Commit**

```bash
git add scripts/install-service.sh scripts/install-dashboard-service.sh \
  scripts/install-service.test.mjs scripts/install-dashboard-service.test.mjs
git commit -m "fix: isolate launch agent installer tests"
```

### Task 2: Reconcile loaded service definitions before restarting

**Files:**
- Create: `src/service-reconciler.mjs`
- Create: `src/service-reconciler.test.mjs`
- Modify: `src/dashboard-server.mjs`

**Step 1: Write failing pure tests**

Define the desired API:

```js
const loaded = parseLaunchctlPrint(output);
assert.equal(assessLaunchAgent(loaded, expected).state, 'drifted');

const result = await reconcileLaunchAgent({
  inspect, inspectLock, archiveStaleLock, bootout, bootstrap, kickstart, verify,
  expected,
});
assert.equal(result.action, 'rebootstrap');
```

Cover:

- matching plist/workdir/entrypoint -> `kickstart`;
- temporary plist/workdir -> `bootout`, stale-lock archive, `bootstrap`;
- missing service -> `bootstrap`;
- live expected lock while service is missing -> refuse duplicate start;
- verification failure -> bounded error, never an unbounded restart loop.

**Step 2: Run and verify RED**

Run `node src/service-reconciler.test.mjs`.
Expected: FAIL because the module does not exist.

**Step 3: Implement the pure parser and orchestrator**

Implement exports:

```js
export function parseLaunchctlPrint(text) { /* path, state, program, workdir, pid */ }
export function assessLaunchAgent(loaded, expected) { /* healthy|missing|drifted */ }
export function assessServiceLock(lock, expected) { /* absent|stale|active_expected|foreign */ }
export async function reconcileLaunchAgent(dependencies) { /* one recovery action + verify */ }
```

The orchestrator must never call shell commands directly. It accepts injected functions, performs at most one kickstart or one rebootstrap per call, and always invokes `verify` once.

**Step 4: Verify GREEN**

Run `node src/service-reconciler.test.mjs`. Expected: all branches pass.

**Step 5: Integrate Dashboard adapters**

In `dashboard-server.mjs`:

- inspect `gui/<uid>/<label>` using `/bin/launchctl print`;
- compare against `$HOME/Library/LaunchAgents/<label>.plist`, `config.workdir`, and `src/index.mjs`;
- read `service.lock`, validate PID liveness and `/bin/ps -p <pid> -o command=` identity;
- archive a stale lock with a timestamped sibling name;
- healthy definition: `kickstart -k`;
- missing/drifted definition: best-effort `bootout`, then `bootstrap` from the formal plist;
- verify for up to 35 seconds that process is alive and, when WeChat is enabled, callback listening/registered and connected.

Keep `/api/restart` response compatible, but return the reconciliation action for auditability.

**Step 6: Run targeted tests and commit**

```bash
node src/service-reconciler.test.mjs
node src/dashboard-api-security.test.mjs
node src/channel-configuration.test.mjs
git add src/service-reconciler.mjs src/service-reconciler.test.mjs src/dashboard-server.mjs
git commit -m "fix: self-heal launch agent definition drift"
```

### Task 3: Add a bounded main-process shutdown

**Files:**
- Create: `src/shutdown-guard.mjs`
- Create: `src/shutdown-guard.test.mjs`
- Modify: `src/index.mjs`

**Step 1: Write the failing test**

Use injected timers and exit callback:

```js
const guard = createShutdownGuard({ timeoutMs: 15_000, setTimeoutImpl, clearTimeoutImpl, forceExit });
guard.start('SIGTERM');
triggerTimer();
assert.deepEqual(exits, [1]);
```

Also assert `complete()` cancels the timer and repeated `start()` does not create multiple timers.

**Step 2: Run and verify RED**

Run `node src/shutdown-guard.test.mjs`.
Expected: FAIL because the module does not exist.

**Step 3: Implement and integrate**

Create a small guard that logs one timeout and invokes `process.exit(1)` only after the deadline. Start it at the beginning of `stopGracefully`; call `complete()` in `main()`'s final cleanup after the database and singleton lock are released. Keep the existing child-process termination behavior unchanged.

**Step 4: Verify GREEN and commit**

```bash
node src/shutdown-guard.test.mjs
node --check src/index.mjs
git add src/shutdown-guard.mjs src/shutdown-guard.test.mjs src/index.mjs
git commit -m "fix: bound main process shutdown time"
```

### Task 4: Improve configuration parse failures without changing defaults

**Files:**
- Modify: `src/config.test.mjs`
- Modify: `src/config.mjs`

**Step 1: Write the failing test**

Spawn a child process with `DIGITAL_EMPLOYEE_CONFIG` pointing at invalid JSON. Assert non-zero exit and stderr containing both the absolute file path and a Chinese `解析失败` explanation.

**Step 2: Run and verify RED**

Run `node src/config.test.mjs`.
Expected: FAIL because the current raw `SyntaxError` does not include the required contextual message.

**Step 3: Add contextual parsing**

Wrap only `JSON.parse(readFileSync(...))` and throw:

```js
throw new Error(`配置文件 ${configPath} 解析失败：${error.message}\n请检查 JSON 格式。`, { cause: error });
```

Do not change `pollIntervalMs`, `digitalTwinLabel`, or other product defaults.

**Step 4: Verify GREEN and commit**

```bash
node src/config.test.mjs
git add src/config.mjs src/config.test.mjs
git commit -m "fix: make configuration parse failures actionable"
```

### Task 5: Add CI stability and dependency gates

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `package.json`

**Step 1: Add a local stability command**

Add `test:stability` containing installer isolation, reconciler, shutdown guard, singleton lock, dashboard security, and configuration tests. Add the new modules to `npm run check`.

**Step 2: Add CI**

Use Node 24 and pnpm with:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm audit --audit-level=high
- run: npm run check
- run: npm test
```

Do not put credentials in the workflow. Tests use fixtures and injected stubs.

**Step 3: Verify locally and commit**

```bash
npm run test:stability
pnpm audit --audit-level=high
git add .github/workflows/ci.yml package.json
git commit -m "ci: gate stability and high severity dependencies"
```

### Task 6: Full verification and controlled deployment

**Files:**
- Verify all changed files
- Update no business data

**Step 1: Static and targeted verification**

```bash
npm run check
npm run test:stability
```

Expected: exit 0.

**Step 2: Full regression**

```bash
npm test
```

Expected: all suites and 129 mechanism acceptance checks pass.

**Step 3: Review changes**

```bash
git diff --check main...HEAD
git status --short
```

Expected: no whitespace errors; only planned files differ.

**Step 4: Integrate without overwriting user changes**

Cherry-pick the isolated commits into the main workspace one at a time. If `package.json` overlaps the user's local-wiki change, preserve both script additions explicitly and verify the resulting JSON.

**Step 5: Reinstall and fault-check the real service**

Run the formal installer once, then verify:

```bash
launchctl print gui/$(id -u)/com.local.feishu-codex-digital-employee
lsof -nP -iTCP:17656 -sTCP:LISTEN
curl -sS http://127.0.0.1:17655/api/status
```

Expected: loaded plist/workdir/entrypoint are formal, main PID is alive, WeChat callback is listening/registered/connected. Perform one controlled restart through the Dashboard and repeat the checks.

**Step 6: Final commit if integration conflict resolution was needed**

Commit only planned conflict-resolution changes; do not stage unrelated user work.
