# WeChat Moments Human-like Delay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Delay every personal-WeChat Moments like and comment with restart-safe, non-round, human-like timing.

**Architecture:** `WeChatMomentsEngagement` will persist sanitized pending interactions in its existing worker state and maintain one timeout for the earliest due action. Scanning schedules work without blocking; the due-action runner revalidates connectivity and relies on the existing mutation idempotency layer before writing to GeWe.

**Tech Stack:** Node.js ES modules, built-in SQLite state store, injected timers/randomness, Node assert tests.

---

### Task 1: Deterministic human-delay policy

**Files:**
- Modify: `src/wechat-moments-engagement.test.mjs`
- Modify: `src/wechat-moments-engagement.mjs`

**Step 1: Write the failing test**

Add assertions for an exported `momentsInteractionDelayMs({ kind, text, random })` policy:

- like values remain within 31.3–73.7 seconds;
- proactive comments exceed 71.3 seconds plus typing time;
- thread replies exceed 77.3 seconds plus typing time;
- longer comments receive a longer delay for the same random input;
- returned millisecond values do not land on a 5-second boundary.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: FAIL because `momentsInteractionDelayMs` is missing.

**Step 3: Write minimal implementation**

Implement a bounded random interpolation helper, Unicode character count, typing-time calculation, and non-round millisecond jitter. Export only the policy function needed by tests.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: PASS.

### Task 2: Persist and normalize delayed interactions

**Files:**
- Modify: `src/wechat-moments-engagement.test.mjs`
- Modify: `src/wechat-moments-engagement.mjs`

**Step 1: Write the failing test**

Schedule a like and comment with fake timers, reopen the same SQLite state, and assert that both normalized pending items retain safe bounded fields and unique hashed keys. Add malformed-state coverage proving invalid and expired entries are dropped.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: FAIL because worker state does not preserve pending interactions.

**Step 3: Write minimal implementation**

Extend `normalizedWorkerState` with a bounded `pendingInteractions` list and add scheduling/dedup helpers. Include pending reservations when checking daily budgets.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: PASS.

### Task 3: Execute only when due

**Files:**
- Modify: `src/wechat-moments-engagement.test.mjs`
- Modify: `src/wechat-moments-engagement.mjs`

**Step 1: Write the failing test**

Use injected `setTimeoutImpl`, `clearTimeoutImpl`, `now`, and `random` to prove:

- scan schedules but does not immediately call `likeMoment` or `commentMoment`;
- only one earliest timeout exists;
- invoking it before due does not write;
- invoking it at due writes exactly once and removes the pending item;
- later items remain scheduled.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: FAIL because scan still writes immediately.

**Step 3: Write minimal implementation**

Split comment generation/scheduling from comment mutation. Add `scheduleWake`, `runDueInteractions`, and per-kind execution methods using `executeMutationOnce`. Ensure audit details contain only hashes and timing numbers.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: PASS.

### Task 4: Restart recovery and lifecycle safety

**Files:**
- Modify: `src/wechat-moments-engagement.test.mjs`
- Modify: `src/wechat-moments-engagement.mjs`

**Step 1: Write the failing test**

Persist an overdue action, construct a new worker, call `start()`, and assert it is re-jittered 17.3–42.7 seconds instead of running immediately. Assert `stop()` clears both the periodic interval and wake timeout.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: FAIL because restart recovery and wake-timer cleanup do not exist.

**Step 3: Write minimal implementation**

Inject timeout functions, re-jitter overdue work during startup, schedule the earliest due item, and clear the wake timer during stop.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: PASS.

### Task 5: Regression verification and deployment

**Files:**
- Verify: `src/wechat-moments-engagement.mjs`
- Verify: `src/im-channel-runtime.mjs`
- Verify: `src/index.mjs`

**Step 1: Run focused tests**

Run:

```bash
node src/wechat-moments-engagement.test.mjs
node src/im-channel-runtime.test.mjs
node src/mutation-execution.test.mjs
node src/channel-configuration.test.mjs
node --check src/wechat-moments-engagement.mjs
```

Expected: all pass.

**Step 2: Restart the managed service**

Run: `launchctl kickstart -k "gui/$(id -u)/com.local.feishu-codex-digital-employee"`

Expected: LaunchAgent returns to `running`.

**Step 3: Verify channel health and scheduler state**

Confirm personal WeChat remains authenticated, connected, callback-listening and callback-registered, with no current channel error. Confirm no queued interaction is executed during the restart itself.

