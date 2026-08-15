# Daily Briefing Dual-Channel Delivery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Extend the existing 10:00 daily AI briefing automation so one generated briefing is delivered to both its current DingTalk group and the configured personal WeChat group without creating another automation.

**Architecture:** Add a tested GeWe briefing delivery module and thin CLI that read the target from configuration, the token from Keychain, the message from stdin, and reuse the durable mutation execution ledger for per-day idempotency. Update automation `ai` through the Codex automation API while preserving its schedule, model, status, project, and DingTalk behavior.

**Tech Stack:** Node.js ESM, GeWe REST through `GeWeChannel`, SQLite `AgentState`, macOS Keychain, Codex recurring automation, Node assert tests.

---

### Task 1: Add explicit personal WeChat briefing destination configuration

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `config.example.json`
- Modify: `config.distribution.json`
- Modify locally: `config.local.json`

**Step 1:** Write failing configuration assertions for `geweDailyBriefingGroupId` and `geweDailyBriefingGroupName`.

**Step 2:** Run `node src/config.test.mjs` and confirm the fields are missing.

**Step 3:** Add bounded fields and validate that ID/name are configured together and the ID ends with `@chatroom`.

**Step 4:** Run `node src/config.test.mjs` and confirm `CONFIG_TEST_OK`.

### Task 2: Build the idempotent GeWe briefing delivery domain module

**Files:**
- Create: `src/gewe-daily-briefing.mjs`
- Create: `src/gewe-daily-briefing.test.mjs`

**Step 1:** Write failing tests for first delivery, same-day replay, ordinary no-mention send, and group-name mismatch.

**Step 2:** Run `node src/gewe-daily-briefing.test.mjs` and confirm failure because the module is absent.

**Step 3:** Implement validation, live group-name verification, a stable execution key, and `executeMutationOnce` wrapping `GeWeChannel.send`.

**Step 4:** Run the test and confirm `GEWE_DAILY_BRIEFING_TEST_OK`.

### Task 3: Add a secure local CLI

**Files:**
- Create: `scripts/send-gewe-daily-briefing.mjs`
- Create: `scripts/send-gewe-daily-briefing.test.mjs`
- Modify: `src/channel-credentials.mjs`
- Modify: `src/channel-credentials.test.mjs`

**Step 1:** Write failing tests for Keychain read export, stdin-only content, required `--date`, structured output, and secret redaction.

**Step 2:** Run both tests and observe the expected failures.

**Step 3:** Export a validated Keychain read helper and implement the CLI with dependency injection for tests.

**Step 4:** Run both tests and confirm their success markers.

### Task 4: Update the existing automation in place

**Files:**
- Update through automation API: automation ID `ai`
- Preserve: `/Users/Administrator/.codex/automations/ai/memory.md`

**Step 1:** View automation `ai` and capture its full fields.

**Step 2:** Update only the prompt content needed for shared generation and the second WeChat delivery; preserve name, RRULE, status, model, reasoning effort, project, and local execution.

**Step 3:** View automation `ai` again and assert one 10:00 automation, the original DingTalk command, the new WeChat script command, and explicit no-@ behavior.

### Task 5: Verify, deploy, and publish

**Files:**
- Modify: `package.json` test/check lists if needed

**Step 1:** Run focused tests for config, credentials, delivery domain, CLI, mutation execution, and GeWe runtime.

**Step 2:** Run `npm run check && npm test` and require exit code 0.

**Step 3:** Run `git diff --check`, review scoped changes, and preserve unrelated user files.

**Step 4:** Commit scoped tracked files and push `HEAD:main`.

**Step 5:** View automation `ai` after the push and report its next behavior without sending a test message.
