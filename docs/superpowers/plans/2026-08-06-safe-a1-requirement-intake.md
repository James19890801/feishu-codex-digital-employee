# Safe A1 Requirement Intake Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn DingTalk requirement messages directly into contextual, correctly routed, read-back A1 workitems.

**Architecture:** Run A1 intake before first-contact greeting, pass conversation context and requester metadata, degrade repository evidence failures, and execute recognized mutations immediately without authorization or confirmation gates.

**Tech Stack:** Node.js ESM, `node:assert/strict`, SQLite-backed `PendingActionStore`, a1 CLI adapter.

## Global Constraints

- Preserve all unrelated dirty workspace changes.
- Recognized DingTalk requests mutate A1 without an Owner confirmation gate.
- Unknown products never default to WebAgent.
- A1 mutations must include assignee when specified and return authoritative readback.
- Repository search failure must not discard an otherwise actionable request.

---

### Task 1: Intent and route safety

**Files:**
- Modify: `src/a1-requirements.test.mjs`
- Modify: `src/a1-requirements.mjs`

**Interfaces:**
- Consumes: natural-language messages and product names.
- Produces: `classifyRequirementIntent(message)` and `resolveProductRoute(product)` with fail-closed routing.

- [ ] Add failing tests for “帮他建一个 1A 需求”, full WebAgent intake, and unknown product rejection.
- [ ] Run `node src/a1-requirements.test.mjs` and verify expected failures.
- [ ] Implement the minimal intent and route changes.
- [ ] Re-run the test and verify it passes.

### Task 2: Direct contextual workflow

**Files:**
- Modify: `src/a1-workflow.test.mjs`
- Modify: `src/a1-workflow.mjs`

**Interfaces:**
- Consumes: `{ chatId, senderId, chatType, messageId, text, history, requester, assignee }`.
- Produces: direct create or update receipts from A1 readback.

- [ ] Add failing tests proving external requests mutate directly, assignee is forwarded when present, missing assignee does not block, and unknown routes remain unresolved.
- [ ] Run `node src/a1-workflow.test.mjs` and verify expected failures.
- [ ] Implement direct create and update behavior with authoritative readback.
- [ ] Re-run the workflow tests and verify they pass.

### Task 3: Runtime ordering and evidence degradation

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/a1-spec-planner.test.mjs` or add a focused exported helper test.

**Interfaces:**
- Consumes: live DingTalk metadata, recent conversation history, and repository lookup results.
- Produces: A1 workflow context before greeting and a specification even when repository evidence is unavailable.

- [ ] Add a failing test for repository-search degradation and runtime context construction.
- [ ] Run the focused test and verify expected failure.
- [ ] Move A1 intake before greeting without disturbing unrelated runtime recovery edits.
- [ ] Pass history, requester, and assignee context.
- [ ] Convert repository lookup failures into explicit no-evidence planning input.
- [ ] Run focused tests and `npm run test:a1`.

### Task 4: Full verification

**Files:**
- Verify all modified files and existing workspace changes without altering unrelated files.

**Interfaces:**
- Consumes: completed implementation.
- Produces: fresh syntax, targeted, and full-suite evidence.

- [ ] Run `npm run precheck`.
- [ ] Run `npm run test:a1`.
- [ ] Run `npm test`.
- [ ] Inspect `git diff --check` and the scoped diff.
- [ ] Run `a1 skill report a1 --location /Users/fengzhouchong.fzc/.agents/skills`.
