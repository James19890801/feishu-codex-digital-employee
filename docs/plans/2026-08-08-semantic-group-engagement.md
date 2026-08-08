# Semantic Group Engagement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Observe unmentioned Feishu and DingTalk group messages, use the preceding 30 messages to decide whether AIPRO should engage, and mention the answered sender when it replies.

**Architecture:** Add a fail-closed two-stage engagement router in front of the existing workflow. Feishu reuses its all-message poll; DingTalk gains an independent shadow poller using the existing list-all API. Explicit mentions keep their current fast path, while unmentioned messages are first remembered, locally screened, and only ambiguous candidates are classified by the selected AI runtime.

**Tech Stack:** Node.js ESM, `node:sqlite`, existing lark-cli and DWS CLIs, existing `AiRuntimeClient`, `node:test`-style assertion scripts, launchd.

---

### Task 1: Pure engagement routing and classifier contract

**Files:**
- Create: `src/semantic-group-engagement.mjs`
- Create: `src/semantic-group-engagement.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Cover explicit mention, configured alias, recent-assistant continuation, low-information chatter, unrelated questions, disabled mode, strict JSON parsing, confidence threshold, invalid JSON fail-closed, and a 30-message bound.

```js
assert.equal(assessGroupEngagement({
  enabled: true,
  chatType: 'group',
  text: '詹老师助理，这个结论依据是什么？',
  aliases: ['詹老师助理'],
}).action, 'reply_named');

assert.equal(parseSemanticEngagementDecision(
  '{"action":"reply","confidence":0.91,"reasonCode":"active_topic"}',
  { threshold: 0.86 },
).action, 'reply_semantic');
```

**Step 2: Run test to verify it fails**

Run: `node src/semantic-group-engagement.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

**Step 3: Write minimal implementation**

Export `assessGroupEngagement`, `buildSemanticEngagementPrompt`, and `parseSemanticEngagementDecision`. The deterministic result is one of `reply_explicit`, `reply_named`, `reply_continuation`, `classify`, `observe`, or `suppress`. The parser accepts only a JSON object, clamps confidence to `[0,1]`, and converts all malformed/low-confidence results to `observe`.

**Step 4: Run test to verify it passes**

Run: `node src/semantic-group-engagement.test.mjs`
Expected: `SEMANTIC_GROUP_ENGAGEMENT_TEST_OK`.

**Step 5: Commit**

```bash
git add package.json src/semantic-group-engagement.mjs src/semantic-group-engagement.test.mjs
git commit -m "feat: add semantic group engagement router"
```

### Task 2: Feishu unmentioned-candidate acquisition

**Files:**
- Modify: `src/polling.mjs`
- Modify: `src/polling.test.mjs`
- Modify: `src/index.mjs`

**Step 1: Write the failing test**

Add `selectSemanticGroupCandidates` cases proving that unmentioned non-owner group text/post messages are selected, explicit mentions are left to the existing selector, direct messages and verified owner messages are excluded, and candidates carry `semantic_candidate: true`.

**Step 2: Run test to verify it fails**

Run: `node src/polling.test.mjs`
Expected: FAIL because the selector is not exported.

**Step 3: Write minimal implementation**

Implement the pure selector and append its results to `fetchUserInboundMessages`. Extend `normalizeSearchMessage` to map `semantic_candidate` to `metadata.semanticCandidate`. Preserve the existing durable inbox message-ID deduplication.

**Step 4: Run test to verify it passes**

Run: `node src/polling.test.mjs`
Expected: `POLLING_TEST_OK`.

**Step 5: Commit**

```bash
git add src/polling.mjs src/polling.test.mjs src/index.mjs
git commit -m "feat: observe unmentioned Feishu group messages"
```

### Task 3: DingTalk shadow group observer

**Files:**
- Modify: `src/im-channels.mjs`
- Modify: `src/im-channels.test.mjs`
- Modify: `src/dingtalk-wukong-poller.mjs`
- Modify: `src/dingtalk-wukong-poller.test.mjs`
- Modify: `src/index.mjs`

**Step 1: Write the failing test**

Test `normalizeDingTalkListAllPage(..., { includeUnmentionedGroups: true })`: unmentioned group messages become semantic candidates with empty mentions; mentioned messages retain their current shape; owner messages remain excluded; pagination and deduplication are unchanged.

**Step 2: Run test to verify it fails**

Run: `node src/im-channels.test.mjs && node src/dingtalk-wukong-poller.test.mjs`
Expected: FAIL because unmentioned group messages are still filtered.

**Step 3: Write minimal implementation**

Thread `includeUnmentionedGroups` through the normalizer and window fetcher. Add a semantic-observer polling loop that may run beside the event stream when the feature is enabled. Give it a separate cursor and health keys; do not call `updateImChannelStatus(...connected:false)` on observer failure. Continue to use `enqueueInbound` for cross-source deduplication.

**Step 4: Run test to verify it passes**

Run: `node src/im-channels.test.mjs && node src/dingtalk-wukong-poller.test.mjs && node --check src/index.mjs`
Expected: both test sentinels and exit code 0.

**Step 5: Commit**

```bash
git add src/im-channels.mjs src/im-channels.test.mjs src/dingtalk-wukong-poller.mjs src/dingtalk-wukong-poller.test.mjs src/index.mjs
git commit -m "feat: add isolated DingTalk group observer"
```

### Task 4: Remember first, classify second, reply through the existing workflow

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/conversation-history.test.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write the failing acceptance contracts**

Add contracts for: unmentioned chatter is remembered without reply; named unmentioned message enters the workflow; an ambiguous candidate receives exactly 30 preceding messages; low confidence and runtime failure remain silent; takeover suppresses classification; accepted replies inherit current reply context and mention the sender.

**Step 2: Run test to verify it fails**

Run: `node src/conversation-history.test.mjs && node src/mechanism-acceptance.test.mjs`
Expected: FAIL on missing semantic engagement contract.

**Step 3: Write minimal implementation**

Move group-message remembering before the old mention-only gate and guard against double remembering by `sourceMessageId`. For unmentioned semantic candidates, call the pure first-stage router. Call `runAiRuntime` only for `classify`, using a strict JSON prompt built from `formatHistory(...limit: 30, excludeSourceMessageId: current)`. Audit only action, confidence bucket, reason code, and channel. If accepted, continue into the existing workflow without bypassing takeover, repeat protection, discussion budgets, privacy boundaries, or reply mention routing.

**Step 4: Run tests to verify they pass**

Run: `node src/conversation-history.test.mjs && node src/semantic-group-engagement.test.mjs && node src/mechanism-acceptance.test.mjs`
Expected: all sentinels and zero failed contracts.

**Step 5: Commit**

```bash
git add src/index.mjs src/conversation-history.test.mjs src/mechanism-acceptance.test.mjs
git commit -m "feat: route semantic group replies through 30-message context"
```

### Task 5: Configuration, control, and health visibility

**Files:**
- Modify: `config.example.json`
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `src/dashboard-server.mjs`
- Modify: `dashboard/app.js`
- Modify: `dashboard/i18n.mjs`
- Modify: `dashboard/i18n.test.mjs`

**Step 1: Write failing tests**

Test bounded defaults (`enabled=true`, threshold `0.86`, cooldown `120000`), dashboard redaction, observer counters, and the feature master switch remaining independent from channel connection switches.

**Step 2: Run tests to verify they fail**

Run: `node src/config.test.mjs && node src/dashboard-model.test.mjs && node dashboard/i18n.test.mjs`
Expected: FAIL on missing configuration and model fields.

**Step 3: Write minimal implementation**

Add configuration parsing and dashboard status fields. Reuse the authenticated configuration update endpoint and existing switch component; do not add a second control protocol. Display observed/classified/replied/suppressed totals and last observer error without raw text.

**Step 4: Run tests to verify they pass**

Run: `node src/config.test.mjs && node src/dashboard-model.test.mjs && node dashboard/i18n.test.mjs && node dashboard/visual-contract.test.mjs`
Expected: all sentinels.

**Step 5: Commit**

```bash
git add config.example.json src/config.mjs src/config.test.mjs src/dashboard-model.mjs src/dashboard-model.test.mjs src/dashboard-server.mjs dashboard/app.js dashboard/i18n.mjs dashboard/i18n.test.mjs
git commit -m "feat: expose semantic group engagement controls"
```

### Task 6: Full regression, live-safe deployment, and remote push

**Files:**
- Modify only if verification exposes a defect.

**Step 1: Run static and full regression checks**

Run: `git diff --check && node --check src/index.mjs && npm test`
Expected: exit 0 and all mechanism-acceptance contracts pass.

**Step 2: Probe read-only channel capability**

Run the existing Feishu message search and DingTalk list-all paths against a short current window without sending a message. Confirm candidate normalization and ensure no primary channel health state changes.

**Step 3: Merge while preserving local user changes**

Stash only overlapping dirty files in the main worktree, fast-forward merge this branch, reapply the named stash, resolve by preserving both sets of changes, and rerun `npm test` in main.

**Step 4: Deploy and verify**

Push `main`, restart `com.local.feishu-codex-digital-employee`, and query `/api/status`. Confirm process alive plus Feishu, DingTalk, AI runtime, database, and Multica health. Do not send unsolicited test messages to real groups.

**Step 5: Cleanup**

Remove the feature worktree and branch only after remote HEAD and live health are verified.
