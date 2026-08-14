# Nightly Knowledge Wiki Implementation Plan

> **For Codex:** Follow this plan task-by-task with tests failing before implementation and verification before completion.

**Goal:** Build an owner-private incremental knowledge pipeline for DWS Channel, Codex sessions and local artifacts, then run it every day at 18:00.

**Architecture:** A dependency-injected Node.js synchronizer gathers source records, sanitizes and deduplicates them, writes an atomic local Markdown Wiki and optionally mirrors the daily page into DingTalk Wiki. Runtime retrieval loads the local index dynamically and enforces owner-only access.

**Tech Stack:** Node.js ESM, built-in test/assert/fs/child_process/crypto, standalone DWS CLI, Codex automation heartbeat.

---

### Task 1: Define the deterministic knowledge model

- [x] Add failing tests for redaction, stable dedupe, source failure semantics and daily Markdown rendering.
- [x] Implement pure normalization, redaction, dedupe and rendering helpers.
- [x] Run the focused tests.

### Task 2: Implement incremental collectors

- [x] Add failing tests for DWS command construction and channel environment isolation.
- [x] Add failing tests for incremental Codex JSONL and local artifact collection.
- [x] Implement bounded collectors with dependency-injected command execution and filesystem roots.
- [x] Verify that source failures do not advance checkpoints.

### Task 3: Build the local Wiki transaction

- [x] Add failing integration tests using temporary directories and fake sources.
- [x] Implement lock, atomic state/index/daily writes and content-hash idempotency.
- [x] Add CLI arguments for dry-run, initial lookback and optional DingTalk publishing.

### Task 4: Connect owner-private runtime retrieval

- [x] Add failing tests for dynamic reload, keyword ranking and owner-only access.
- [x] Implement local Wiki search with strict character limits.
- [x] Inject grounded local Wiki context into the AIPR0S reply path without requiring restart.

### Task 5: Create the DingTalk Wiki mirror

- [x] Resolve or create the dedicated Wiki space through DWS Channel.
- [x] Find or create the daily adoc node and overwrite the system-owned mirror by content hash.
- [x] Read back the node metadata/content to prove delivery.

### Task 6: Schedule and verify

- [x] Create an active Codex heartbeat automation for 18:00 Asia/Shanghai.
- [x] Run focused tests, full tests, syntax checks and a dry-run against the real DWS Channel.
- [x] Run the first real synchronization and inspect the generated source-status summary.
- [x] Commit, push and confirm local HEAD equals the remote branch HEAD.
