# Owner Article Syndication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect articles published by 詹老师's exact WeChat identities, read them, prepare a grounded article comment, and share the link to Moments with a distinct insight exactly once.

**Architecture:** Add article provenance to GeWe normalization, route eligible articles into a durable syndication worker, and execute article-comment and Moments-share mutations independently. Reuse the public web reader, AI runtime, state database, mutation executor, GeWe channel, and the existing macOS WeChat adapter boundary.

**Tech Stack:** Node.js ESM, `node:test`/assert-based tests, SQLite state, GeWe REST API, macOS Accessibility adapter, existing AI runtime and public web reader.

---

### Task 1: Preserve article provenance in GeWe normalization

**Files:**
- Modify: `src/im-channels.mjs`
- Modify: `src/im-channels.test.mjs`

**Step 1: Write the failing test**

Add an APPMSG fixture containing `sourceusername`, `sourcedisplayname`, `thumburl`, title, description, and URL. Assert that `metadata.linkCandidate` preserves all public article fields and that direct messages from `gh_07e3d1422f5e` remain identifiable.

**Step 2: Run test to verify it fails**

Run: `node src/im-channels.test.mjs`

Expected: FAIL because publisher and thumbnail metadata are absent.

**Step 3: Write minimal implementation**

Extend `geWeAppMessage` to return bounded `publisherId`, `publisherName`, and HTTPS `thumbUrl` fields for type-5 APPMSG links.

**Step 4: Run test to verify it passes**

Run: `node src/im-channels.test.mjs`

Expected: `IM_CHANNELS_TEST_OK`.

### Task 2: Add deterministic owner-article policy and URL fingerprinting

**Files:**
- Create: `src/wechat-owner-article-policy.mjs`
- Create: `src/wechat-owner-article-policy.test.mjs`

**Step 1: Write failing tests**

Cover exact公众号 sender match, exact owner sender plus verified publisher match, rejection of lookalike names, rejection of non-WeChat URLs, and canonical equivalence across `scene`, `mpshare`, `srcid`, and fragment differences.

**Step 2: Run tests to verify they fail**

Run: `node src/wechat-owner-article-policy.test.mjs`

Expected: FAIL because the policy module does not exist.

**Step 3: Write minimal implementation**

Export `eligibleOwnerArticle(input)` and `canonicalWechatArticle(input)` using exact identifier sets and `biz/mid/idx/sn` keys.

**Step 4: Run tests to verify they pass**

Run: `node src/wechat-owner-article-policy.test.mjs`

Expected: `WECHAT_OWNER_ARTICLE_POLICY_TEST_OK`.

### Task 3: Add GeWe linked-Moment publishing

**Files:**
- Modify: `src/im-channel-runtime.mjs`
- Modify: `src/im-channel-runtime.test.mjs`

**Step 1: Write the failing test**

Call `publishLinkMoment` and assert one POST to `/gewe/v2/api/sns/sendUrlSns` with validated title, description, thumbnail, URL, content, public visibility, and empty allow/deny lists.

**Step 2: Run test to verify it fails**

Run: `node src/im-channel-runtime.test.mjs`

Expected: FAIL because `publishLinkMoment` is undefined.

**Step 3: Write minimal implementation**

Add `publishLinkMoment` beside `publishTextMoment`, reuse `momentTail`, enforce HTTPS article and thumbnail URLs, and cap every textual field.

**Step 4: Run test to verify it passes**

Run: `node src/im-channel-runtime.test.mjs`

Expected: `IM_CHANNEL_RUNTIME_TEST_OK`.

### Task 4: Build the durable syndication worker

**Files:**
- Create: `src/wechat-owner-article-syndication.mjs`
- Create: `src/wechat-owner-article-syndication.test.mjs`

**Step 1: Write failing tests**

Test detection, readable-page requirement, strict JSON parsing, non-overlapping content, separate mutation keys, callback replay dedupe, independent retry state, and redacted audits.

**Step 2: Run tests to verify they fail**

Run: `node src/wechat-owner-article-syndication.test.mjs`

Expected: FAIL because the worker does not exist.

**Step 3: Write minimal implementation**

Implement `observe(input)`, `process(articleKey)`, state normalization, retry scheduling, prompt construction, output validation, and calls to `commentArticle` and `publishLinkMoment` through `executeMutationOnce`.

**Step 4: Run tests to verify they pass**

Run: `node src/wechat-owner-article-syndication.test.mjs`

Expected: `WECHAT_OWNER_ARTICLE_SYNDICATION_TEST_OK`.

### Task 5: Wire runtime, config, recovery, and acceptance contract

**Files:**
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `config.local.json`
- Modify: `src/config.test.mjs`
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Create: `scripts/replay-owner-articles.mjs`
- Create: `scripts/replay-owner-articles.test.mjs`

**Step 1: Write failing tests**

Assert explicit feature configuration, lifecycle wiring before normal reply routing, startup retry, and a replay CLI that discovers eligible stored inbound messages without replaying unrelated messages.

**Step 2: Run tests to verify they fail**

Run: `node src/config.test.mjs && node scripts/replay-owner-articles.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: FAIL on missing config, replay script, and runtime contract.

**Step 3: Write minimal implementation**

Instantiate the worker after GeWe starts, observe eligible inbound links before conversation reply handling, start retry recovery, and provide the one-shot replay command.

**Step 4: Run focused tests**

Run: `node src/config.test.mjs && node scripts/replay-owner-articles.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: all focused tests pass and mechanism acceptance reports zero failures.

### Task 6: Verify and execute today's article

**Files:**
- Modify only if verification finds a defect in the preceding implementation.

**Step 1: Run full verification**

Run: `npm test && npm run check`

Expected: exit 0, all mechanism-acceptance contracts pass.

**Step 2: Restart the service and verify health**

Run: `launchctl kickstart -k gui/$(id -u)/com.local.feishu-codex-digital-employee`

Expected: process state is running and WeChat emits `im_channel_connected`.

**Step 3: Replay today's article detection**

Run: `node scripts/replay-owner-articles.mjs --since 2026-08-17T00:00:00.000Z`

Expected: exactly one canonical article is discovered. Article-comment and Moments-share outcomes are reported separately; no raw credentials or private message text is printed.

**Step 4: Verify durable state and duplicate suppression**

Run the replay command a second time.

Expected: no second external mutation; state reports already completed or pending confirmation.

**Step 5: Commit and push**

Stage only feature files, commit with `feat: syndicate owner articles to WeChat`, and push `main` after verification.
