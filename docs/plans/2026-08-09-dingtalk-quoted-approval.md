# DingTalk Quoted Approval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow the verified DingTalk Owner to approve exactly one pending Multica group mutation by natively quoting its authorization request and replying “同意”.

**Architecture:** Preserve DingTalk `quoted_message` / `quotedMessage` identifiers at the channel boundary, persist a small set of pending quoted approvals in SQLite-backed settings, and poll only groups with active approvals because DingTalk personal event streams filter the logged-in user's own messages. Keep general group writes denied; only the dedicated quoted-approval path may call the approved Multica mutation method.

**Tech Stack:** Node.js ESM, built-in SQLite through `AgentState`, DWS DingTalk event and conversation APIs, `node:assert`, existing mutation idempotency and audit infrastructure.

---

### Task 1: Preserve native DingTalk quote identity

**Files:**
- Modify: `src/im-channels.mjs`
- Test: `src/im-channels.test.mjs`

**Step 1: Write the failing tests**

Add event-stream and history-poll fixtures containing `quoted_message` and `quotedMessage`. Assert that normalized metadata contains the quoted open message ID, conversation ID, sender ID and content. Assert that ordinary messages have no quoted-message metadata.

**Step 2: Run the test to verify it fails**

Run: `node src/im-channels.test.mjs`

Expected: FAIL because normalized metadata does not yet expose a quoted message.

**Step 3: Write the minimal implementation**

Add one normalization helper accepting snake_case and camelCase DWS payloads. Map only server-provided identity fields; never infer a quote from visible text.

**Step 4: Run the test to verify it passes**

Run: `node src/im-channels.test.mjs`

Expected: `IM_CHANNELS_TEST_OK`.

**Step 5: Commit**

Commit message: `feat: preserve DingTalk quote identity`

### Task 2: Add durable pending quoted-approval state

**Files:**
- Create: `src/quoted-approval.mjs`
- Create: `src/quoted-approval.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing tests**

Define the desired `QuotedApprovalStore` API and test:

- bind a unique outbound authorization-message ID to a pending payload;
- list only chat IDs with live approvals;
- inspect without consuming for non-Owner rejection;
- claim once in the matching chat;
- reject cross-chat, expired, unknown and duplicate claims;
- recognize exact “同意” with optional terminal punctuation, but not embedded or unrelated text;
- identify a verified DingTalk Owner group approval context.

**Step 2: Run the test to verify it fails**

Run: `node src/quoted-approval.test.mjs`

Expected: FAIL because the module does not exist.

**Step 3: Write the minimal implementation**

Persist a bounded record map under an `AgentState` settings scope. Prune expired records on every access. Claim by deleting before execution so a crash fails closed; existing mutation execution keys prevent duplicate external writes.

**Step 4: Run the test to verify it passes**

Run: `node src/quoted-approval.test.mjs`

Expected: `QUOTED_APPROVAL_TEST_OK`.

**Step 5: Commit**

Commit message: `feat: add durable quoted approval store`

### Task 3: Add an explicitly approved Multica mutation path

**Files:**
- Modify: `src/multica-capability.mjs`
- Test: `src/multica-capability.test.mjs`

**Step 1: Write the failing tests**

Assert that:

- the existing `prepareMutation` still rejects all unauthorized group contexts;
- `prepareMutationApproval` may build a preview for a DingTalk group requester but performs no write;
- `applyApprovedMutation` rejects non-Owner approvers and cross-chat approvals;
- a verified DingTalk Owner can apply the prepared mutation once while origin/follow-up records remain attributed to the original requester.

**Step 2: Run the test to verify it fails**

Run: `node src/multica-capability.test.mjs`

Expected: FAIL because the approval-specific methods do not exist.

**Step 3: Write the minimal implementation**

Extract private preview and apply bodies. Keep existing methods and authorization unchanged. Add explicit approval methods with a separately injected `authorizeApproval` predicate and same-chat validation; never treat an arbitrary Owner group message as general write authorization.

**Step 4: Run the test to verify it passes**

Run: `node src/multica-capability.test.mjs`

Expected: `MULTICA_CAPABILITY_TEST_OK`.

**Step 5: Commit**

Commit message: `feat: apply explicitly approved Multica mutations`

### Task 4: Connect group previews, Owner quote handling and active-group polling

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/im-channels.mjs`
- Modify: `src/im-channels.test.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Test: `src/quoted-approval.test.mjs`

**Step 1: Write the failing tests**

Add acceptance assertions covering:

- DingTalk group mutations prepare an authorization request instead of writing or requiring self-chat;
- the authorization request @mentions the configured Owner and stores the returned outbound message ID;
- isolated Owner “同意” requests a native quote and does not execute;
- non-Owner quoted “同意” is denied without consuming the request;
- verified Owner quoted “同意” claims the matching request and executes via `executeMutationOnce`;
- group-history normalization preserves `quotedMessage` so polled Owner messages can authorize;
- only chats with active approvals are polled, and polling stops when no live approval remains;
- existing Owner self-chat confirmation remains supported.

**Step 2: Run focused tests to verify they fail**

Run: `node src/quoted-approval.test.mjs && node src/im-channels.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: FAIL on missing integration contracts.

**Step 3: Write the minimal implementation**

Instantiate the quoted-approval store. Route eligible DingTalk group mutation plans to approval previews. Bind the DWS outbound open message ID after a successful send. Intercept candidate approvals after takeover checks but before semantic group filtering. Add a lightweight polling loop that calls `chat message list` only for active approval chats and reuses inbound deduplication/echo protection.

**Step 4: Run focused tests to verify they pass**

Run: `node src/quoted-approval.test.mjs && node src/im-channels.test.mjs && node src/multica-access.test.mjs && node src/multica-capability.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: all named suites pass and mechanism acceptance reports zero failures.

**Step 5: Commit**

Commit message: `feat: approve DingTalk group mutations by quote`

### Task 5: Verify and publish

**Files:**
- Review all files changed on this branch.

**Step 1: Run syntax and whitespace checks**

Run: `pnpm check && git diff --check origin/main...HEAD`

Expected: exit code 0.

**Step 2: Run the complete test suite**

Run: `pnpm test`

Expected: exit code 0 and mechanism acceptance has zero failures.

**Step 3: Inspect scope**

Run: `git status -sb && git diff --stat origin/main...HEAD && git log --oneline origin/main..HEAD`

Expected: only design, plan, quoted-approval, DingTalk channel, Multica capability, runtime integration and associated tests are included.

**Step 4: Push and open a draft pull request**

Run: `git push -u origin codex/dingtalk-quoted-approval`, then create a draft PR targeting `main` with validation evidence.
