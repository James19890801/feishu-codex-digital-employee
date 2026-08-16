# WeChat Moments Publisher Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Publish one local-Wiki-grounded AI-and-process-management thought immediately on first activation, one more in today's remaining evening window, and two non-duplicative posts in persistent random windows on later days.

**Architecture:** Add a validated GeWe text-Moments adapter method and a persistent `WeChatMomentsPublisher` worker inside the existing personal-WeChat lifecycle. The worker owns day planning, local-Wiki-grounded generation, privacy and semantic-repeat gates, mutation idempotency, retry spacing, and audit events.

**Tech Stack:** Node.js ESM, native SQLite through `AgentState`, existing GeWe REST adapter, `AiRuntimeClient`, local Wiki retrieval, privacy-boundary helpers, semantic-repeat helpers, and `executeMutationOnce`.

---

### Task 1: GeWe text-Moments write primitive

**Files:**
- Modify: `src/im-channel-runtime.mjs`
- Modify: `src/im-channel-runtime.test.mjs`

**Step 1: Write the failing test**

Add an adapter test that calls `publishTextMoment({ content })` and expects a POST to `/gewe/v2/api/sns/sendTextSns` with the configured `appId`, public visibility, empty allow/deny/at/tag lists, and validated content. Add rejection cases for empty, overlong, and control-character content.

**Step 2: Run test to verify it fails**

Run: `node src/im-channel-runtime.test.mjs`

Expected: FAIL because `publishTextMoment` does not exist.

**Step 3: Write minimal implementation**

Add `publishTextMoment` to `GeWeChannel`. Validate 1–500 characters, reuse `momentTail`, wait at least three seconds after the previous Moments mutation, call `sendTextSns`, update `lastMomentWriteAt`, and return the API result.

**Step 4: Run test to verify it passes**

Run: `node src/im-channel-runtime.test.mjs`

Expected: `IM_CHANNEL_RUNTIME_TEST_OK`.

**Step 5: Commit**

```bash
git add src/im-channel-runtime.mjs src/im-channel-runtime.test.mjs
git commit -m "feat: add GeWe text Moments publishing"
```

### Task 2: Persistent daily planning and content gates

**Files:**
- Create: `src/wechat-moments-publisher.mjs`
- Create: `src/wechat-moments-publisher.test.mjs`

**Step 1: Write failing pure-behavior tests**

Cover:

- first activation at midday creates an immediate slot and one evening slot;
- a normal day creates one time in each configured window;
- repeated reads preserve the same random times;
- expired slots are skipped instead of backfilled;
- generated content requires non-empty local knowledge;
- private leakage, long verbatim overlap, malformed JSON, and semantic repeats are rejected;
- a valid grounded 100–220 character post is accepted.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-moments-publisher.test.mjs`

Expected: FAIL because the publisher module does not exist.

**Step 3: Implement pure helpers and state normalization**

Implement Shanghai-local day calculations without external dependencies, persisted slot plans, a bounded topic pool, strict JSON parsing, `abstractPrivateKnowledge`, `protectedKnowledgeLeak`, `hasLongVerbatimOverlap`, and `compareSemanticTopics` checks. Retain at most 90 days and 180 public post texts.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-moments-publisher.test.mjs`

Expected: `WECHAT_MOMENTS_PUBLISHER_TEST_OK` for pure tests.

**Step 5: Commit**

```bash
git add src/wechat-moments-publisher.mjs src/wechat-moments-publisher.test.mjs
git commit -m "feat: plan grounded daily Moments posts"
```

### Task 3: Idempotent worker execution

**Files:**
- Modify: `src/wechat-moments-publisher.mjs`
- Modify: `src/wechat-moments-publisher.test.mjs`

**Step 1: Write failing worker tests**

With fake clock, state, Wiki retriever, AI generator, and GeWe channel, prove:

- startup publishes the first activation slot once;
- concurrent ticks coalesce;
- a successful slot does not replay after restart;
- an ambiguous mutation never replays;
- generation failures retry no sooner than five minutes and stop after three attempts;
- the daily hard cap is two;
- `stop()` clears the timer.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-moments-publisher.test.mjs`

Expected: FAIL on missing lifecycle behavior.

**Step 3: Implement the worker**

Add `start`, `stop`, `tick`, serialized tail handling, due-slot selection, knowledge retrieval, strict generation, retry scheduling, `executeMutationOnce`, state persistence, and content-free audit events.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-moments-publisher.test.mjs`

Expected: all publisher tests pass.

**Step 5: Commit**

```bash
git add src/wechat-moments-publisher.mjs src/wechat-moments-publisher.test.mjs
git commit -m "feat: execute idempotent daily Moments posts"
```

### Task 4: Configuration and live lifecycle wiring

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `config.example.json`
- Modify: `config.distribution.json`
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify locally only: `config.local.json`

**Step 1: Write failing configuration and acceptance tests**

Require a disabled-by-default publisher flag, a 60-second scheduler interval, two fixed window strings, the worker import and lifecycle start/stop, local Wiki retrieval with channel `wechat-moments-publisher`, and AI runtime generation.

**Step 2: Run tests to verify they fail**

Run:

```bash
node src/config.test.mjs
node src/mechanism-acceptance.test.mjs
```

Expected: FAIL on missing configuration and lifecycle wiring.

**Step 3: Implement configuration and wiring**

Add bounded configuration, instantiate the worker after the GeWe channel is online, pass the Wiki retriever and AI runtime, stop it on channel failure and graceful shutdown, and log activation without logging generated content. Set only the ignored local configuration to enabled.

**Step 4: Run focused verification**

Run:

```bash
node src/config.test.mjs
node src/im-channel-runtime.test.mjs
node src/wechat-moments-publisher.test.mjs
node src/mechanism-acceptance.test.mjs
node --check src/index.mjs
git diff --check
```

Expected: all commands exit zero.

**Step 5: Commit**

```bash
git add config.example.json config.distribution.json src/config.mjs src/config.test.mjs src/index.mjs src/mechanism-acceptance.test.mjs
git commit -m "feat: schedule two grounded Moments posts daily"
```

### Task 5: Full verification, one live post, and deployment

**Files:**
- No additional tracked files expected

**Step 1: Run full verification in the feature worktree**

Run: `npm run check && npm test && git diff --check`

Expected: exit zero with zero failed tests.

**Step 2: Merge locally and rerun full verification**

Fast-forward the base branch, run the same full command from the main workspace, and preserve unrelated user files.

**Step 3: Restart the LaunchAgent**

Restart `com.local.feishu-codex-digital-employee`. Verify `state=running`, TCP `17656` is listening, and the publisher activation log appears.

**Step 4: Verify exactly one immediate external mutation**

Read SQLite audit and publisher state without exposing post content. Require one `wechat_moments_post_sent` event for today's activation slot, a returned numeric Moments ID, `publishedCount=1`, one pending evening slot, and no duplicate mutation row.

**Step 5: Push GitHub main and verify remote hash**

Fetch `origin/main`, ensure it is an ancestor, push `HEAD:main`, and compare `git rev-parse HEAD` with `git ls-remote origin refs/heads/main`.

