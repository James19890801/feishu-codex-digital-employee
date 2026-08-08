# Adaptive Discussion Budget Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow valuable Feishu and DingTalk group debates to continue for up to 100 AIPRO replies while deterministically ending low-value or hard-limit loops.

**Architecture:** Add a pure local turn-value classifier, an atomic SQLite discussion-session claim, and a controller that runs before Codex. The controller replaces the fixed semantic-repeat decision for eligible group text while retaining the old guard as a disabled-feature fallback. Checkpoint and final-synthesis instructions flow into the existing Codex prompt; low-value closure and cooldown never call Codex.

**Tech Stack:** Node.js ES modules, built-in `node:sqlite`, built-in `node:test` style assertions, existing AIPRO dashboard and LaunchAgent service.

---

### Task 1: Classify discussion value locally

**Files:**
- Create: `src/discussion-value.mjs`
- Create: `src/discussion-value.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Cover structured evidence, questions, counterarguments, substantive novelty, acknowledgements, paraphrases, and terminal handoff language. The core API is:

```js
const result = evaluateDiscussionValue({
  text: '但是流程实时干预会不会扩大误判？我有一个反例。',
  recentTopics: [semanticTopic('事后复盘会被 AI 取代')],
});
assert.equal(result.substantive, true);
assert.ok(result.score >= 2);
```

**Step 2: Run test to verify it fails**

Run: `node src/discussion-value.test.mjs`

Expected: FAIL because `discussion-value.mjs` does not exist.

**Step 3: Write the minimal implementation**

Implement deterministic signals and return `{ substantive, score, reasons, topic }`. Reuse `semanticTopic` and `compareSemanticTopics`; do not invoke an AI runtime.

**Step 4: Run tests to verify they pass**

Run: `node src/discussion-value.test.mjs && node src/semantic-repeat-guard.test.mjs`

Expected: both PASS.

**Step 5: Commit**

```bash
git add src/discussion-value.mjs src/discussion-value.test.mjs package.json
git commit -m "feat: classify discussion turn value"
```

### Task 2: Persist an atomic discussion session budget

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`

**Step 1: Write the failing test**

Test `claimDiscussionTurn` with first turn, substantive continuation, three low-value turns, checkpoints 20/40/60/80, turn 100, cooldown, owner restart, and same-message retry.

```js
const claim = state.claimDiscussionTurn({
  channel: 'dingtalk', chatId: 'dingtalk:group:test', messageId: 'm1',
  value: { substantive: true, score: 4, topic: semanticTopic('新观点') },
  maxReplies: 100, lowValueLimit: 3, cooldownMs: 1_800_000, nowMs: 1_000,
});
assert.equal(claim.action, 'process');
assert.equal(claim.replyNumber, 1);
```

**Step 2: Run test to verify it fails**

Run: `node src/state.test.mjs`

Expected: FAIL because `claimDiscussionTurn` is missing.

**Step 3: Write the minimal implementation**

Create `discussion_session` with a primary key on channel and chat, plus reply count, low-value streak, recent topics JSON, session number, checkpoint, cooldown, last message/action, closure reason, and timestamps. Use `BEGIN IMMEDIATE` and return the same action for an inbound retry.

Add `completeDiscussionFinalReply` and `discussionBudgetStats`.

**Step 4: Run test to verify it passes**

Run: `node src/state.test.mjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/state.mjs src/state.test.mjs
git commit -m "feat: persist adaptive discussion sessions"
```

### Task 3: Build the adaptive controller

**Files:**
- Create: `src/discussion-budget-controller.mjs`
- Create: `src/discussion-budget-controller.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Test group eligibility, direct-message bypass, ordinary processing, checkpoint instructions, low-value close without Codex, cooldown suppression, hard-limit finalization, and owner `继续讨论` restart.

```js
const result = await applyDiscussionBudgetGate({
  state, enabled: true, channel: 'dingtalk', ownerAuthorized: false,
  message: groupMessage('m1'), text: '我有一个新反例', maxReplies: 100,
});
assert.equal(result.action, 'process');
```

**Step 2: Run test to verify it fails**

Run: `node src/discussion-budget-controller.test.mjs`

Expected: FAIL because the controller does not exist.

**Step 3: Write the minimal implementation**

Return `{ handled, action, replyNumber, checkpointPrompt, finalizeAfterReply }`. Low-value closure calls a supplied `sendClose` callback once. Cooldown is silent. Owner restart clears the session and proceeds as a fresh discussion.

**Step 4: Run tests to verify they pass**

Run: `node src/discussion-budget-controller.test.mjs && node src/state.test.mjs`

Expected: both PASS.

**Step 5: Commit**

```bash
git add src/discussion-budget-controller.mjs src/discussion-budget-controller.test.mjs package.json
git commit -m "feat: control adaptive group discussions"
```

### Task 4: Add bounded configuration and dashboard visibility

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `config.example.json`
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `src/dashboard-server.mjs`

**Step 1: Write the failing tests**

Assert defaults and bounds for enabled, max replies, low-value limit, and cooldown. Assert dashboard status exposes counts and reasons without raw content.

**Step 2: Run tests to verify they fail**

Run: `node src/config.test.mjs && node src/dashboard-model.test.mjs`

Expected: FAIL because adaptive discussion fields are missing.

**Step 3: Write the minimal implementation**

Add defaults `true`, `100`, `3`, and `1800000`. Bound maximum replies to 10–100, low-value limit to 2–10, and cooldown to 1–120 minutes. Add sanitized maintenance status.

**Step 4: Run tests to verify they pass**

Run: `node src/config.test.mjs && node src/dashboard-model.test.mjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/config.mjs src/config.test.mjs config.example.json src/dashboard-model.mjs src/dashboard-model.test.mjs src/dashboard-server.mjs
git commit -m "feat: expose adaptive discussion controls"
```

### Task 5: Enforce verified-owner presence in direct chats

**Files:**
- Modify: `src/human-takeover.mjs`
- Modify: `src/human-takeover.test.mjs`
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write the failing tests**

Cover DingTalk and Feishu direct-chat owner activity, a rolling five-minute deadline, assistant-echo exclusion, per-chat isolation, context preservation while silent, and takeover after exactly five minutes of inactivity.

```js
const result = applyOwnerActivityHistory(messages, {
  ownerId: 'owner', current: null, nowMs,
  isAssistantMessage: message => message.openMessageId === 'assistant-echo',
});
assert.equal(result.state.pausedUntilMs, lastManualOwnerMessageMs + 5 * 60_000);
```

**Step 2: Run tests to verify they fail**

Run: `node src/human-takeover.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: FAIL on the rolling direct-chat and exact handoff contracts.

**Step 3: Write the minimal implementation**

For DingTalk p2p conversation snapshots, apply verified owner activity history and exclude messages found in the outbound-echo store. For Feishu direct owner activity, use the normalized owner-activity metadata. Store takeover per chat, extend on every real manual owner message, remember inbound messages while silent, and allow normal processing only when five full minutes have elapsed. Groups continue to use explicit owner controls rather than automatic direct-chat presence.

**Step 4: Run focused tests**

Run: `node src/human-takeover.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/human-takeover.mjs src/human-takeover.test.mjs src/index.mjs src/mechanism-acceptance.test.mjs
git commit -m "fix: yield direct chats to verified owner activity"
```

### Task 6: Integrate before Codex without changing other channels

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `src/im-channels.mjs`
- Modify: `src/im-channels.test.mjs`

**Step 1: Write the failing tests**

Add acceptance checks proving:

- Feishu and DingTalk group text uses adaptive budgeting.
- Direct messages bypass it.
- Disabled adaptive budgeting falls back to the semantic-repeat guard.
- closure can be delivered without an `@` mention;
- checkpoint instructions reach the Codex task;
- successful turn 100 delivery closes the session.

**Step 2: Run tests to verify they fail**

Run: `node src/im-channels.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: FAIL on the new adaptive contracts.

**Step 3: Write the minimal integration**

Invoke `applyDiscussionBudgetGate` after owner takeover and group mention validation but before the fixed semantic guard, memory-dependent workflows, and Codex. For eligible messages, skip the fixed semantic guard. Append checkpoint prompts to the existing task. After a successful final reply, call `completeDiscussionFinalReply`.

Extend group mention preparation with an explicit `suppressMention` option used only for automatic closing messages.

**Step 4: Run focused tests**

Run:

```bash
node --check src/index.mjs
node src/discussion-budget-controller.test.mjs
node src/im-channels.test.mjs
node src/mechanism-acceptance.test.mjs
```

Expected: PASS with no regression in existing group attribution.

**Step 5: Commit**

```bash
git add src/index.mjs src/mechanism-acceptance.test.mjs src/im-channels.mjs src/im-channels.test.mjs
git commit -m "feat: enforce bounded adaptive debates"
```

### Task 7: Verify, integrate, deploy, and publish

**Files:**
- Verify all changed files

**Step 1: Run the full suite**

Run: `git diff --check && npm test`

Expected: exit 0, mechanism acceptance reports zero failures.

**Step 2: Merge the isolated branch safely**

Preserve any overlapping uncommitted main-worktree changes, merge `feature/adaptive-discussion-budget`, restore preserved changes, and resolve only genuine overlaps.

**Step 3: Run the full suite on main**

Run: `git diff --check && npm test`

Expected: exit 0.

**Step 4: Restart and verify**

Restart only `com.local.feishu-codex-digital-employee`. Verify dashboard status reports process alive and Feishu, DingTalk, and Multica healthy. Do not send unsolicited group messages.

**Step 5: Push GitHub**

Verify the configured remote and branch, then push main. Confirm the remote commit contains the adaptive discussion commits and does not include unrelated uncommitted files.
