# Multimodal End-to-End Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Feishu and DingTalk understand supported links and native attachments, then return workspace artifacts to the originating group or direct conversation.

**Architecture:** Add a channel-neutral content-reference and document-extraction layer between inbound normalization and AI execution. Add a type-aware artifact delivery layer that selects native Feishu media messages and DingTalk file attachments while enforcing only the AIPRO workspace boundary.

**Tech Stack:** Node.js ESM, DingTalk DWS CLI, Lark CLI, Python (`pypdf`, `python-docx`, `openpyxl`, `python-pptx`, `xlrd`), macOS PDFKit/Vision/Quick Look, Node test scripts.

---

### Task 1: Workspace artifact boundary

**Files:**
- Create: `src/workspace-artifact.mjs`
- Create: `src/workspace-artifact.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Cover a regular file inside the workspace, an artifact inside a nested directory, an outside file, and a symlink escaping the workspace. Assert that only the first two resolve.

**Step 2: Run test to verify it fails**

Run: `node src/workspace-artifact.test.mjs`

Expected: FAIL because `workspace-artifact.mjs` does not exist.

**Step 3: Write minimal implementation**

Implement `resolveWorkspaceArtifact(path, workspaceRoot)` using `realpath` and `lstat`. Require a regular non-symlink file whose resolved path is the workspace root or a descendant.

**Step 4: Run test to verify it passes**

Run: `node src/workspace-artifact.test.mjs`

Expected: `WORKSPACE_ARTIFACT_TEST_OK`.

**Step 5: Commit**

```bash
git add src/workspace-artifact.mjs src/workspace-artifact.test.mjs package.json
git commit -m "feat: enforce workspace artifact boundary"
```

### Task 2: Typed public URL downloads

**Files:**
- Modify: `src/web-reader.mjs`
- Modify: `src/web-reader.test.mjs`
- Create: `src/remote-content.mjs`
- Create: `src/remote-content.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing tests**

Test MIME classification for web text, PDF, Office, image, audio and video. Test `Content-Disposition` UTF-8 filenames, bounded binary download, redirect revalidation, private-address rejection and partial-download cleanup.

**Step 2: Run tests to verify they fail**

Run: `node src/remote-content.test.mjs && node src/web-reader.test.mjs`

Expected: FAIL because the binary content API is missing.

**Step 3: Write minimal implementation**

Refactor the shared safe URL validation and pinned DNS lookup into reusable exports without weakening the current web reader. Implement `downloadPublicContent(url, outputDir)` with per-hop validation, response limits, MIME/filename inference and atomic finalization.

**Step 4: Run tests to verify they pass**

Run: `node src/remote-content.test.mjs && node src/web-reader.test.mjs`

Expected: both tests pass.

**Step 5: Commit**

```bash
git add src/web-reader.mjs src/web-reader.test.mjs src/remote-content.mjs src/remote-content.test.mjs package.json
git commit -m "feat: download typed public content safely"
```

### Task 3: Office and scanned-PDF extraction

**Files:**
- Modify: `src/extract_file_text.py`
- Create: `src/extract_file_text.test.mjs`
- Create: `scripts/extract-pdf-ocr.swift`
- Modify: `requirements.txt`
- Modify: `scripts/check-python.mjs`
- Modify: `package.json`

**Step 1: Write the failing tests**

Generate small DOCX, XLSX, PPTX, text HTML and PDF fixtures at runtime. Assert source labels for paragraphs, tables, worksheets, slides and PDF pages. Add a scanned PDF fixture and assert OCR fallback invocation is selected when extracted text is insufficient.

**Step 2: Run test to verify it fails**

Run: `node src/extract_file_text.test.mjs`

Expected: FAIL for XLSX/PPTX and OCR fallback.

**Step 3: Write minimal implementation**

Add `openpyxl`, `python-pptx` and `xlrd`. Extend the extractor for modern Office and legacy spreadsheet formats. Add source labels, character budgeting and structured warnings. Implement PDFKit/Vision OCR helper for pages without usable text; use Quick Look OCR fallback for legacy DOC/PPT when native conversion is unavailable.

**Step 4: Run test to verify it passes**

Run: `node src/extract_file_text.test.mjs && node scripts/check-python.mjs`

Expected: extraction and dependency checks pass.

**Step 5: Commit**

```bash
git add src/extract_file_text.py src/extract_file_text.test.mjs scripts/extract-pdf-ocr.swift requirements.txt scripts/check-python.mjs package.json
git commit -m "feat: extract Office and scanned PDF content"
```

### Task 4: DingTalk file references and downloads

**Files:**
- Modify: `src/multimodal-content.mjs`
- Modify: `src/multimodal-content.test.mjs`
- Modify: `src/im-channels.mjs`
- Modify: `src/im-channels.test.mjs`

**Step 1: Write the failing tests**

Cover `[文件] 周报.pdf fileId: ...` and equivalent spacing, preservation of file name, normalized `message_type: file`, metadata provenance, and `dws drive download --node ... --output ... --format json` arguments.

**Step 2: Run tests to verify they fail**

Run: `node src/multimodal-content.test.mjs && node src/im-channels.test.mjs`

Expected: FAIL because file placeholders are not normalized as downloadable content.

**Step 3: Write minimal implementation**

Add `parseDingTalkFilePlaceholder` and `buildDingTalkDriveDownloadArgs`. Include file metadata in polling and event normalization while retaining the self-echo guard for files sent by AIPRO.

**Step 4: Run tests to verify they pass**

Run: `node src/multimodal-content.test.mjs && node src/im-channels.test.mjs`

Expected: both tests pass.

**Step 5: Commit**

```bash
git add src/multimodal-content.mjs src/multimodal-content.test.mjs src/im-channels.mjs src/im-channels.test.mjs
git commit -m "feat: normalize DingTalk file attachments"
```

### Task 5: Channel-neutral inbound content envelope

**Files:**
- Create: `src/inbound-content.mjs`
- Create: `src/inbound-content.test.mjs`
- Modify: `src/media-context.mjs`
- Modify: `src/media-context.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing tests**

Cover messages containing text plus multiple current attachments, same-sender recent attachments, channel metadata references, URL references and deterministic item ordering. Ensure a failed item produces a warning without dropping successful items.

**Step 2: Run tests to verify they fail**

Run: `node src/inbound-content.test.mjs`

Expected: FAIL because the envelope API is missing.

**Step 3: Write minimal implementation**

Implement content item normalization and bounded aggregation. Keep channel identifiers opaque and record provenance. Extend recent-context selection to multiple files while preserving same sender, same conversation and 30-minute rules.

**Step 4: Run tests to verify they pass**

Run: `node src/inbound-content.test.mjs && node src/media-context.test.mjs`

Expected: both tests pass.

**Step 5: Commit**

```bash
git add src/inbound-content.mjs src/inbound-content.test.mjs src/media-context.mjs src/media-context.test.mjs package.json
git commit -m "feat: normalize inbound multimodal content"
```

### Task 6: Resolve and analyze all inbound items

**Files:**
- Create: `src/content-resolver.mjs`
- Create: `src/content-resolver.test.mjs`
- Modify: `src/index.mjs`
- Modify: `package.json`

**Step 1: Write the failing tests**

Use fake Feishu resources, fake DWS runners, local extractor fixtures and fake public responses. Assert combined text blocks, image paths, video frames, audio transcript, warnings and cleanup for mixed messages.

**Step 2: Run test to verify it fails**

Run: `node src/content-resolver.test.mjs`

Expected: FAIL because the resolver is missing.

**Step 3: Write minimal implementation**

Move download/extraction orchestration out of `processIncoming` into an injected resolver. Run independent items with bounded concurrency, collect partial results and pass all usable content to `runCodex`. Retain existing audit events and add per-item status.

**Step 4: Run tests to verify they pass**

Run: `node src/content-resolver.test.mjs && npm run test:multimodal`

Expected: resolver and existing multimodal tests pass.

**Step 5: Commit**

```bash
git add src/content-resolver.mjs src/content-resolver.test.mjs src/index.mjs package.json
git commit -m "feat: resolve inbound multimodal content"
```

### Task 7: Type-aware Feishu and DingTalk delivery

**Files:**
- Modify: `src/artifact-channel-delivery.mjs`
- Modify: `src/artifact-channel-delivery.test.mjs`
- Create: `src/channel-artifact-delivery.mjs`
- Create: `src/channel-artifact-delivery.test.mjs`
- Modify: `src/index.mjs`
- Modify: `package.json`

**Step 1: Write the failing tests**

Assert Feishu `--image`, `--video` plus cover, `--audio`, and `--file` routes. Assert DingTalk uses `--msg-type file --file-path`, then a caption message. Assert group and direct targets are allowed when the artifact is inside the workspace, while outside and symlink paths are rejected. Assert stable idempotency keys.

**Step 2: Run tests to verify they fail**

Run: `node src/channel-artifact-delivery.test.mjs`

Expected: FAIL because delivery remains Owner-private and file-only.

**Step 3: Write minimal implementation**

Replace the Owner-recipient assertion with the workspace artifact assertion. Route by channel and format. Generate a video cover when required. Keep send echo guards and audit records.

**Step 4: Run tests to verify they pass**

Run: `node src/channel-artifact-delivery.test.mjs && node src/artifact-channel-delivery.test.mjs && node src/multica-artifact-delivery.test.mjs`

Expected: all delivery tests pass.

**Step 5: Commit**

```bash
git add src/artifact-channel-delivery.mjs src/artifact-channel-delivery.test.mjs src/channel-artifact-delivery.mjs src/channel-artifact-delivery.test.mjs src/index.mjs package.json
git commit -m "feat: deliver workspace artifacts by channel"
```

### Task 8: HTML source and preview delivery

**Files:**
- Create: `src/html-preview.mjs`
- Create: `src/html-preview.test.mjs`
- Modify: `src/artifact-channel-delivery.mjs`
- Modify: `src/delivery-routing.mjs`
- Modify: `src/delivery-routing.test.mjs`

**Step 1: Write the failing tests**

Assert `.html` is an allowed artifact, explicit HTML requests create a contract, preview requests request PDF/PNG fallback, and preview failure still delivers the source HTML.

**Step 2: Run tests to verify they fail**

Run: `node src/html-preview.test.mjs && node src/delivery-routing.test.mjs`

Expected: FAIL because HTML is not an artifact format.

**Step 3: Write minimal implementation**

Add HTML format routing. Use a bounded local browser/Quick Look conversion hook for previews and return source-only delivery with a warning on conversion failure.

**Step 4: Run tests to verify they pass**

Run: `node src/html-preview.test.mjs && node src/delivery-routing.test.mjs`

Expected: both tests pass.

**Step 5: Commit**

```bash
git add src/html-preview.mjs src/html-preview.test.mjs src/artifact-channel-delivery.mjs src/delivery-routing.mjs src/delivery-routing.test.mjs
git commit -m "feat: deliver HTML source and previews"
```

### Task 9: Mechanism acceptance and documentation

**Files:**
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `README`
- Modify: `package.json`

**Step 1: Write the failing acceptance cases**

Add acceptance cases for DingTalk file intake, Feishu video intake, public PDF URL routing, group artifact return, workspace escape rejection and partial attachment failure.

**Step 2: Run acceptance to verify it fails**

Run: `node src/mechanism-acceptance.test.mjs`

Expected: FAIL until all cases are registered and implemented.

**Step 3: Complete integration and docs**

Wire all new tests into `npm test`, update capability documentation and remove obsolete statements that files are Owner-private or Office input is unsupported.

**Step 4: Run full verification**

Run:

```bash
DIGITAL_EMPLOYEE_CONFIG=/Users/Administrator/Applications/真人数字员工_Codex/config.local.json npm test
npm run check
git diff --check
```

Expected: all commands exit 0.

**Step 5: Commit**

```bash
git add src/mechanism-acceptance.test.mjs README package.json
git commit -m "test: accept multimodal end-to-end flows"
```

### Task 10: Real Feishu and DingTalk smoke tests

**Files:**
- Create: `scripts/multimodal-smoke.mjs`
- Create: `scripts/multimodal-smoke.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing dry-run test**

Assert the smoke runner resolves only configured test conversations, prints the exact artifact plan in dry-run mode, never sends to an unresolved target, and redacts internal identifiers.

**Step 2: Run test to verify it fails**

Run: `node scripts/multimodal-smoke.test.mjs`

Expected: FAIL because the smoke runner is missing.

**Step 3: Implement the dry-run and live runner**

Create small workspace fixtures for image, PDF, DOCX, XLSX, PPTX, HTML and video. Add inbound checklist output and outbound sends with unique visible test labels and idempotency keys. Live mode must require configured test chat IDs and explicit `--yes`.

**Step 4: Verify dry-run, then execute authorized test-group smoke**

Run:

```bash
node scripts/multimodal-smoke.test.mjs
node scripts/multimodal-smoke.mjs --channels feishu,dingtalk --dry-run
node scripts/multimodal-smoke.mjs --channels feishu,dingtalk --yes
```

Expected: dry-run lists exact targets and artifacts; live run returns successful message identifiers for both configured test conversations.

**Step 5: Final verification and commit**

```bash
DIGITAL_EMPLOYEE_CONFIG=/Users/Administrator/Applications/真人数字员工_Codex/config.local.json npm test
npm run check
npm run health
git status --short
git add scripts/multimodal-smoke.mjs scripts/multimodal-smoke.test.mjs package.json
git commit -m "test: smoke multimodal IM delivery"
```
