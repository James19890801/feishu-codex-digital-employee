# Cross-Channel Reply Mention Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Guarantee that every group reply natively @-mentions the member whose message triggered the reply across Feishu, DingTalk, WeCom, and personal WeChat.

**Architecture:** Carry a fail-closed mention requirement in `AsyncLocalStorage`, render channel-specific native mention syntax in the shared routing layer, and let `GeWeChannel` resolve WeChat display names before posting both visible `@昵称` text and the `ats` recipient field. Existing inbound retries handle transient mention-resolution failures.

**Tech Stack:** Node.js ESM, AsyncLocalStorage, GeWe REST API, Node assert-based tests, launchd service.

---

### Task 1: Make reply context express the hard requirement

**Files:**
- Modify: `src/reply-routing.test.mjs`
- Modify: `src/reply-routing.mjs`

**Step 1: Write the failing test**

Assert that a group reply context with a sender has `mentionRequired: true`, while a p2p context has `mentionRequired: false`.

**Step 2: Run test to verify it fails**

Run: `node src/reply-routing.test.mjs`
Expected: FAIL because `mentionRequired` is absent.

**Step 3: Write minimal implementation**

Add `mentionRequired` to `createReplyContext`, derived only from group chat type and a non-empty normalized sender ID.

**Step 4: Run test to verify it passes**

Run: `node src/reply-routing.test.mjs`
Expected: `REPLY_ROUTING_TEST_OK`.

### Task 2: Render enterprise WeChat native group mentions

**Files:**
- Modify: `src/im-channels.test.mjs`
- Modify: `src/im-channels.mjs`

**Step 1: Write the failing test**

Call `prepareGroupMention` for `wecom:group:*` with `wecom:<userid>` and expect `<@userid>\n正文`.

**Step 2: Run test to verify it fails**

Run: `node src/im-channels.test.mjs`
Expected: FAIL because WeCom currently returns unchanged text.

**Step 3: Write minimal implementation**

Normalize the `wecom:` prefix and prepend one `<@userid>` marker per unique recipient.

**Step 4: Run test to verify it passes**

Run: `node src/im-channels.test.mjs`
Expected: `IM_CHANNELS_TEST_OK`.

### Task 3: Add native GeWe mention sending

**Files:**
- Modify: `src/im-channel-runtime.test.mjs`
- Modify: `src/im-channel-runtime.mjs`

**Step 1: Write the failing tests**

Assert that preparing and sending a WeChat group mention resolves the member display name, prefixes `@昵称`, and sends `ats` with the raw wxid. Assert that a missing member rejects instead of sending without @.

**Step 2: Run test to verify it fails**

Run: `node src/im-channel-runtime.test.mjs`
Expected: FAIL because the mention preparation API and `ats` option do not exist.

**Step 3: Write minimal implementation**

Add a five-minute group member cache, a forced refresh on a cache miss, `prepareGroupMention`, and optional validated `ats` support in `send`/`sendNow`.

**Step 4: Run test to verify it passes**

Run: `node src/im-channel-runtime.test.mjs`
Expected: `IM_CHANNEL_RUNTIME_TEST_OK`.

### Task 4: Enforce fail-closed routing in the service

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write or extend the failing acceptance test**

Assert that all supported group channel examples produce a native mention and that a required mention cannot have an empty recipient list.

**Step 2: Run test to verify it fails**

Run: `node src/mechanism-acceptance.test.mjs`
Expected: FAIL for the new WeCom/WeChat contract.

**Step 3: Write minimal implementation**

Pass inbound metadata into reply context, validate required recipients before sending, and call GeWe mention preparation before echo recording and delivery.

**Step 4: Run focused tests**

Run: `node src/reply-routing.test.mjs && node src/im-channels.test.mjs && node src/im-channel-runtime.test.mjs && node src/mechanism-acceptance.test.mjs`
Expected: all four success markers.

### Task 5: Verify, deploy, and publish

**Files:**
- Verify: `package.json`
- Deploy: existing launchd service configuration

**Step 1: Run static checks and full test suite**

Run: `npm run check && npm test`
Expected: exit code 0 with no failed tests.

**Step 2: Review the diff and repository status**

Run: `git diff --check && git status --short`
Expected: no whitespace errors; only scoped files plus pre-existing untracked user files.

**Step 3: Commit scoped files**

Run: `git add <scoped files> && git commit -m "feat: require native mentions on group replies"`
Expected: one new commit.

**Step 4: Push to GitHub main**

Run: `git push origin HEAD:main`
Expected: remote `main` advances to the new commit.

**Step 5: Restart and health-check the local service**

Restart the existing launchd job, then run `npm run health` and inspect recent service logs.
Expected: personal WeChat connected, callback registered, and no startup errors.
