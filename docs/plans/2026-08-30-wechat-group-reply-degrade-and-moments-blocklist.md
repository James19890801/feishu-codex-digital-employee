# WeChat Group Reply Degrade and Moments Blocklist Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make personal WeChat group replies opt-in through a real mention or explicit assistant request, and prohibit Moments likes/comments for configured WeChat IDs.

**Architecture:** Add a pure WeChat group reply gate and apply it before the existing `contextOnly` early return. Preserve the shared semantic engine for other channels and the existing 50-message history path for addressed requests. Add a validated Moments interaction blocklist and enforce it both before scheduling/generation and immediately before mutations.

**Tech Stack:** Node.js ESM, `node:assert/strict` tests, JSON configuration, launchd local service.

---

### Task 1: Add the WeChat group reply policy

**Files:**
- Create: `src/wechat-group-reply-policy.mjs`
- Create: `src/wechat-group-reply-policy.test.mjs`

**Step 1: Write the failing policy tests**

Cover real mentions, direct requests such as `小詹回复一下` and `数字人帮忙点评`, passive aliases, unaddressed links/articles/images/files, unrelated group questions, non-WeChat groups, and private chats. Assert that only a real mention or an alias coupled to a response/task request opens the WeChat gate.

**Step 2: Run the policy test and verify RED**

Run: `node src/wechat-group-reply-policy.test.mjs`

Expected: FAIL because `wechat-group-reply-policy.mjs` does not exist.

**Step 3: Implement the minimal pure policy**

Export `decideWeChatGroupReplyPolicy({ channel, chatType, text, explicitMention, aliases })`. Return `{ applies, shouldReply, reasonCode, responseRequired }`. Normalize aliases, require an actual task/response verb near the alias, and default ambiguous messages to observation.

**Step 4: Run the policy test and verify GREEN**

Run: `node src/wechat-group-reply-policy.test.mjs`

Expected: `WECHAT_GROUP_REPLY_POLICY_TEST_OK`.

### Task 2: Wire the gate into inbound WeChat handling

**Files:**
- Modify: `src/im-channels.mjs:810-870`
- Modify: `src/im-channels.test.mjs:700-1230`
- Modify: `src/index.mjs:80-220, 3230-3720`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Add failing normalization and wiring tests**

Assert that an unaddressed WeChat link has no bot mention and is `contextOnly`, while a real `@` remains interactive. Add a source-level acceptance assertion that `processIncoming` applies the WeChat gate before `shouldObserveWithoutReply` and treats an approved alias request as a required response.

**Step 2: Run the focused tests and verify RED**

Run: `node src/im-channels.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: FAIL on passive-link and missing-gate assertions.

**Step 3: Implement the minimal wiring**

In `normalizeGeWeWebhook`, stop treating a link candidate as a mention; mark unaddressed group links/media as context-only. In `processIncoming`, evaluate the pure gate using `config.geweMentionNames` plus semantic aliases, override `contextOnly` only for allowed requests, audit the gate decision, and include the approved direct request in `hasGroupMention`/`responseRequired` handling. Do not change other channels.

**Step 4: Run the focused tests and verify GREEN**

Run: `node src/wechat-group-reply-policy.test.mjs && node src/im-channels.test.mjs && node src/mechanism-acceptance.test.mjs && node src/conversation-history.test.mjs && node src/reliability.test.mjs`

Expected: all commands exit 0 and print their success markers.

### Task 3: Add validated Moments blocklist configuration

**Files:**
- Modify: `src/config.mjs:250-285`
- Modify: `src/config.test.mjs`
- Modify: `config.example.json:75-85`
- Modify locally only: `config.local.json:55-65`

**Step 1: Add failing configuration tests**

Assert the default is an empty array, values are trimmed/deduplicated, and invalid non-array, empty, oversized, or whitespace-containing IDs are rejected. Use placeholder IDs only.

**Step 2: Run configuration tests and verify RED**

Run: `node src/config.test.mjs`

Expected: FAIL because `geweMomentsInteractionBlocklist` is not exported.

**Step 3: Implement configuration parsing**

Parse `geweMomentsInteractionBlocklist` as a bounded array of normalized non-empty WeChat IDs. Add an empty example value. Put the requested production ID only in ignored `config.local.json`.

**Step 4: Run configuration tests and verify GREEN**

Run: `node src/config.test.mjs`

Expected: `CONFIG_TEST_OK`.

### Task 4: Enforce the Moments blocklist twice

**Files:**
- Modify: `src/wechat-moments-engagement.mjs:330-1050`
- Modify: `src/wechat-moments-engagement.test.mjs`
- Modify: `src/index.mjs:6190-6225`

**Step 1: Add failing worker tests**

Add tests proving that a blocked author's Moment is neither liked nor proactively commented, a blocked commenter receives no thread reply, and a queued blocked like/comment is discarded before the channel mutation runs. Verify generated prompts and daily counters are untouched for newly blocked items.

**Step 2: Run the worker test and verify RED**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: FAIL because the constructor and execution path do not know the blocklist.

**Step 3: Implement pre-schedule and pre-mutation checks**

Normalize configured IDs into a constructor-owned set. Reject blocked Moment authors and comment targets before generation, likes, or scheduling. Persist the Moment author on pending actions and re-check both author and target in `runDueInteractions`; remove blocked queued actions and emit a hashed audit event. Pass the parsed configuration from `src/index.mjs`.

**Step 4: Run the worker test and verify GREEN**

Run: `node src/wechat-moments-engagement.test.mjs`

Expected: `WECHAT_MOMENTS_ENGAGEMENT_TEST_OK`.

### Task 5: Verify, commit only owned hunks, deploy, and push

**Files:**
- All files changed in Tasks 1-4
- Preserve all unrelated pre-existing worktree changes

**Step 1: Run focused verification**

Run: `node src/wechat-group-reply-policy.test.mjs && node src/im-channels.test.mjs && node src/config.test.mjs && node src/wechat-moments-engagement.test.mjs && node src/mechanism-acceptance.test.mjs && node src/conversation-history.test.mjs && node src/reliability.test.mjs`

Expected: all exit 0.

**Step 2: Run syntax and full repository verification**

Run: `npm run check && npm test`

Expected: both exit 0. If a pre-existing unrelated failure appears, record it precisely and run every directly affected suite separately.

**Step 3: Review the diff and stage only task-owned hunks**

Run: `git diff --check` and inspect `git diff` for every touched file. Use patch staging where a file already contained unrelated user changes; do not stage those unrelated hunks.

**Step 4: Commit the implementation**

Commit message: `feat: downgrade WeChat group link engagement`

**Step 5: Restart and verify the production service**

Run: `zsh scripts/install-service.sh`, then verify `launchctl print "gui/$(id -u)/com.local.feishu-codex-digital-employee"` reports `state = running`, the local health command succeeds, and recent error logs contain no startup failure.

**Step 6: Push the branch**

Run: `git push origin codex/wechat-owner-consultation`

Expected: push succeeds with the implementation and design commits while the concrete blocklisted WeChat ID remains local-only.
