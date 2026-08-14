# AIPR0S DingTalk Document Realtime Reading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make AIPR0S read DingTalk document links and owner-authorized document searches through the configured DWS runtime before generating a DingTalk reply, with no Feishu fallback on DingTalk messages.

**Architecture:** Add a focused `dingtalk-knowledge` adapter that owns URL parsing, DWS argument construction, authorization-aware source selection, result normalization, and bounded document reads. Route realtime knowledge by channel in `index.mjs`; the DingTalk route receives already-read Markdown while the existing Feishu route remains isolated to Feishu. Exclude DingTalk document URLs from the public web reader so one internal URL has exactly one reader.

**Tech Stack:** Node.js ES modules, `node:assert/strict`, existing `runBufferedProcess`, DWS 1.0.56 (`drive search`, `doc read`), npm test scripts, Git/Codeup.

## Global Constraints

- DingTalk reads must use `config.dingtalkBin`, `config.dingtalkProfile`, and command-scoped `DWS_CHANNEL` from `dingtalkProcessEnv()`.
- Do not call deprecated `dws doc search`; title search uses `dws drive search --query` and parses `doc_results.documents`.
- Any sender may supply an explicit `alidocs.dingtalk.com/i/nodes/<nodeId>` URL for a current-message read.
- Only the owner may perform account-wide keyword search; non-owner no-link reads require an active catalog entry whose `readerIds` includes the sender.
- A DingTalk message must never call Feishu knowledge search or emit a Feishu-specific degradation prompt.
- Do not commit `config.local.json`, Channel/Profile values, document bodies, SQLite data, logs, or live command output.
- Use red-green-refactor for every production behavior and run the complete regression suite before deployment or push.

---

### Task 1: Deterministic DingTalk document reference and DWS command boundary

**Files:**
- Create: `src/dingtalk-knowledge.mjs`
- Create: `src/dingtalk-knowledge.test.mjs`

**Interfaces:**
- Produces: `extractDingTalkDocumentRefs(text): Array<{nodeId: string, url: string}>`
- Produces: `buildDingTalkSearchArgs({query, profile, limit}): string[]`
- Produces: `buildDingTalkReadArgs({node, profile}): string[]`
- Produces: `normalizeDingTalkSearchResults(payload, query, limit): Array<{nodeId, title, url}>`

- [ ] **Step 1: Write failing parsing and command tests**

Add literal assertions covering a direct node URL, a query-string URL, duplicate URLs, a spoofed host, missing node ID, the exact DWS search arguments, and the exact read arguments:

```js
assert.deepEqual(extractDingTalkDocumentRefs(
  '查看 https://alidocs.dingtalk.com/i/nodes/nodeABC123?utm_medium=im_card',
), [{
  nodeId: 'nodeABC123',
  url: 'https://alidocs.dingtalk.com/i/nodes/nodeABC123?utm_medium=im_card',
}]);
assert.deepEqual(extractDingTalkDocumentRefs(
  'https://alidocs.dingtalk.com.evil.test/i/nodes/stolen',
), []);
assert.deepEqual(buildDingTalkSearchArgs({
  query: '会话级文件直传接口', profile: 'corp:user', limit: 8,
}), [
  '--profile', 'corp:user', 'drive', 'search', '--query', '会话级文件直传接口',
  '--limit', '8', '--format', 'json', '--yes',
]);
assert.deepEqual(buildDingTalkReadArgs({ node: 'nodeABC123', profile: 'corp:user' }), [
  '--profile', 'corp:user', 'doc', 'read', '--node', 'nodeABC123',
  '--format', 'json', '--yes',
]);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node src/dingtalk-knowledge.test.mjs`

Expected: FAIL because `src/dingtalk-knowledge.mjs` or its exports do not exist.

- [ ] **Step 3: Implement the minimal pure boundary**

Implement host-exact URL parsing with `new URL()`, strict node ID validation (`[A-Za-z0-9_-]{8,256}`), stable deduplication, trimmed queries, bounded limits from 1 to 30, and parsing of only `payload.doc_results.documents`. Rank exact normalized title matches before contains matches and preserve DWS order within the same rank.

- [ ] **Step 4: Add malformed payload and ranking cases, verify RED, then GREEN**

Use a complete DWS-shaped fixture:

```js
const searchPayload = {
  doc_results: {
    success: true,
    documents: [
      { nodeId: 'nodeRelated1', name: '会话文件接口说明', docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeRelated1', contentType: 'ALIDOC' },
      { nodeId: 'nodeExact12', name: '会话级文件直传接口', docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeExact12', contentType: 'ALIDOC' },
    ],
    hasMore: false,
    nextPageToken: '',
  },
  drive_results: { success: true, items: [], hasMore: false },
};
assert.equal(normalizeDingTalkSearchResults(searchPayload, '会话级文件直传接口', 3)[0].nodeId, 'nodeExact12');
```

Run: `node src/dingtalk-knowledge.test.mjs`

Expected: PASS with a terminal marker `DINGTALK_KNOWLEDGE_TEST_OK`.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/dingtalk-knowledge.mjs src/dingtalk-knowledge.test.mjs
git commit -m "feat: add DingTalk document knowledge boundary"
```

---

### Task 2: Authorization-aware search and bounded document retrieval

**Files:**
- Modify: `src/dingtalk-knowledge.mjs`
- Modify: `src/dingtalk-knowledge.test.mjs`
- Reuse: `src/knowledge.mjs`

**Interfaces:**
- Consumes: Task 1 parsers and argument builders.
- Produces: `retrieveDingTalkKnowledge(options): Promise<null | DingTalkKnowledgeResult>` where `options` contains `text`, `senderId`, `ownerIds`, `catalog`, `profile`, `runDws`, `maxDocumentChars`, and `maxTotalChars`.
- `DingTalkKnowledgeResult` contains `source: 'dingtalk'`, `documents`, `failures`, and optional `notFound` or `unavailable`; each successful document contains `nodeId`, `title`, `url`, and bounded `content`.

- [ ] **Step 1: Write a failing direct-link retrieval test**

The external DWS process is the only test double. Assert the real adapter result and exact call list:

```js
const calls = [];
const direct = await retrieveDingTalkKnowledge({
  text: '请看 https://alidocs.dingtalk.com/i/nodes/nodeABC123',
  senderId: 'colleague', ownerIds: ['owner'], catalog: { version: 2, sources: [] },
  profile: 'corp:user',
  runDws: async args => {
    calls.push(args);
    return { success: true, nodeId: 'nodeABC123', title: '接口说明', markdown: '# 正文', docUrl: 'https://alidocs.dingtalk.com/i/nodes/nodeABC123' };
  },
});
assert.equal(direct.documents[0].content, '# 正文');
assert.equal(calls.length, 1);
assert.equal(calls[0].includes('search'), false);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node src/dingtalk-knowledge.test.mjs`

Expected: FAIL because `retrieveDingTalkKnowledge` is not exported.

- [ ] **Step 3: Implement direct-link reads and strict success validation**

Require a parsed object, `success === true`, a valid node ID, non-empty title, and non-empty Markdown. Convert nonzero process failures, malformed JSON surfaced by the runner, false success, and empty Markdown into bounded failure entries. Never put raw stderr or credentials in the result.

- [ ] **Step 4: Add owner-search and non-owner authorization tests, verify RED**

Add separate cases proving:

```js
// Owner: search then read, at most three documents.
assert.deepEqual(ownerCalls[0].slice(0, 4), ['--profile', 'corp:user', 'drive', 'search']);
assert.equal(ownerResult.documents.length, 3);

// Non-owner without a current-message link: no account-wide search.
assert.equal(nonOwnerCalls.length, 0);
assert.equal(nonOwnerResult.notFound, true);

// Non-owner with an active dingtalk_doc catalog source and readerIds: read the locator.
assert.equal(authorizedResult.documents[0].nodeId, 'nodeCatalog1');
```

- [ ] **Step 5: Implement owner search and catalog-authorized lookup**

Use `extractKnowledgeQuery`, `filterKnowledgeSources`, `normalizeKnowledgeCatalog`, and normalized title/alias matching. Treat any `ownerIds` match as owner. Do not search if the query is empty. Restrict catalog lookup to active `dingtalk_doc` entries.

- [ ] **Step 6: Add bounds, partial failure, full failure, timeout, and malformed-result tests**

Use literal strings to prove per-document and total limits. Prove one successful document remains available when another fails, while all failures set `unavailable: true`. Ensure returned failure reasons are stable categories such as `read_failed`, `invalid_response`, and `empty_content`, not external error text.

- [ ] **Step 7: Run focused tests and commit Task 2**

Run: `node src/dingtalk-knowledge.test.mjs`

Expected: PASS and `DINGTALK_KNOWLEDGE_TEST_OK`.

```bash
git add src/dingtalk-knowledge.mjs src/dingtalk-knowledge.test.mjs
git commit -m "feat: retrieve authorized DingTalk documents"
```

---

### Task 3: Realtime channel routing and model grounding

**Files:**
- Create: `src/knowledge-router.mjs`
- Create: `src/knowledge-router.test.mjs`
- Modify: `src/index.mjs:1-180, 620-680, 2128-2164, 2348-2380`
- Modify: `package.json`

**Interfaces:**
- Produces: `resolveRealtimeKnowledge({channel, resolveDingTalk, resolveFeishu}): Promise<unknown>`.
- Consumes: `retrieveDingTalkKnowledge` and the existing `searchFeishuKnowledge` callback.
- Adds an internal `runConfiguredDwsJson(args)` in `index.mjs` that executes only `config.dingtalkBin` with `dingtalkProcessEnv()` and returns parsed JSON.

- [ ] **Step 1: Write failing route tests**

```js
let dingtalkCalls = 0;
let feishuCalls = 0;
const result = await resolveRealtimeKnowledge({
  channel: 'dingtalk',
  resolveDingTalk: async () => { dingtalkCalls += 1; return { source: 'dingtalk' }; },
  resolveFeishu: async () => { feishuCalls += 1; return { source: 'feishu' }; },
});
assert.equal(result.source, 'dingtalk');
assert.equal(dingtalkCalls, 1);
assert.equal(feishuCalls, 0);
```

Add Feishu and unsupported-channel cases. This test catches the original wrong-branch regression.

- [ ] **Step 2: Run and verify RED, then implement the minimal router**

Run: `node src/knowledge-router.test.mjs`

Expected RED: module or export missing.

Implement an exact channel switch with no fallback from DingTalk to Feishu, then rerun for PASS.

- [ ] **Step 3: Write a failing orchestration contract case**

Extend `src/mechanism-acceptance.test.mjs` or a focused knowledge orchestration test to exercise the public helper used by `index.mjs`: a DingTalk share-card message must produce material containing `# 正文`, must not call the Feishu resolver, and must return DingTalk-specific failure text when the DWS adapter reports unavailable.

- [ ] **Step 4: Wire `index.mjs` to the router and pre-read DingTalk Markdown**

Determine the channel from `metadata.channel` first and `parseChannelChatId(message.chat_id)?.channel` second. For DingTalk, call `retrieveDingTalkKnowledge` with the configured Profile, catalog, owner IDs, bounds, and `runConfiguredDwsJson`. Successful DingTalk documents already carry `content`; only Feishu documents call `readAllowedFeishuDoc`.

Use source-specific prompts:

```js
if (knowledgeResult?.source === 'dingtalk' && knowledgeResult?.unavailable) {
  task = '钉钉文档刚刚没有读取成功。请明确说明未读取，不要猜测内容；建议对方检查链接或稍后重试。';
}
```

Successful material must say “钉钉资料” and preserve its DingTalk title and URL. Add audit events for search/read success and failure counts without bodies or credentials.

- [ ] **Step 5: Register focused tests and verify GREEN**

Add `node src/dingtalk-knowledge.test.mjs && node src/knowledge-router.test.mjs` to `test:memory` so `pretest` and `npm test` execute them.

Run:

```bash
node src/dingtalk-knowledge.test.mjs
node src/knowledge-router.test.mjs
npm run test:memory
node src/mechanism-acceptance.test.mjs
node --check src/index.mjs
```

Expected: all exit 0; no DingTalk failure text contains “飞书”.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/knowledge-router.mjs src/knowledge-router.test.mjs src/index.mjs package.json src/mechanism-acceptance.test.mjs
git commit -m "fix: ground DingTalk replies in DingTalk documents"
```

---

### Task 4: Prevent public web fallback for internal DingTalk documents

**Files:**
- Modify: `src/web-reader.mjs`
- Modify: `src/web-reader.test.mjs`
- Modify: `src/multimodal-pipeline.test.mjs`

**Interfaces:**
- Modifies: `extractHttpUrls(text, limit)` to exclude exact `alidocs.dingtalk.com/i/nodes/` document URLs before applying the limit.
- Preserves: all existing public URL parsing and SSRF controls.

- [ ] **Step 1: Write failing URL-exclusion tests**

```js
assert.deepEqual(extractHttpUrls(
  '文档 https://alidocs.dingtalk.com/i/nodes/nodeABC123 官网 https://example.com/guide',
  2,
), ['https://example.com/guide']);
```

In `multimodal-pipeline.test.mjs`, assert `readPublicWebContext` does not call `readPage` for the DingTalk document URL and does not add a failed-link warning for it.

- [ ] **Step 2: Run and verify RED**

Run: `node src/web-reader.test.mjs && node src/multimodal-pipeline.test.mjs`

Expected: FAIL because the internal document URL is still sent to the public reader.

- [ ] **Step 3: Implement exact-host exclusion and verify GREEN**

Parse each extracted URL, exclude only `https:` URLs whose hostname equals `alidocs.dingtalk.com` and pathname begins `/i/nodes/`, retain malformed/public URLs for existing validation behavior, then apply deduplication and limit.

Run: `node src/web-reader.test.mjs && node src/multimodal-pipeline.test.mjs`

Expected: PASS with existing public-web security assertions unchanged.

- [ ] **Step 4: Commit Task 4**

```bash
git add src/web-reader.mjs src/web-reader.test.mjs src/multimodal-pipeline.test.mjs
git commit -m "fix: keep DingTalk docs out of public web reader"
```

---

### Task 5: Complete regression, live DWS acceptance, local deployment, and Codeup push

**Files:**
- Create: `docs/testing/2026-08-05-dingtalk-document-realtime-reading.md`
- Modify only if verification exposes a documented mismatch: `docs/superpowers/specs/2026-08-05-dingtalk-document-realtime-reading-design.md`

**Interfaces:**
- Consumes all prior tasks.
- Produces fresh automated, live DWS, runtime health, deployment, Git, and Codeup evidence.

- [ ] **Step 1: Run focused and full automated verification**

Run in order:

```bash
node src/dingtalk-knowledge.test.mjs
node src/knowledge-router.test.mjs
node src/web-reader.test.mjs
node src/multimodal-pipeline.test.mjs
npm run test:memory
npm test
npm run check
git diff --check
```

Expected: every command exits 0. Record exact test markers and any count printed by the repository; do not summarize a failed command as passing.

- [ ] **Step 2: Run privacy and packaging checks**

Run:

```bash
npm run test:distribution-package
npm run test:dws-deployment-policy
git grep -nE 'dingtalkChannel|DWS_CHANNEL|config.local.json' -- ':!docs/superpowers/**' ':!config.example.json' ':!config.distribution.json'
git status --short
```

Inspect every grep hit; verify no secret values or local configuration were added. The worktree may contain only intended source, test, plan, spec, and verification-record changes.

- [ ] **Step 3: Run real DWS 1.0.56 acceptance through the platform configuration**

Read `dingtalkBin`, Profile, and Channel from `config.local.json` into shell-local task variables without printing them. Execute the configured binary with command-scoped `DWS_CHANNEL`:

```bash
DWS_ACCEPT_BIN=$(jq -r '.dingtalkBin' config.local.json)
DWS_ACCEPT_PROFILE=$(jq -r '.dingtalkProfile' config.local.json)
DWS_ACCEPT_CHANNEL=$(jq -r '.dingtalkChannel' config.local.json)
env DWS_CHANNEL="$DWS_ACCEPT_CHANNEL" "$DWS_ACCEPT_BIN" auth status --profile "$DWS_ACCEPT_PROFILE" --format json
env DWS_CHANNEL="$DWS_ACCEPT_CHANNEL" "$DWS_ACCEPT_BIN" drive search --query '会话级文件直传接口' --limit 8 --profile "$DWS_ACCEPT_PROFILE" --format json --yes
env DWS_CHANNEL="$DWS_ACCEPT_CHANNEL" "$DWS_ACCEPT_BIN" doc read --node 'https://alidocs.dingtalk.com/i/nodes/14lgGw3P8vxjwogPCgQMwPNnV5daZ90D' --profile "$DWS_ACCEPT_PROFILE" --format json --yes
```

Assert authenticated/token-valid state, a `doc_results.documents` match, matching title/node ID, and non-empty Markdown. Record only booleans, version, title, and node ID.

- [ ] **Step 4: Exercise the adapter against the real DWS runner**

Run a repository-local one-off Node invocation that imports `retrieveDingTalkKnowledge`, invokes the configured DWS binary through `runBufferedProcess` and `buildDingTalkProcessEnv`, passes the exact share URL, and prints only `{source, documentCount, title, nodeId, hasContent}`. Expected: `source=dingtalk`, one document, matching title/node ID, `hasContent=true`.

- [ ] **Step 5: Write the verification record and commit it**

Use `apply_patch` to create `docs/testing/2026-08-05-dingtalk-document-realtime-reading.md` with command, exit status, safe result summary, known limitations, and no body/config values.

```bash
git add docs/testing/2026-08-05-dingtalk-document-realtime-reading.md
git commit -m "docs: verify realtime DingTalk document reading"
```

- [ ] **Step 6: Install and verify the local service**

Run the repository's supported installer, then health checks:

```bash
./scripts/install-service.sh
npm run health
npm run event-health
```

Expected: service running, DingTalk authenticated, event-stream connected, and no new startup syntax/config error. If `event-health` reports an unrelated disabled Feishu integration, separate that from DingTalk status and do not claim full health until the DingTalk-specific checks pass.

- [ ] **Step 7: Final diff and commit audit**

Run:

```bash
git status --short --branch
git diff codeup/agent/aipro-commercial-platform-upgrade...HEAD --stat
git log --oneline codeup/agent/aipro-commercial-platform-upgrade..HEAD
git diff codeup/agent/aipro-commercial-platform-upgrade...HEAD -- . ':!docs/superpowers/**' ':!docs/testing/**'
```

Verify the branch includes the pre-existing owner-private mail design plus this feature, contains no generated/private files, and remains a normal descendant of the Codeup branch.

- [ ] **Step 8: Fetch and push Codeup without force**

```bash
git fetch codeup agent/aipro-commercial-platform-upgrade
git merge-base --is-ancestor codeup/agent/aipro-commercial-platform-upgrade HEAD
git push codeup HEAD:agent/aipro-commercial-platform-upgrade
git fetch codeup agent/aipro-commercial-platform-upgrade
test "$(git rev-parse HEAD)" = "$(git rev-parse codeup/agent/aipro-commercial-platform-upgrade)"
```

Expected: ancestor check and final SHA equality exit 0. Never use `--force` or `--force-with-lease`.

- [ ] **Step 9: Report the verified outcome**

Report the Codeup repository, branch, pushed commit SHA, automated regression status, real document read status, local service health, and any unresolved limitation. Include no credentials, document body, recipient identifiers, or personal configuration.
