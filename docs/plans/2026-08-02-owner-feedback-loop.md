# Owner-only IM Feedback Loop Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an Owner-gated Multica write path and a safe IM feedback intake flow that registers every clarified report, dispatches only Owner reports, and synchronizes progress to the originating conversation.

**Architecture:** Put identity checks in a pure access module and enforce them both at routing and capability boundaries. Keep non-Owner registration in a separate constrained workflow that always creates an unassigned backlog Issue. Persist registration and Owner dispatch state in SQLite so duplicate messages reconcile to one Issue and failed dispatches retry without unsafe execution.

**Tech Stack:** Node.js ESM, built-in `node:assert`, `node:sqlite`, existing Multica CLI adapter, existing pending-action store and synchronizer.

---

### Task 1: Centralize Owner authorization

**Files:**
- Create: `src/multica-access.mjs`
- Create: `src/multica-access.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Test Feishu Owner equality, DingTalk self-chat plus configured Owner equality, ordinary contacts, missing configuration, and forged self-chat metadata from a different sender.

**Step 2: Run test to verify it fails**

Run: `node src/multica-access.test.mjs`
Expected: FAIL because `multica-access.mjs` does not exist.

**Step 3: Write minimal implementation**

Export `isAuthorizedMulticaOwner(context, config)` and `requireMulticaOwner(context, config)`. Normalize DingTalk identities to the `dingtalk:<open-id>` representation already produced by IM adapters.

**Step 4: Run test to verify it passes**

Run: `node src/multica-access.test.mjs`
Expected: `MULTICA_ACCESS_TEST_OK`.

### Task 2: Persist feedback registration and dispatch outbox

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`

**Step 1: Write failing state tests**

Cover stable registration lookup, idempotent Issue binding, pending dispatch enqueue, due selection, retry scheduling, completion, and dead-letter transition.

**Step 2: Run test to verify it fails**

Run: `node src/state.test.mjs`
Expected: FAIL because feedback registration/outbox methods are absent.

**Step 3: Add schema and minimal methods**

Add `multica_feedback_registration` keyed by registration key and `multica_dispatch_outbox` keyed by Issue ID. Store no credentials; cap errors and payload sizes; retain terminal records for deduplication and audit.

**Step 4: Run test to verify it passes**

Run: `node src/state.test.mjs`
Expected: `STATE_TEST_OK`.

### Task 3: Implement constrained feedback registration and dispatch

**Files:**
- Create: `src/multica-feedback.mjs`
- Create: `src/multica-feedback.test.mjs`
- Modify: `package.json`

**Step 1: Write failing workflow tests**

Cover feedback recognition, exactly one clarification question, cancel, structured description, non-Owner unassigned backlog creation, Owner Squad dispatch, duplicate registration reuse, creation success plus dispatch failure, and later dispatch retry.

**Step 2: Run test to verify it fails**

Run: `node src/multica-feedback.test.mjs`
Expected: FAIL because the workflow module is absent.

**Step 3: Implement minimal workflow**

Create a stable registration key from channel/chat/source message; always create `backlog` without assignee; bind and subscribe immediately; enqueue Owner dispatch; update to `{ assignee: ownerSquad, status: 'todo' }`; leave failures pending with exponential backoff and dead-letter after a bounded count.

**Step 4: Run test to verify it passes**

Run: `node src/multica-feedback.test.mjs`
Expected: `MULTICA_FEEDBACK_TEST_OK`.

### Task 4: Gate every generic Multica write and execution entry

**Files:**
- Modify: `src/multica-capability.mjs`
- Modify: `src/multica-capability.test.mjs`
- Modify: `src/multica-work-lifecycle.mjs`
- Modify: `src/multica-work-lifecycle.test.mjs`

**Step 1: Write failing authorization tests**

Assert non-Owner cannot prepare or apply create/update/comment, cannot assign through an update, and cannot begin/run Issue work. Assert Owner reads and writes continue to work. Assert apply-time reauthorization blocks a stolen pending confirmation.

**Step 2: Run tests to verify they fail**

Run: `node src/multica-capability.test.mjs && node src/multica-work-lifecycle.test.mjs`
Expected: FAIL on missing authorization enforcement.

**Step 3: Add defense-in-depth guards**

Inject `authorizeWrite` into both classes. Require it during mutation preview, mutation apply, and lifecycle begin. Keep read/follow/sync behavior unchanged.

**Step 4: Run tests to verify they pass**

Run: `node src/multica-capability.test.mjs && node src/multica-work-lifecycle.test.mjs`
Expected: both success markers.

### Task 5: Wire the end-to-end IM flow

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `scripts/health-check.mjs`
- Modify: `src/dashboard-model.mjs`
- Modify: relevant focused tests

**Step 1: Add failing integration-focused tests**

Test the pure routing helpers used by `index.mjs`: initial feedback creates pending clarification only, cancellation clears it, clarification invokes registration, generic non-Owner writes return an Owner-only response, and dispatch retry health is exposed.

**Step 2: Run focused tests and verify expected failures**

Run each changed test file directly.

**Step 3: Integrate the workflow**

Instantiate access and feedback services from configuration. Handle pending feedback before generic Multica routing; detect new feedback before ordinary AI handling; call dispatch delivery from the existing Multica loop. Use `multicaOwnerSquad` with default `詹老师的开发团伙`. Include pending/dead dispatch counts in health data.

**Step 4: Run focused tests until green**

Expected: all focused success markers and no assertion failures.

### Task 6: Document and verify the complete acceptance surface

**Files:**
- Modify: `README`
- Modify: `package.json` if new tests are not yet listed

**Step 1: Update operator documentation**

Replace the previous requester-confirmed Multica write policy with Owner-only writes and document the controlled feedback exception, safe backlog behavior, Squad dispatch, retries, and original-conversation synchronization.

**Step 2: Run full verification**

Run: `npm test`
Expected: every test script exits zero.

Run: `npm run check`
Expected: syntax, Swift, config, and Python checks exit zero.

Run: `npm run health`
Expected: health script exits zero and reports healthy; if the live runtime is stale, report that external runtime state separately and do not misstate it as a code failure.

Run: `git diff --check`
Expected: no output.

**Step 3: Review the acceptance checklist**

Confirm with tests that every generic write and work entry is Owner-gated; feedback always asks one question; cancellation writes nothing; non-Owner creates one unassigned backlog; Owner dispatches to the configured Squad; failed dispatch remains safe and retries; creation receipt and later sync include the Multica link.
