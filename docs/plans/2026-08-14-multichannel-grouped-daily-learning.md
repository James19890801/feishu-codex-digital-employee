# Multichannel Grouped Daily Learning Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Feed up to 1000 fairly selected, conversation-grouped Feishu, DingTalk, and personal WeChat messages into the existing daily learning engine without leaking real chat or sender identities.

**Architecture:** Extend persisted learning evidence with channel and conversation identity, then apply deterministic weighted round-robin selection over per-conversation chronological suffixes. Resolve WeChat group names through GeWe only for local priority calculation, cache them locally, and strip all real names and IDs before prompt construction.

**Tech Stack:** Node.js ES modules, built-in SQLite, built-in crypto, GeWe REST API, Node test runner.

---

### Task 1: Preserve channel and conversation context in learning evidence

**Files:**
- Modify: `src/state.mjs:652-666`
- Modify: `src/state.test.mjs:690-710`

**Step 1: Write the failing test**

Add assertions that `learningEvidence()` returns `chatId`, `senderId`, `channel`, and `chatType` for Feishu, DingTalk, and WeChat conversations while preserving chronological order.

**Step 2: Run test to verify it fails**

Run: `node src/state.test.mjs`

Expected: FAIL because learning evidence currently returns only role, content, and time.

**Step 3: Write minimal implementation**

Select `chat_id` and `sender_id` from `conversation`. Derive `channel` from the prefixed chat ID, defaulting to `feishu`, and derive `chatType` from the prefixed target or cached Feishu chat metadata.

**Step 4: Run test to verify it passes**

Run: `node src/state.test.mjs`

Expected: `STATE_TEST_OK`.

**Step 5: Commit**

```bash
git add src/state.mjs src/state.test.mjs
git commit -m "feat: preserve channel context in learning evidence"
```

### Task 2: Fairly group and cap learning conversations at 1000

**Files:**
- Modify: `src/daily-learning.mjs:1-240`
- Modify: `src/daily-learning.test.mjs:1-115`

**Step 1: Write the failing tests**

Add tests for a wished-for `groupLearningConversations()` API:

- It returns no more than 1000 messages.
- Every active conversation receives context when fewer than 1000 conversations are present.
- Messages remain chronological inside each conversation.
- A priority WeChat professional group receives more messages under contention without starving other groups.
- Output contains stable anonymous conversation and speaker aliases but no raw chat ID, sender ID, or group name.

**Step 2: Run tests to verify they fail**

Run: `node src/daily-learning.test.mjs`

Expected: FAIL because `groupLearningConversations` does not exist.

**Step 3: Write minimal implementation**

Implement deterministic grouping by `channel + chatId`, stable SHA-256 aliases, chronological per-group buffers, and weighted round-robin allocation from each group’s latest suffix. Use a 1000-message default maximum and a bounded per-conversation ceiling.

**Step 4: Run tests to verify they pass**

Run: `node src/daily-learning.test.mjs`

Expected: `DAILY_LEARNING_TEST_OK`.

**Step 5: Commit**

```bash
git add src/daily-learning.mjs src/daily-learning.test.mjs
git commit -m "feat: group and balance daily learning conversations"
```

### Task 3: Build the anonymized grouped learning prompt

**Files:**
- Modify: `src/daily-learning.mjs:205-345`
- Modify: `src/daily-learning.test.mjs:75-120`
- Modify: `src/daily-learning-runner.test.mjs:1-95`

**Step 1: Write the failing tests**

Assert that the prompt contains grouped Feishu, DingTalk, and WeChat evidence with up to 1000 messages and speaker continuity, but does not contain raw chat IDs, raw sender IDs, real group names, tokens, phone numbers, or email addresses. Assert the prompt remains bounded.

**Step 2: Run tests to verify they fail**

Run: `node src/daily-learning.test.mjs && node src/daily-learning-runner.test.mjs`

Expected: FAIL because the prompt still flattens and slices conversations to 80.

**Step 3: Write minimal implementation**

Change `buildDailyLearningPrompt` to accept grouped conversations and serialize each anonymous conversation with ordered anonymous speakers. In `DailyLearningEngine.execute`, group enriched evidence before prompt construction and report the selected message count as `chatsReviewed`.

**Step 4: Run tests to verify they pass**

Run: `node src/daily-learning.test.mjs && node src/daily-learning-runner.test.mjs`

Expected: both tests print their `*_TEST_OK` marker.

**Step 5: Commit**

```bash
git add src/daily-learning.mjs src/daily-learning.test.mjs src/daily-learning-runner.test.mjs
git commit -m "feat: anonymize grouped multichannel learning prompts"
```

### Task 4: Resolve and cache WeChat group names without blocking learning

**Files:**
- Modify: `src/im-channel-runtime.mjs:150-330`
- Modify: `src/im-channel-runtime.test.mjs:180-270`
- Create: `src/wechat-learning-context.mjs`
- Create: `src/wechat-learning-context.test.mjs`

**Step 1: Write the failing tests**

Test that `GeWeChannel.getChatroomInfo(chatroomId)` posts `{appId, chatroomId}` to `/gewe/v2/api/group/getChatroomInfo` and returns the bounded `nickName`. Test the resolver’s cache hit, fresh lookup, stable fallback, and partial API failure behavior.

**Step 2: Run tests to verify they fail**

Run: `node src/im-channel-runtime.test.mjs && node src/wechat-learning-context.test.mjs`

Expected: FAIL because the method and resolver do not exist.

**Step 3: Write minimal implementation**

Add the read-only GeWe group-info method. Implement a resolver that enriches unique WeChat group conversations with locally cached names, limits lookup concurrency, records no secrets, and returns the original conversations unchanged on failure.

**Step 4: Run tests to verify they pass**

Run: `node src/im-channel-runtime.test.mjs && node src/wechat-learning-context.test.mjs`

Expected: both tests print their `*_TEST_OK` marker.

**Step 5: Commit**

```bash
git add src/im-channel-runtime.mjs src/im-channel-runtime.test.mjs src/wechat-learning-context.mjs src/wechat-learning-context.test.mjs
git commit -m "feat: resolve WeChat learning group context"
```

### Task 5: Wire the resolver and 1000-message limit into production

**Files:**
- Modify: `src/config.mjs:165-176`
- Modify: `config.example.json:64-70`
- Modify: `src/config.test.mjs`
- Modify: `src/index.mjs:1360-1415`
- Modify: `src/daily-learning-runner.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing tests**

Add configuration assertions for a default and bounded `dailyLearningConversationLimit` of 1000. Add a runner test proving an injected asynchronous conversation enricher runs before grouping. Add the new resolver test to the project test script.

**Step 2: Run tests to verify they fail**

Run: `node src/config.test.mjs && node src/daily-learning-runner.test.mjs`

Expected: FAIL because the setting and enrichment hook are absent.

**Step 3: Write minimal implementation**

Parse the bounded setting with default 1000. Inject `enrichWeChatLearningContext` into `DailyLearningEngine` from `src/index.mjs`, closing over the live `geWeChannel` and persistent state cache. Pass the configured limit into grouping.

**Step 4: Run focused tests**

Run: `node src/config.test.mjs && node src/daily-learning.test.mjs && node src/daily-learning-runner.test.mjs && node src/im-channel-runtime.test.mjs && node src/wechat-learning-context.test.mjs && node src/state.test.mjs`

Expected: all focused tests pass.

**Step 5: Commit**

```bash
git add config.example.json package.json src/config.mjs src/config.test.mjs src/index.mjs src/daily-learning-runner.test.mjs
git commit -m "feat: enable grouped learning across all chat channels"
```

### Task 6: Full verification, rollout, and 24-hour backfill

**Files:**
- No additional source files expected.

**Step 1: Run static and full regression checks**

Run: `git diff --check && npm test`

Expected: exit 0 and mechanism acceptance 121/121 or higher.

**Step 2: Inspect runtime safety before restart**

Verify no inbound message is currently `processing`, and preserve all unrelated untracked files.

**Step 3: Restart the service**

Restart `com.local.feishu-codex-digital-employee` through launchd and verify the process is running and all enabled channels remain connected.

**Step 4: Request one-time backfill**

Move `learning:last_source_to_at` back to at most 24 hours before rollout, set `learning:manual_requested_at`, and let the normal learning loop execute. Do not send any chat message.

**Step 5: Verify learned source coverage**

Confirm the completed run reports no more than 1000 selected messages, includes Feishu, DingTalk, and WeChat source groups when present in the window, advances the source cursor only after success, and stores no raw chat/group/sender identity in long-term memory.

**Step 6: Push the verified history**

```bash
git push origin codex/local-wiki-retrieval
git push origin HEAD:main
```
