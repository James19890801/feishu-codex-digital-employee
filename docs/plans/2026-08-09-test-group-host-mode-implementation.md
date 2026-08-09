# Test Group Host Mode Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a restart-safe delayed host mode that picks up unanswered public topics in configured groups after 75 seconds without changing other groups' conservative reply behavior.

**Architecture:** The inbound path deterministically identifies host candidates and persists them in SQLite instead of waiting inside the chat queue. A lightweight worker atomically claims due candidates, rechecks later group history and human takeover, uses a bounded classifier only for ambiguous silence decisions, and sends one short host reply through the existing guarded `sendText` path.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, existing semantic topic comparison, existing AI runtime and channel delivery abstractions, Node assert tests.

---

### Task 1: Configuration contract

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/config-assistant.mjs`
- Modify: `config.example.json`
- Test: `src/config.test.mjs`

**Step 1: Write the failing tests**

Add assertions that default configuration exposes disabled host mode, an empty chat allowlist, a 75-second silence window, and a 3-minute reply cooldown. Add validation cases for malformed chat lists and out-of-range timing values.

**Step 2: Run the test to verify it fails**

Run: `node src/config.test.mjs`

Expected: FAIL because the four settings are not exported.

**Step 3: Implement the minimal configuration**

Export:

```js
groupHostModeEnabled: raw.groupHostModeEnabled === true,
groupHostChatIds: stringArray(raw.groupHostChatIds, { name: 'groupHostChatIds', maxItems: 20 }),
groupHostSilenceMs: boundedInteger(raw.groupHostSilenceMs, {
  name: 'groupHostSilenceMs', fallback: 75_000, min: 30_000, max: 180_000,
}),
groupHostReplyCooldownMs: boundedInteger(raw.groupHostReplyCooldownMs, {
  name: 'groupHostReplyCooldownMs', fallback: 180_000, min: 60_000, max: 900_000,
}),
```

Register safe dashboard-assistant field schemas and add disabled/empty defaults to `config.example.json`.

**Step 4: Run the test to verify it passes**

Run: `node src/config.test.mjs`

Expected: `CONFIG_TEST_OK`.

**Step 5: Commit**

```bash
git add src/config.mjs src/config-assistant.mjs config.example.json src/config.test.mjs
git commit -m "feat: add group host mode configuration"
```

### Task 2: Deterministic host eligibility and reply contract

**Files:**
- Create: `src/group-host-mode.mjs`
- Create: `src/group-host-mode.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Cover:

```js
assert.equal(assessGroupHostCandidate({ enabled: true, allowlisted: true,
  chatType: 'group', messageType: 'text', text: '大家怎么看 AI Agent 对项目协作的影响？' }).eligible, true);
assert.equal(assessGroupHostCandidate({ enabled: true, allowlisted: true,
  chatType: 'group', messageType: 'text', text: '收到' }).eligible, false);
assert.equal(assessGroupHostCandidate({ enabled: true, allowlisted: false,
  chatType: 'group', messageType: 'text', text: '大家怎么看这个方案？' }).eligible, false);
```

Also cover greetings, announcements without discussion cues, messages addressed to another member, direct AIPRO aliases, and substantive viewpoints/cases/news/proposals.

Test `buildGroupHostDecisionPrompt`, strict JSON parsing, fail-closed behavior, and `normalizeGroupHostReply` enforcing 60–180 characters with one final open question.

**Step 2: Run the test to verify it fails**

Run: `node src/group-host-mode.test.mjs`

Expected: FAIL because the module does not exist.

**Step 3: Implement the minimal module**

Export:

```js
assessGroupHostCandidate(input) -> { eligible, reasonCode, topic }
buildGroupHostDecisionPrompt({ candidate, laterMessages }) -> string
parseGroupHostDecision(output, { threshold: 0.84 }) -> { shouldHost, confidence, reasonCode }
buildGroupHostReplyPrompt({ candidate, recentMessages }) -> string
normalizeGroupHostReply(output) -> string
relatedHumanReply(candidate, laterMessages) -> boolean
```

Use existing `evaluateDiscussionValue`, `semanticTopic`, and `compareSemanticTopics`. Never treat a same-sender elaboration as another member picking up the topic. Decision and reply prompts must not allow business mutations or invented group consensus.

**Step 4: Run the test to verify it passes**

Run: `node src/group-host-mode.test.mjs`

Expected: `GROUP_HOST_MODE_TEST_OK`.

**Step 5: Commit**

```bash
git add src/group-host-mode.mjs src/group-host-mode.test.mjs package.json
git commit -m "feat: classify delayed group host topics"
```

### Task 3: Persistent candidate queue

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`

**Step 1: Write the failing state tests**

Test scheduling is idempotent by source message ID, due candidates are atomically claimed once, completion records a resolution, failures retry with a future due time, stale processing is recovered, and only three pending candidates remain per chat.

**Step 2: Run the state test to verify it fails**

Run: `node src/state.test.mjs`

Expected: FAIL because candidate methods do not exist.

**Step 3: Add the schema and methods**

Create `group_host_candidate` with:

```sql
message_id TEXT PRIMARY KEY,
chat_id TEXT NOT NULL,
sender_id TEXT NOT NULL,
text TEXT NOT NULL,
topic TEXT NOT NULL,
status TEXT NOT NULL,
attempts INTEGER NOT NULL DEFAULT 0,
created_at_ms INTEGER NOT NULL,
due_at_ms INTEGER NOT NULL,
updated_at_ms INTEGER NOT NULL,
resolution TEXT NOT NULL DEFAULT '',
last_error TEXT NOT NULL DEFAULT ''
```

Add indexes on `(status, due_at_ms)` and `(chat_id, status)`. Add `scheduleGroupHostCandidate`, `claimDueGroupHostCandidate`, `completeGroupHostCandidate`, `retryGroupHostCandidate`, `recoverGroupHostCandidates`, `pendingGroupHostCount`, and `groupHostStats`. Cap stored text at 4,000 characters and never place raw text in audit details.

**Step 4: Run the state test to verify it passes**

Run: `node src/state.test.mjs`

Expected: `STATE_TEST_OK`.

**Step 5: Commit**

```bash
git add src/state.mjs src/state.test.mjs
git commit -m "feat: persist delayed group host candidates"
```

### Task 4: Due-candidate processor

**Files:**
- Modify: `src/group-host-mode.mjs`
- Modify: `src/group-host-mode.test.mjs`

**Step 1: Write processor tests**

Use fakes for state, classifier, answer generator, send, takeover, and clock. Prove that another member's related reply cancels; same-sender elaboration does not; human takeover suppresses; cooldown suppresses; classifier failure is silent; an unanswered topic produces exactly one normalized host reply mentioning the source sender; and send failure releases the candidate for bounded retry.

**Step 2: Run the test to verify it fails**

Run: `node src/group-host-mode.test.mjs`

Expected: FAIL because `processGroupHostCandidate` does not exist.

**Step 3: Implement the processor**

Export:

```js
processGroupHostCandidate({
  candidate, recentMessages, nowMs, takeoverActive, cooldownActive,
  runDecisionClassifier, runReplyGenerator, send,
}) -> { action, reasonCode }
```

The processor must recheck later messages, fail closed, generate one reply, and call the supplied `send` exactly once. It must not access channels directly.

**Step 4: Run the test to verify it passes**

Run: `node src/group-host-mode.test.mjs`

Expected: `GROUP_HOST_MODE_TEST_OK`.

**Step 5: Commit**

```bash
git add src/group-host-mode.mjs src/group-host-mode.test.mjs
git commit -m "feat: process silent group host topics"
```

### Task 5: Runtime integration

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/semantic-group-engagement.mjs`
- Modify: `src/semantic-group-engagement.test.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write failing integration-level tests**

Add tests proving allowlisted public topics return a deferred host action while explicit mention, direct alias, continuation, messages addressed to others, and non-allowlisted groups preserve existing behavior. Add mechanism acceptance cases for grace period, human pickup, and single-send recovery.

**Step 2: Run focused tests to verify they fail**

Run:

```bash
node src/semantic-group-engagement.test.mjs
node src/mechanism-acceptance.test.mjs
```

Expected: FAIL on missing host-mode behavior.

**Step 3: Integrate scheduling and the worker**

In the non-mention group branch, preserve immediate `reply_explicit`, `reply_named`, and `reply_continuation`. When host eligibility succeeds, persist the candidate and return without generating a reply.

Start `runGroupHostLoop` from `main`. It polls every 2 seconds, atomically claims one due candidate, loads `state.chatHistory(chatId, 30)`, checks `readHumanTakeover`, checks the per-chat last host reply time, runs the bounded decision and reply AI prompts, and calls:

```js
sendText(null, candidate.chatId, reply,
  `aipro-group-host-${candidate.messageId}`,
  { mentionSenderId: candidate.senderId, chatType: 'group' })
```

On success, persist `semantic_group_reply` and `group_host_last_reply`; on failure, retry at most three times. On shutdown, the loop exits through the existing `stopping` flag.

**Step 4: Run focused tests to verify they pass**

Run the two focused commands again.

Expected: `SEMANTIC_GROUP_ENGAGEMENT_TEST_OK` and `MECHANISM_ACCEPTANCE_OK`.

**Step 5: Commit**

```bash
git add src/index.mjs src/semantic-group-engagement.mjs src/semantic-group-engagement.test.mjs src/mechanism-acceptance.test.mjs
git commit -m "feat: run delayed host mode in selected groups"
```

### Task 6: Enable the local test group and verify

**Files:**
- Modify locally only: `config.local.json`

**Step 1: Enable the test group locally**

Set `groupHostModeEnabled` to `true`, add the known test-group channel chat ID to `groupHostChatIds`, keep `groupHostSilenceMs` at `75000`, and keep `groupHostReplyCooldownMs` at `180000`. Do not commit the real group ID.

**Step 2: Run focused tests**

Run:

```bash
node src/config.test.mjs
node src/group-host-mode.test.mjs
node src/state.test.mjs
node src/semantic-group-engagement.test.mjs
```

Expected: all commands exit zero with their `*_TEST_OK` markers.

**Step 3: Run the complete suite**

Run: `npm test`

Expected: exit zero; mechanism acceptance reports zero failures.

**Step 4: Restart and health-check the service**

Use the existing install/restart workflow, then run `node scripts/health-check.mjs` and inspect recent service logs for group-host errors. Do not send a synthetic test-group message.

**Step 5: Review and commit any final tracked changes**

Stage only host-mode source, tests, safe example configuration, and documentation. Exclude `config.local.json`, `outputs/`, credentials, logs, and unrelated dirty files.

**Step 6: Push**

Push the completed commits after verifying the remote base has not advanced.
