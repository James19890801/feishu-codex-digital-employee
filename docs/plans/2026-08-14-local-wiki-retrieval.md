# Local Wiki Retrieval Enhancement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an on-device Wiki and evidence-gated retrieval layer from the user's local knowledge, prioritizing authored WeChat public-account HTML, and inject only safely abstracted knowledge into every IM channel's shared answer path.

**Architecture:** A read-only scanner discovers likely authored article HTML while excluding sensitive and generated locations. An incremental compiler extracts clean text, redacts private entities, writes a local Wiki plus a searchable on-device index, and exposes an evidence-gated retrieval API. The shared response pipeline calls that API adaptively and never exposes provenance or sensitive project context to external users.

**Tech Stack:** Node.js ESM, built-in HTML normalization, SQLite/JSON local index depending on existing runtime support, Markdown Wiki pages, existing unified IM pipeline and assertion-style tests.

---

### Task 1: Define scanning and privacy contracts

**Files:**
- Create: `src/local-wiki-policy.mjs`
- Create: `src/local-wiki-policy.test.mjs`

1. Write failing tests for included article HTML, excluded system/dependency/cache paths, sensitive entity removal, generic case abstraction and safe source handles.
2. Run `node src/local-wiki-policy.test.mjs` and verify failure.
3. Implement deterministic inclusion, exclusion and redaction helpers.
4. Run the test and verify `LOCAL_WIKI_POLICY_TEST_OK`.

### Task 2: Build the incremental article scanner and compiler

**Files:**
- Create: `src/local-wiki-index.mjs`
- Create: `src/local-wiki-index.test.mjs`
- Create: `scripts/build-local-wiki.mjs`

1. Write failing fixture tests for HTML extraction, WeChat-article detection, stable hashes, deduplication and incremental updates.
2. Run `node src/local-wiki-index.test.mjs` and verify failure.
3. Implement read-only discovery, HTML-to-text extraction, safe chunking and Wiki/index persistence.
4. Run the focused tests.
5. Run a dry inventory against `/Users/Administrator` and inspect counts without writing derived content.
6. Build the initial Wiki into the app's private runtime data directory.

### Task 3: Implement evidence-gated hybrid retrieval

**Files:**
- Create: `src/local-wiki-retrieval.mjs`
- Create: `src/local-wiki-retrieval.test.mjs`

1. Write failing tests for professional-query routing, conversational bypass, BM25-style keyword scoring, semantic fallback, minimum evidence thresholds, conflicts and empty results.
2. Run the test and verify failure.
3. Implement query routing, hybrid scoring and evidence packets containing only redacted text and opaque handles.
4. Run the focused test and verify `LOCAL_WIKI_RETRIEVAL_TEST_OK`.

### Task 4: Connect retrieval to the shared answer pipeline

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/privacy-boundary.mjs`
- Modify: `src/privacy-boundary.test.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

1. Write failing assertions proving WeChat and Feishu share the same retrieval injection path and that source paths/names never appear in prompts or replies.
2. Run the focused tests and verify failure.
3. Load the local index lazily, retrieve before prompt construction and inject only safe evidence packets.
4. Add a final leak scan and one retry without local context when a protected entity is detected.
5. Verify focused tests pass.

### Task 5: Add continuous refresh and observability

**Files:**
- Create: `scripts/refresh-local-wiki.mjs`
- Modify: `package.json`
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-model.test.mjs`

1. Write failing tests for last-index time, source/chunk counts, skipped-sensitive count and failure state.
2. Implement incremental refresh command and health status without exposing paths or titles.
3. Add package scripts for dry inventory, full build and incremental refresh.
4. Run focused tests.

### Task 6: Full verification and live acceptance

**Files:**
- Modify: `README`

1. Run all local Wiki tests.
2. Run the full project test suite.
3. Build the initial Wiki and record only aggregate counts.
4. Test one matching professional question, one unrelated question and one seeded sensitive example.
5. Restart the service and confirm all configured channels remain healthy.
6. Document operation, privacy boundaries and recovery steps without listing private source locations.
