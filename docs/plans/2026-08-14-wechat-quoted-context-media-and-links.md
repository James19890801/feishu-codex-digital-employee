# WeChat Quoted Context, Media, Multica, and Link Robustness Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the personal WeChat channel reliably answer quoted questions, understand referenced images, execute authenticated owner Multica requests, proactively read group links, and use the latest 50 same-chat messages from all participants.

**Architecture:** Normalize GeWe quote, sender, media, and link structure at ingress; keep routing decisions deterministic before invoking Codex; preserve bounded same-chat source metadata for on-demand media recovery; reuse the existing safe web reader and Multica confirmation workflow. Exact quoted context is passed separately from the rolling 50-message window, and no historical events are replayed during deployment.

**Tech Stack:** Node.js ESM, `node:test`, GeWe REST/Webhook, SQLite-backed service state, Codex CLI, existing safe web reader and Multica API client.

---

## Task 1: Normalize quote cards and proactive link candidates

**Files:**
- Modify: `src/im-channels.mjs`
- Test: `src/im-channels.test.mjs`

**Step 1: Write failing quote-card tests**

Add GeWe V1 group payload tests for app-message `type=57` covering quoted text, a mention present only in the outer title, decoded `refermsg` fields, malformed XML, and quoted-image XML. Assert clean model-facing content, `metadata.quotedMessage`, `metadata.image`, and a required-response mention signal.

**Step 2: Run the focused test and verify failure**

Run: `node --test src/im-channels.test.mjs`

Expected: new quote-card assertions fail because type 57 is still raw XML.

**Step 3: Implement bounded quote normalization**

Add small XML helpers that decode the outer title and `refermsg` fields without evaluating XML. Limit decoded field lengths. For referenced images, decode the embedded image XML into the normal image metadata shape. Keep malformed payloads inert and non-throwing.

**Step 4: Write failing link-candidate tests**

Cover both app-message `type=5` link cards and plain HTTP(S) group messages without `@`. Assert canonical link metadata and response-required classification while retaining unsafe-URL rejection downstream.

**Step 5: Implement explicit link metadata and rerun**

Normalize the title, description, and URL into `metadata.linkCandidate`; set the existing invocation signal used by the processor for public group links.

Run: `node --test src/im-channels.test.mjs`

Expected: PASS.

## Task 2: Authenticate owner commands in GeWe V1 groups

**Files:**
- Modify: `src/im-channels.mjs`
- Modify: `src/multica-access.mjs`
- Test: `src/im-channels.test.mjs`
- Test: `src/multica-access.test.mjs`

**Step 1: Write failing identity tests**

Add a V1 group event whose `FromUserName` is the group and whose content prefix contains the logged-in wxid. Assert `isSelf`, `ownerActivity`, explicit invocation, and authenticated owner-control metadata. Add a non-owner counterexample.

**Step 2: Run and verify failure**

Run: `node --test src/im-channels.test.mjs src/multica-access.test.mjs`

Expected: owner group event is not authenticated and group Multica write is denied.

**Step 3: Parse sender before self-origin classification**

In `normalizeGeWeWebhook`, parse the group content prefix first, compare the parsed sender with the logged-in wxid, and preserve ordinary owner messages as silent human activity unless the assistant is explicitly invoked.

**Step 4: Extend Multica authorization narrowly**

Permit a WeChat group mutation only when webhook authentication, parsed owner identity, and explicit assistant invocation are all true. Preserve the current preview/confirmation gate and keep all other group members read-only.

**Step 5: Rerun focused tests**

Run: `node --test src/im-channels.test.mjs src/multica-access.test.mjs`

Expected: PASS.

## Task 3: Raise same-chat context to 50 messages

**Files:**
- Modify: `src/conversation-history.mjs`
- Modify: `src/index.mjs`
- Test: `src/conversation-history.test.mjs`
- Test: `src/mechanism-acceptance.test.mjs`

**Step 1: Write a failing 55-message history test**

Store messages from several senders in one chat plus noise in another chat. Assert exactly the newest 50 same-chat messages are formatted in chronological order, with all participants represented and the other chat absent.

**Step 2: Run and verify the 30-message cap failure**

Run: `node --test src/conversation-history.test.mjs`

Expected: only 30 items are returned.

**Step 3: Change every runtime consumer to 50**

Raise the formatter maximum/default to 50 and replace hard-coded 30-message reads in normal processing and deferred group-host processing. Keep existing per-item truncation and exact quoted context outside this rolling budget.

**Step 4: Add an acceptance contract and rerun**

Run: `node --test src/conversation-history.test.mjs src/mechanism-acceptance.test.mjs`

Expected: PASS.

## Task 4: Recover valid GeWe images robustly

**Files:**
- Modify: `src/remote-content.mjs`
- Modify: `src/wechat-media-context.mjs`
- Modify: `src/index.mjs`
- Modify: `package.json`
- Test: `src/remote-content.test.mjs`
- Test: `src/wechat-media-context.test.mjs`
- Test: `src/mechanism-acceptance.test.mjs`

**Step 1: Write a failing MIME-sniff test**

Mock a valid JPEG or PNG body returned as `application/octst-stream`. Assert it is persisted as image content with the sniffed MIME rather than as a generic file.

**Step 2: Implement byte-signature detection**

After bounded download, recognize JPEG, PNG, GIF, and WebP magic bytes. Prefer a recognized image signature when the declared MIME is missing, generic, or incorrect; retain all size, redirect, and address protections.

**Step 3: Write a failing variant-fallback test**

Make GeWe type 2 fail and type 1 succeed, then assert normal, HD, and thumbnail variants are attempted in bounded order until a real image is obtained.

**Step 4: Persist bounded image sources before download**

Store source XML by chat/message before fetching, retaining at most 50 newest same-chat entries. Resolve a directed image question from exact quote metadata, then downloaded same-chat images, then same-chat source XML on demand. Never cross chat boundaries.

**Step 5: Make context-only image failure non-poisoning**

If an unaddressed group image cannot download, keep its source for later retry and acknowledge the durable inbox item without repeated dead-letter chatter. Directed image questions still receive the normal explicit failure response if every safe variant fails.

**Step 6: Register and run media tests**

Include `src/wechat-media-context.test.mjs` in the relevant package test script.

Run: `node --test src/remote-content.test.mjs src/wechat-media-context.test.mjs src/mechanism-acceptance.test.mjs`

Expected: PASS.

## Task 5: Route Multica create intent before artifact follow-up

**Files:**
- Create: `src/multica-request-routing.mjs`
- Create: `src/multica-request-routing.test.mjs`
- Modify: `src/index.mjs`
- Modify: `package.json`
- Test: `src/mechanism-acceptance.test.mjs`

**Step 1: Write failing routing tests**

Cover “create an Issue and deliver a PDF” versus an artifact-only follow-up. The first must choose Multica creation; the second may choose the existing artifact follow-up path.

**Step 2: Implement a pure precedence helper**

Classify explicit Multica create/manage intent before artifact execution. Keep the helper side-effect free so confirmation and workspace/squad selection remain in the existing durable flow.

**Step 3: Wire the processor order**

Use the helper before the artifact branch. Store the requested final artifact as the Issue delivery contract instead of consuming the request as a standalone artifact job.

**Step 4: Run routing and acceptance tests**

Run: `node --test src/multica-request-routing.test.mjs src/mechanism-acceptance.test.mjs`

Expected: PASS.

## Task 6: Make proactive link reading observable and safe

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/web-reader.mjs`
- Test: `src/web-reader.test.mjs`
- Test: `src/mechanism-acceptance.test.mjs`

**Step 1: Add failing processor/reader contracts**

Assert that a normalized group link candidate is response-required without `@`, public WeChat article HTML is read with the existing browser-compatible path, and private hosts, embedded credentials, custom ports, oversize bodies, and redirect-to-private targets remain blocked.

**Step 2: Wire link candidates into the existing reader**

Use `metadata.linkCandidate` plus plain URL extraction, pass retrieved text together with the 50-message context, and explicitly say the link could not be opened only when a response is required and all safe readers fail. Never synthesize unread page claims.

**Step 3: Rerun focused tests**

Run: `node --test src/web-reader.test.mjs src/im-channels.test.mjs src/mechanism-acceptance.test.mjs`

Expected: PASS.

## Task 7: Full verification and queue-safe restart

**Files:**
- Verify only unless a regression requires a scoped fix.

**Step 1: Run all focused suites**

Run: `npm run test:mechanism`

Run: `npm run test:multimodal`

Expected: PASS.

**Step 2: Run the full suite**

Run: `npm test`

Expected: PASS with no new failures.

**Step 3: Inspect the durable inbound queue**

Query the existing service state using the repository's read-only queue/status path. Proceed only when queued, retry, and processing counts are all zero. Do not modify dead-letter history.

**Step 4: Restart the launch service safely**

Restart `com.local.feishu-codex-digital-employee`, confirm a live PID and healthy local status, and inspect fresh logs for startup or syntax errors. Do not send test messages or backfill historical WeChat events.

**Step 5: Report the behavior change**

Summarize quote handling, 50-message context, image recovery, owner Multica routing, proactive link reading, test results, and restart state without exposing chat identifiers, account identifiers, tokens, projects, clients, or private knowledge sources.
