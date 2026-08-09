# Group Host Robustness Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make selected-group host mode fail safely and recover automatically under configuration changes, stale work, concurrent chat activity, unsafe AI output, state faults, and delivery failures.

**Architecture:** Keep the existing SQLite candidate queue and single runtime worker. Add deterministic processing-policy guards, a no-penalty durable defer transition, a testable worker-iteration boundary, and redacted runtime health state; all uncertain conditions resolve to silence.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, existing AI runtime and channel delivery abstractions, Node assert tests.

---

### Task 1: Deterministic processing safety policy

**Files:**
- Modify: `src/group-host-mode.mjs`
- Modify: `src/group-host-mode.test.mjs`

**Step 1: Write failing policy tests**

Add cases proving that processing suppresses a queued candidate when host mode is
disabled or its chat is no longer allowlisted, expires a candidate older than ten
minutes, and defers when a later group message is less than twelve seconds old.
The defer result must include the exact future `dueAtMs`.

Add reply cases that reject mass mentions, mention markup, URLs, Markdown links,
code fences, fake consensus, and first-person promises or mutations. Add prompt
assertions that candidate and transcript content are delimited as untrusted data.

**Step 2: Run the test to verify it fails**

Run: `node src/group-host-mode.test.mjs`

Expected: FAIL because processing-time policy and unsafe-output checks do not exist.

**Step 3: Implement the minimal policy**

Export constants:

```js
export const GROUP_HOST_MAX_AGE_MS = 10 * 60_000;
export const GROUP_HOST_QUIET_WINDOW_MS = 12_000;
```

Extend `processGroupHostCandidate` with `enabled`, `allowlisted`, `nowMs`,
`maxAgeMs`, and `quietWindowMs`. Apply policy in this order: runtime policy,
expiry, takeover/cooldown, human pickup, recent activity defer, classifier,
generation, safety gate, send.

Extend `normalizeGroupHostReply` with deterministic unsafe-content patterns and
wrap all message content in explicit untrusted-data delimiters in both prompts.

**Step 4: Run the test to verify it passes**

Run: `node src/group-host-mode.test.mjs`

Expected: `GROUP_HOST_MODE_TEST_OK`.

**Step 5: Commit**

```bash
git add src/group-host-mode.mjs src/group-host-mode.test.mjs
git commit -m "fix: fail closed on unsafe group host candidates"
```

### Task 2: Durable no-penalty defer transition

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`

**Step 1: Write the failing state test**

Schedule and claim a candidate, reschedule it for a later quiet-window deadline,
and prove it cannot be reclaimed early. Prove the reschedule reverses the claim's
attempt increment so repeated activity deferrals do not consume the three
operational-failure retries.

**Step 2: Run the test to verify it fails**

Run: `node src/state.test.mjs`

Expected: FAIL because `rescheduleGroupHostCandidate` does not exist.

**Step 3: Implement the transition**

Add:

```js
rescheduleGroupHostCandidate(messageId, dueAtMs, resolution, nowMs = Date.now())
```

It updates only a `processing` row, returns it to `pending`, sets the future due
time, clears `last_error`, stores a bounded resolution, and decrements `attempts`
with a floor of zero.

**Step 4: Run the state test to verify it passes**

Run: `node src/state.test.mjs`

Expected: `STATE_TEST_OK`.

**Step 5: Commit**

```bash
git add src/state.mjs src/state.test.mjs
git commit -m "feat: reschedule active group host candidates safely"
```

### Task 3: Self-healing worker iteration and redacted failures

**Files:**
- Create: `src/group-host-worker.mjs`
- Create: `src/group-host-worker.test.mjs`
- Modify: `package.json`

**Step 1: Write failing worker tests**

Cover idle claims, successful handling, claim exceptions, processing exceptions,
bounded retry timing, dead-letter results, and redacted error categories. Include
an error whose message contains private chat text and assert that neither the
result nor retry callback receives that text.

**Step 2: Run the test to verify it fails**

Run: `node src/group-host-worker.test.mjs`

Expected: FAIL because the worker module does not exist.

**Step 3: Implement one bounded iteration**

Export:

```js
redactGroupHostError(error, stage) -> safe category
runGroupHostWorkerIteration({ nowMs, claim, handle, retry, maxAttempts })
  -> { action, waitMs, candidate?, result?, retry?, errorCode? }
```

The function never throws for claim or processing failures. Claim failures return
a two-second backoff. Processing failures invoke the supplied retry callback with
only a safe category and use 15/30/60-second bounded retry delays.

**Step 4: Run the worker test to verify it passes**

Run: `node src/group-host-worker.test.mjs`

Expected: `GROUP_HOST_WORKER_TEST_OK`.

**Step 5: Commit**

```bash
git add src/group-host-worker.mjs src/group-host-worker.test.mjs package.json
git commit -m "feat: isolate a self-healing group host worker iteration"
```

### Task 4: Runtime revalidation, defer handling, and health state

**Files:**
- Modify: `src/index.mjs`
- Modify: `scripts/health-check.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write failing mechanism acceptance cases**

Add cases for removed-allowlist suppression, stale-candidate suppression, recent
activity no-penalty defer, unsafe reply rejection, and redacted worker retry.

**Step 2: Run focused tests to verify they fail**

Run:

```bash
node src/mechanism-acceptance.test.mjs
node src/group-host-worker.test.mjs
```

Expected: FAIL on missing runtime contracts.

**Step 3: Integrate the hardened state machine**

Pass current enablement, allowlist membership, and `nowMs` into
`processGroupHostCandidate`. When it returns `deferred`, call
`rescheduleGroupHostCandidate` instead of completing the row.

Replace the loop's unguarded claim with `runGroupHostWorkerIteration`. Record only
`errorCode` in retry state, audit, and logs. After every iteration publish
`health/group_host` with aggregate queue counts, last-check time, last resolution,
and the latest safe error category. Clear transient worker error state after a
successful idle or handled iteration.

Extend `scripts/health-check.mjs` to expose group-host queue and worker metrics and
report `group_host_worker_error` or `group_host_dead` when applicable.

**Step 4: Run focused verification**

Run:

```bash
node src/group-host-mode.test.mjs
node src/group-host-worker.test.mjs
node src/state.test.mjs
node src/mechanism-acceptance.test.mjs
node --check src/index.mjs
```

Expected: all commands exit zero.

**Step 5: Commit**

```bash
git add src/index.mjs scripts/health-check.mjs src/mechanism-acceptance.test.mjs
git commit -m "fix: harden group host runtime recovery"
```

### Task 5: Full verification and deployment

**Files:**
- Review only: `config.local.json`

**Step 1: Run the complete suite**

Run: `npm test`

Expected: exit zero with all mechanism acceptance cases passing.

**Step 2: Verify tracked scope**

Run: `git diff --check` and `git status --short`.

Expected: only hardening files and committed plan documents are present in the
feature worktree; local group IDs and credentials remain uncommitted.

**Step 3: Integrate without overwriting local dirty work**

Push the feature branch, preserve the existing tracked local modifications, apply
the verified hardening commits to `main`, then restore those local modifications.

**Step 4: Re-run the complete suite on merged `main`**

Run: `npm test`

Expected: exit zero.

**Step 5: Push, restart, and verify**

Push `main`, run `npm run test:install-service`, reinstall the LaunchAgent, and
run `node scripts/health-check.mjs`. Confirm the service is running, host mode is
active for exactly one allowlisted group, SQLite integrity is `ok`, and there are
no new group-host errors. Do not send a synthetic group message.
