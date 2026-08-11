# Required Daily Minutes Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 18:00 knowledge automation treat the current day's DingTalk AI minutes as a required, retried, fully read source.

**Architecture:** The existing collector will use the atomic `minutes list all` command with an Asia/Shanghai day window, bounded pagination, and injected retry waiting. Source-level failure remains isolated in `runNightlyKnowledgeSync`, so unread minutes retain their checkpoint while other sources and the daily report continue.

**Tech Stack:** Node.js ESM, built-in assert, standalone DWS CLI, Codex heartbeat TOML.

## Global Constraints

- Only use the `config.local.json` standalone DWS binary, profile, and command-level `DWS_CHANNEL`.
- Never fall back to Wukong DWS or `~/.real/.bin/dws`.
- A failed or unexpectedly empty daily minutes read is `unread`, never zero activity, and cannot advance the minutes cursor.
- Preserve unrelated dirty working-tree files.

---

### Task 1: Required daily minutes collector

**Files:**
- Modify: `scripts/nightly-knowledge-sync.test.mjs`
- Modify: `scripts/nightly-knowledge-sync.mjs`

**Interfaces:**
- Consumes: injected `runDws(args)`, `now`, retry count, and wait function.
- Produces: `collectDwsMinutes(...) -> { status: 'ok', cursor, records }`, or throws a precise unread cause.

- [ ] Add a real-shape test where the first daily list is empty and the retry returns `result.itemList` with `uuid` and `shareUrl`.
- [ ] Run `node scripts/nightly-knowledge-sync.test.mjs` and confirm it fails because the current collector accepts the empty list.
- [ ] Implement Asia/Shanghai day-window listing, up-to-30 pagination, retry with verbose timeout, UUID parsing, and required detail content.
- [ ] Add and run the persistent-empty and pagination cases; confirm all focused tests pass.

### Task 2: Automation hard gate

**Files:**
- Modify: `/Users/fengzhouchong.fzc/.codex/automations/aipr0s/automation.toml`

**Interfaces:**
- Consumes: the knowledge-sync JSON report and direct DWS diagnostic output.
- Produces: an automation run that retries `minutes` when unread or zero and only reports success after local/remote readback.

- [ ] Update the heartbeat prompt to require direct `minutes list all` diagnosis and repeat sync on unread/zero results.
- [ ] Read back the TOML and confirm the schedule, target thread, DWS isolation, and new hard gate remain intact.

### Task 3: Live verification and delivery

**Files:**
- Verify: `data/knowledge-wiki/state.json`
- Verify: `data/knowledge-wiki/index.json`
- Verify: `data/knowledge-wiki/daily/2026-08-11.md`

**Interfaces:**
- Consumes: real standalone DWS and the current DingTalk Wiki node.
- Produces: local and remote evidence that the current day's minutes are readable.

- [ ] Run `npm run test:nightly-knowledge`, `node --check scripts/nightly-knowledge-sync.mjs`, and `git diff --check`.
- [ ] Run `npm run knowledge:sync -- --publish --lookback-days 30 --max-pages 1` and inspect the JSON report.
- [ ] Verify local state/index/daily files and use DWS `doc info` plus `doc block list` to read back the exact daily node.
- [ ] Commit only the scoped repository files and push the current branch to Codeup; verify the remote branch SHA.

