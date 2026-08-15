# WeChat Moments Like-First Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the personal-WeChat worker like every eligible new Moment once and comment whenever the content supports a specific, truthful response.

**Architecture:** Extend the GeWe adapter with a serialized, non-retrying like mutation. Extend the existing durable Moments worker with a separate like budget and idempotency key, preserving reply priority and the no-history baseline.

**Tech Stack:** Node.js ESM, GeWe REST API, SQLite-backed `AgentState`, existing mutation execution ledger.

---

### Task 1: Add the GeWe like mutation

**Files:**
- Modify: `src/im-channel-runtime.test.mjs`
- Modify: `src/im-channel-runtime.mjs`

1. Add a failing adapter test for `likeMoment({snsId, wxid})`.
2. Run `node src/im-channel-runtime.test.mjs` and verify it fails because the method is missing.
3. Implement a serialized call to `/gewe/v2/api/sns/likeSns` with `operType: 1` and no automatic retry.
4. Run the adapter test and verify it passes.

### Task 2: Add durable like-first behavior

**Files:**
- Modify: `src/wechat-moments-engagement.test.mjs`
- Modify: `src/wechat-moments-engagement.mjs`

1. Add failing worker tests for like-before-comment, like-only on skipped comments, no historical actions, and replay idempotency.
2. Run `node src/wechat-moments-engagement.test.mjs` and verify the expected failures.
3. Add persisted liked IDs, a daily 30-like budget, and a distinct `wechat_moments_like` execution key.
4. Run the worker tests and verify they pass.

### Task 3: Verify and deploy

**Files:**
- Modify only if required by tests: `src/index.mjs`, configuration files.

1. Run focused adapter, worker, and mechanism-acceptance tests.
2. Run `npm run check && npm test && git diff --check`.
3. Commit, fast-forward the active branch, restart the LaunchAgent, and inspect new audit events.
4. Push `HEAD` to GitHub `main` and verify the remote commit hash.
