# WeChat Moments Engagement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a selective, persistent personal-WeChat Moments worker that comments on safe new friend posts and replies once to new comments directed at the owner or the digital human.

**Architecture:** Extend `GeWeChannel` with read-only Moments/profile methods and one serialized comment mutation. Add a standalone `WeChatMomentsEngagement` domain worker that normalizes untrusted SNS data, establishes a no-write baseline, applies deterministic safety/rate/idempotency gates, asks the existing AI runtime for strict JSON decisions, and records only hashed audit identifiers. Wire the worker into the existing GeWe lifecycle so it starts and stops with the personal-WeChat channel.

**Tech Stack:** Node.js ESM, built-in test runner/assertions, existing `AgentState`, existing `AiRuntimeClient`, GeWe REST API, macOS Keychain.

---

### Task 1: Add configuration contract

**Files:**
- Modify: `config.example.json`
- Modify: `config.distribution.json`
- Modify: `config.local.json` (ignored local configuration only)
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`

**Step 1: Write the failing test**

Assert that the six Moments settings exist, use safe defaults, and reject out-of-range intervals, budgets, thread depth, and post age.

**Step 2: Run test to verify it fails**

Run: `node src/config.test.mjs`

Expected: FAIL because `geweMomentsEngagementEnabled` and the bounded settings do not exist.

**Step 3: Write minimal implementation**

Add:

```json
{
  "geweMomentsEngagementEnabled": false,
  "geweMomentsScanIntervalMs": 1800000,
  "geweMomentsMaxProactivePerDay": 6,
  "geweMomentsMaxRepliesPerDay": 20,
  "geweMomentsMaxThreadDepth": 4,
  "geweMomentsPostMaxAgeHours": 36
}
```

Use `boundedInteger` in `src/config.mjs`. Enable the local-only flag in `config.local.json`; never commit that file.

**Step 4: Run test to verify it passes**

Run: `node src/config.test.mjs`

Expected: `CONFIG_TEST_OK`.

### Task 2: Add tested GeWe Moments adapter methods

**Files:**
- Modify: `src/im-channel-runtime.mjs`
- Modify: `src/im-channel-runtime.test.mjs`

**Step 1: Write failing adapter tests**

Test exact paths and sanitized bodies for:

```js
channel.getProfile()
channel.listMoments({ maxId: 0, firstPageMd5: '' })
channel.getMomentDetails(snsId)
channel.commentMoment({ snsId, wxid, commentId: 0, content })
```

Also assert invalid IDs, wxids, comment IDs and content are rejected before network calls.

**Step 2: Run test to verify it fails**

Run: `node src/im-channel-runtime.test.mjs`

Expected: FAIL because the methods are missing.

**Step 3: Implement minimal methods**

Use the documented paths:

```text
/gewe/v2/api/personal/getProfile
/gewe/v2/api/sns/snsList
/gewe/v2/api/sns/snsDetails
/gewe/v2/api/sns/commentSns
```

`commentMoment` always sets `operType: 1`. Serialize writes through a dedicated tail. Do not automatically retry a failed comment.

**Step 4: Run test to verify it passes**

Run: `node src/im-channel-runtime.test.mjs`

Expected: `IM_CHANNEL_RUNTIME_TEST_OK`.

### Task 3: Build normalization and deterministic policy

**Files:**
- Create: `src/wechat-moments-engagement.mjs`
- Create: `src/wechat-moments-engagement.test.mjs`

**Step 1: Write failing pure-policy tests**

Cover XML text extraction, XML entity decoding, stable SNS/comment identifiers, recent-post checks, sensitive/advertising/empty-content rejection, generic AI-output rejection, Markdown rejection, fake-experience rejection, and strict JSON parsing.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: FAIL because the module is missing.

**Step 3: Implement normalization and policy**

Export small testable helpers:

```js
normalizeMoment(raw)
normalizeComment(raw)
isEligibleProactiveMoment(moment, context)
validateGeneratedReply(text)
parseEngagementDecision(output)
buildMomentsPrompt(input)
```

Treat all SNS text as untrusted prompt data, cap each field, strip control characters, and never interpolate raw XML into the AI prompt.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: policy tests pass.

### Task 4: Build baseline, incremental discovery and idempotent execution

**Files:**
- Modify: `src/wechat-moments-engagement.mjs`
- Modify: `src/wechat-moments-engagement.test.mjs`

**Step 1: Write failing worker tests**

Use fake state, channel, AI and clock to verify:

1. First scan saves current feed/comments and sends nothing.
2. A new safe friend post gets one initial comment.
3. Re-running the scan never repeats it.
4. A new comment on the owner's post receives one targeted reply.
5. A comment whose `replyCommentId` points at the owner's existing comment receives one targeted reply.
6. Old/sensitive/empty/self posts are skipped.
7. Proactive, per-author, reply and thread budgets stop writes.
8. A failed external write is marked ambiguous and is not retried.
9. Three scan failures or two write failures open the circuit breaker.
10. Audit payloads contain neither plaintext content nor wxids.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: FAIL on missing worker behavior.

**Step 3: Implement `WeChatMomentsEngagement`**

The worker owns one serialized scan tail and persists a bounded state object under `wechat-moments-engagement`. Use `executeMutationOnce` for each comment key:

```text
moments:<snsHash>:initial
moments:<snsHash>:reply:<commentHash>
```

On startup, fetch profile/feed/details and write a baseline only. On later scans, process reply candidates before proactive candidates. Ask AI for `{ "action":"reply|skip", "text":"...", "reason":"..." }`, validate again locally, then call `commentMoment`.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: all worker tests pass with zero real network calls.

### Task 5: Integrate local Wiki and the service lifecycle

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write failing acceptance assertions**

Assert that `index.mjs` imports the worker, supplies the existing GeWe channel, state, AI runtime and local-Wiki callback, starts it only when enabled, and stops it during shutdown or GeWe startup failure.

**Step 2: Run test to verify it fails**

Run: `node src/mechanism-acceptance.test.mjs`

Expected: FAIL because lifecycle wiring is absent.

**Step 3: Implement lifecycle wiring**

Add one worker variable. Build the AI callback with `runAiRuntime` and the current `codexModel`. Build the knowledge callback with `LOCAL_WIKI_RETRIEVER.contextFor({ query, channel: 'wechat-moments' })`. Start after GeWe is online; stop it in all existing shutdown/failure branches.

**Step 4: Run tests to verify they pass**

Run:

```bash
node src/mechanism-acceptance.test.mjs
node --check src/index.mjs
```

Expected: mechanism acceptance and syntax checks pass.

### Task 6: Register tests and verify without real comments

**Files:**
- Modify: `package.json`

**Step 1: Add the new unit test and syntax check**

Add `node src/wechat-moments-engagement.test.mjs` to `npm test` and `node --check src/wechat-moments-engagement.mjs` to `npm run check`.

**Step 2: Run focused verification**

Run:

```bash
node src/config.test.mjs
node src/im-channel-runtime.test.mjs
node src/wechat-moments-engagement.test.mjs
node src/mechanism-acceptance.test.mjs
```

Expected: all pass.

**Step 3: Run full verification**

Run:

```bash
npm run check
npm test
git diff --check
```

Expected: all commands exit 0.

**Step 4: Perform read-only live verification**

Check online status and read one first-page feed/profile response. Print only booleans, counts and field names. Do not invoke `commentSns`.

**Step 5: Commit and publish**

Stage only the feature files and examples, preserve unrelated user files, commit, fetch `origin/main`, and push `HEAD:main` after confirming the branch is a fast-forward.
