# Semantic Repeat Circuit Breaker Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Stop group-chat semantic ping-pong after at most two AIPRO replies while allowing materially new information to resume the conversation.

**Architecture:** Add a deterministic local classifier that produces a normalized topic signature and structured new-information signals. Persist one rolling topic record per channel/group/sender in SQLite and atomically claim `process`, `close`, or `suppress` before the AI runtime is called. Integrate the guard only for DingTalk and Feishu group messages, expose content-free health counters, and leave direct messages and all existing transport paths unchanged.

**Tech Stack:** Node.js ES modules, `node:sqlite`, `node:test`-style assertions used by the repository, existing AIPRO audit/status/config infrastructure.

---

### Task 1: Deterministic semantic topic comparison

**Files:**
- Create: `src/semantic-repeat-guard.mjs`
- Create: `src/semantic-repeat-guard.test.mjs`

**Step 1: Write the failing tests**

Cover mention removal, punctuation/acknowledgement normalization, exact repeat detection, conservative paraphrase detection, changed URL/Issue/date/number signals, explicit continuation reset, and short ambiguous-message fail-open behaviour.

**Step 2: Run the focused test and verify failure**

Run: `node src/semantic-repeat-guard.test.mjs`

Expected: FAIL because `semantic-repeat-guard.mjs` does not exist.

**Step 3: Implement the minimal pure functions**

Export:

- `normalizeSemanticText(text)`
- `semanticTopic(text)` returning normalized text, signature, structured signals, and reset flag
- `compareSemanticTopics(previous, current)` returning `repeat` and diagnostic similarity

Use local hashing and character shingles only. Exact normalized short messages may match; non-exact short messages fail open. Any changed non-empty structured signal fails open as new information.

**Step 4: Run the focused test and verify pass**

Run: `node src/semantic-repeat-guard.test.mjs`

Expected: PASS.

**Step 5: Commit**

Commit only the two new module files.

### Task 2: Durable atomic repeat claims

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`

**Step 1: Write failing state tests**

Create temporary SQLite state and assert:

- first topic returns `process` with count 1;
- first repeat returns `close` with count 2;
- later repeats return `suppress`;
- a materially new topic returns `process` with a reset;
- different chat/sender keys are isolated;
- expired topics reset;
- two sequential claims cannot both receive `close`.

**Step 2: Run the state test and verify failure**

Run: `node src/state.test.mjs`

Expected: FAIL because repeat state methods are absent.

**Step 3: Add the SQLite table and claim method**

Add a `semantic_repeat_guard` table keyed by `channel, chat_id, sender_id`. Store the topic snapshot, reply count, timestamps, and expiry. Implement `claimSemanticRepeat(...)` inside an immediate transaction and `semanticRepeatStats()` for content-free observability. Extend maintenance pruning for expired records.

**Step 4: Run the state test and verify pass**

Run: `node src/state.test.mjs`

Expected: PASS.

**Step 5: Commit**

Commit only `src/state.mjs` and `src/state.test.mjs` if they contain no unrelated user edits; otherwise leave the scoped diff uncommitted and document it.

### Task 3: Configuration and status visibility

**Files:**
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `src/dashboard-server.mjs`
- Modify: `src/dashboard-model.mjs`
- Modify: relevant config/dashboard tests

**Step 1: Write failing configuration and status tests**

Assert defaults: enabled, 30-minute window, two replies, DingTalk and Feishu group channels. Assert bounds reject unsafe values. Assert status contains only counts/timestamps/reasons, never normalized message text.

**Step 2: Run focused tests and verify failure**

Run the relevant config, dashboard model, and dashboard API tests.

Expected: FAIL because semantic-repeat configuration/status fields are absent.

**Step 3: Implement minimal config and status fields**

Add:

- `semanticRepeatGuardEnabled`
- `semanticRepeatWindowMs`
- `semanticRepeatMaxReplies`

Expose suppression totals and the latest audit metadata in the existing maintenance/status object without message content.

**Step 4: Run focused tests and verify pass**

Expected: PASS.

**Step 5: Commit scoped changes where safe**

Do not include unrelated user changes.

### Task 4: Pre-runtime group-chat integration

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Create or modify a focused integration test if needed

**Step 1: Write failing integration tests**

Prove:

- direct messages bypass the guard;
- unsupported channels bypass the guard;
- first group message reaches normal processing;
- second repeat sends exactly `这个话题我们先到这里，有新情况再 @ 我。` without invoking Codex;
- third repeat is completed silently without invoking Codex or sending;
- new facts and explicit continuation reach normal processing;
- suppression is audited with channel/chat/sender/count/similarity but no message content.

**Step 2: Run focused tests and verify failure**

Run: `node src/mechanism-acceptance.test.mjs`

Expected: FAIL because the pre-runtime semantic claim is not integrated.

**Step 3: Integrate before workflow classification and Codex**

After authentication, human-takeover handling, and group mention validation—but before conversation memory, Multica feedback routing, workflow classification, and `runCodex`—build the topic and claim state. On `close`, send the deterministic closing reply with the existing message-derived idempotency key. On `suppress`, audit and return. On `process`, continue unchanged.

Exclude media-only messages and control commands from semantic suppression. Ensure the closing reply itself is covered by the existing outbound-echo guard.

**Step 4: Run focused tests and verify pass**

Expected: PASS.

**Step 5: Commit scoped changes where safe**

Do not overwrite the pre-existing `src/index.mjs` changes.

### Task 5: Regression, restart, and live verification

**Files:**
- No new files unless a defect is found

**Step 1: Run focused suites**

Run semantic guard, state, IM channel, polling, human takeover, mechanism acceptance, dashboard, and configuration tests.

Expected: all PASS.

**Step 2: Run the full repository suite**

Run: `npm test`

Expected: exit 0. If an unrelated pre-existing failure remains, isolate and report it with evidence; do not hide it.

**Step 3: Inspect the scoped diff**

Verify no credential, message content, unrelated user edit, or generated output is staged.

**Step 4: Restart through the existing service mechanism**

Restart only after tests pass. Do not disable or reconfigure Feishu, DingTalk, Codex, or Multica.

**Step 5: Verify health and containment**

Check the local status endpoint, process liveness, polling, event consumers, DingTalk and Feishu health, Codex runtime, Multica synchronization, dead-letter counts, and semantic-repeat counters. Do not send unsolicited live test messages.

**Step 6: Remove temporary containment only after the permanent guard is live**

Clear the single-chat temporary human-takeover state and confirm subsequent repeats would be handled by the permanent guard.

