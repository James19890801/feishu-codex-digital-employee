# AI Product Manager Digital Human Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the local DingTalk Codex employee into Achong's AI product-manager digital human with governed memory/knowledge, automatic A1 requirement handling, requester-bound status notifications, and a verified final DingTalk message.

**Architecture:** Keep the existing Node.js service and SQLite state store. Add focused identity, knowledge, A1 client, requirement workflow, and A1 sync modules; integrate them through the current inbound message router and existing reliable outbox patterns. Raw evidence remains read-only, ALT is excluded at ingestion and retrieval, and all external results are reported only after system readback.

**Tech Stack:** Node.js 22 ESM, `node:sqlite`, `node:test`/`node:assert`, A1 CLI, DWS CLI, existing Codex runtime, existing DingTalk channel runtime.

## Global Constraints

- The only active identity is `阿充，AI 产品经理`.
- ALT must never enter Persona, prompt, memory, knowledge retrieval, or replies.
- `James` is not the digital human identity; it is allowed only in an explicitly authorized private-message signature.
- WebAgent routes to project `2165415` and repository `enterprise-development/ai-lab-agent`.
- AI 协同空间 routes to project `2168196` and repository `enterprise-development/ai-native-flow-platform`, branch `feature/20260606_29656382_init_project_1`.
- Requirements outside both products route to project `2165415`, are marked as awaiting classification, and do not trigger forced repository inspection.
- Requirement create/update needs no draft confirmation, but must use an idempotency key and successful `workitem get` readback before reporting completion.
- Active requirement subscriptions poll every `300000` milliseconds and notify only the original requester on real status transitions.
- Do not create test garbage in either real A1 project.
- The final DingTalk message is sent only after all code, tests, service health, and runtime acceptance checks pass.

---

### Task 1: Canonical Identity and Prompt Boundary

**Files:**
- Modify: `PERSONA.md`
- Modify: `BIBLE.md`
- Create: `src/identity-policy.mjs`
- Create: `src/identity-policy.test.mjs`
- Modify: `src/index.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `ACTIVE_IDENTITY`, `IDENTITY_TOMBSTONES`, `isExcludedIdentityText(text)`, `sanitizeIdentityContext(text, { allowJamesSignature })`, `buildIdentityInstruction()`.
- Consumes: current Persona/Bible file loading in `src/index.mjs`.

- [ ] **Step 1: Write failing identity tests**

```js
assert.equal(ACTIVE_IDENTITY, '阿充，AI 产品经理');
assert.equal(isExcludedIdentityText('ALT 平台需求'), true);
assert.equal(sanitizeIdentityContext('我是 James', {}).includes('James'), false);
assert.equal(sanitizeIdentityContext('——阿充（James）', { allowJamesSignature: true }), '——阿充（James）');
assert.match(buildIdentityInstruction(), /唯一现行身份是 AI 产品经理/);
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `node src/identity-policy.test.mjs`  
Expected: module-not-found failure.

- [ ] **Step 3: Implement identity policy and rewrite Persona/Bible**

Implement exact-string and normalized tombstone filtering for `詹老师`, `AIPRO`, `Second Developer`, developer/architect identity claims, and ALT. Treat `James` as blocked unless `allowJamesSignature === true` and the content is an explicitly supplied outbound message.

- [ ] **Step 4: Replace the hard-coded prompt identity block**

Import `buildIdentityInstruction()` in `src/index.mjs`; insert it above Persona and remove conflicting hard-coded AIPRO/old-role language. Replace the blanket “cannot read local files or run commands” statement with a named-tool boundary: the model cannot run arbitrary commands, but the application may provide read-only evidence and controlled A1/DWS results.

- [ ] **Step 5: Run focused tests**

Run: `node src/identity-policy.test.mjs && node src/bible.test.mjs && node src/privacy-boundary.test.mjs`  
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add PERSONA.md BIBLE.md src/identity-policy.mjs src/identity-policy.test.mjs src/index.mjs package.json
git commit -m "feat: enforce AI product manager identity"
```

### Task 2: Governed Memory and Knowledge Catalog v2

**Files:**
- Create: `src/memory-policy.mjs`
- Create: `src/memory-policy.test.mjs`
- Modify: `src/knowledge.mjs`
- Modify: `src/knowledge.test.mjs`
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`
- Modify: `knowledge-catalog.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `validateMemoryCandidate(candidate)`, `filterKnowledgeSources(sources, context)`, `AgentState.upsertMemoryItem(item)`, `AgentState.listActiveMemories(query)`, `AgentState.forgetMemory(id)`, `AgentState.upsertKnowledgeSource(source)`.
- Consumes: identity filtering from Task 1.

- [ ] **Step 1: Add failing policy and SQLite tests**

```js
assert.equal(validateMemoryCandidate({ kind: 'project_fact', content: 'ALT 平台', sourceRefs: ['x'] }).accepted, false);
assert.equal(validateMemoryCandidate({ kind: 'product_method', content: '需求写入后必须回读', sourceRefs: ['a1:1'] }).accepted, true);
state.upsertMemoryItem({ memoryId: 'm1', kind: 'preference', subject: '表达', content: '直接清晰', sourceRefs: ['user:confirmed'], confidence: 'confirmed' });
assert.equal(state.listActiveMemories('表达')[0].memoryId, 'm1');
state.forgetMemory('m1');
assert.equal(state.listActiveMemories('表达').length, 0);
```

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `node src/memory-policy.test.mjs && node src/state.test.mjs`  
Expected: missing exports/tables.

- [ ] **Step 3: Add idempotent SQLite schema**

Create `identity_tombstone`, `memory_item`, and `knowledge_source` tables in `AgentState`. Store JSON only in validated fields; add indexes on active memory kind/updated time and source status/type.

- [ ] **Step 4: Upgrade knowledge catalog behavior**

Replace the Feishu-only URL/token model with versioned entries supporting `dingtalk_doc`, `dingtalk_minutes`, `dingtalk_chat`, `local_document`, `local_repository`, `a1_workitem`, and `code_repository`. Keep a compatibility adapter for old array catalogs, but filter `excluded_scope`, unauthorized readers, ALT, and tombstoned identities before retrieval.

- [ ] **Step 5: Seed the catalog with approved domains only**

Set `knowledge-catalog.json` to `{ "version": 2, "sources": [...] }` containing the verified AIFlow/AI-Lab/WebAgent/digital-employee documents and repository references, with provenance, owner, freshness, sensitivity, and status. Do not include ALT sources or raw unrelated chat.

- [ ] **Step 6: Run focused tests**

Run: `node src/memory-policy.test.mjs && node src/knowledge.test.mjs && node src/state.test.mjs && node src/config-store.test.mjs`  
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/memory-policy.mjs src/memory-policy.test.mjs src/knowledge.mjs src/knowledge.test.mjs src/state.mjs src/state.test.mjs knowledge-catalog.json package.json
git commit -m "feat: add governed memory and knowledge catalog"
```

### Task 3: A1 Client and Product Routing

**Files:**
- Create: `src/a1-client.mjs`
- Create: `src/a1-client.test.mjs`
- Create: `src/a1-requirements.mjs`
- Create: `src/a1-requirements.test.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `A1Client.getWorkitem(id)`, `listWorkitems(query)`, `getActivity(id)`, `getComments(id)`, `getRelations(id)`, `readRepositoryEvidence(route, query)`, `createRequirement(input)`, `updateRequirement(id, input)`; `classifyRequirementIntent(text)`, `resolveProductRoute(text)`, `buildRequirementBody(facts, evidence)`.
- Consumes: existing `runProcess` pattern and Task 1 identity filtering.

- [ ] **Step 1: Write failing routing/body tests**

```js
assert.equal(resolveProductRoute('WebAgent 登录态').projectId, '2165415');
assert.equal(resolveProductRoute('AI 协同空间工作流').projectId, '2168196');
assert.equal(resolveProductRoute('其他系统').classificationPending, true);
const body = buildRequirementBody(completeFacts, codeEvidence);
for (const heading of ['背景与必要性', '目标用户与业务场景', '需求清单', '验收标准', '依赖、风险与待确认项']) assert.match(body, new RegExp(heading));
```

- [ ] **Step 2: Write failing process-contract tests**

Use a fake runner and assert every A1 command includes `A1_NO_UPDATE_CHECK=1`, structured JSON output, explicit project/repository identifiers, `--body-file` for long bodies, and a final `workitem get` readback.

- [ ] **Step 3: Run tests and confirm failure**

Run: `node src/a1-client.test.mjs && node src/a1-requirements.test.mjs`  
Expected: module-not-found failure.

- [ ] **Step 4: Implement read-only and write client**

Use non-interactive A1 commands only. For create/update, discover type and required fields before mutation, write the Markdown body to a validated temporary file, execute the operation once under `mutation_execution`, and read back the result. Return `{ workitem, url, created, readbackVerified }` only when readback succeeds.

- [ ] **Step 5: Implement classifier, dedupe query, code evidence, and body builder**

Product-unknown requests return one clarification question. Explicit out-of-scope requests route to WebAgent pool with `classificationPending=true` and skip repository reads. Similar title/body matches produce `create`, `append`, or `change` recommendations. The body builder always emits all 13 required sections and the four-column requirement table.

- [ ] **Step 6: Run tests**

Run: `node src/a1-client.test.mjs && node src/a1-requirements.test.mjs && npm run check`  
Expected: focused tests and syntax checks pass.

- [ ] **Step 7: Commit**

```bash
git add src/a1-client.mjs src/a1-client.test.mjs src/a1-requirements.mjs src/a1-requirements.test.mjs src/config.mjs config.example.json package.json
git commit -m "feat: add A1 requirement routing and client"
```

### Task 4: Conversation Requirement Workflow

**Files:**
- Create: `src/requirement-workflow.mjs`
- Create: `src/requirement-workflow.test.mjs`
- Modify: `src/bible.mjs`
- Modify: `src/bible.test.mjs`
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `RequirementWorkflow.handle(messageContext)` returning `{ handled, reply, workitem?, followUp? }`.
- Consumes: `A1Client`, routing/body functions, `AgentState`, and the existing `sendText` callback.

- [ ] **Step 1: Write failing state-machine tests**

Cover: progress lookup by ID; title search ambiguity; unknown product clarification; insufficient detail follow-up; complete WebAgent creation; complete AI-space creation; out-of-scope fallback; duplicate message idempotency; post-create follow-up updating the same workitem without preview confirmation.

- [ ] **Step 2: Run tests and confirm failure**

Run: `node src/requirement-workflow.test.mjs`  
Expected: missing module.

- [ ] **Step 3: Implement the workflow**

Persist pending intake facts under requester/conversation scope. Build the minimum-completeness gate from user, scenario, current problem, expected outcome, scope, priority, and acceptance criteria. When complete: dedupe, read code if applicable, build body, create/update, read back, subscribe, and return a receipt containing product, project, ID, status, URL, and remaining questions.

- [ ] **Step 4: Integrate before generic Codex replies**

Route requirement-progress and new-requirement intents through `RequirementWorkflow` before `runCodex`. Remove active Multica request handling from the main routing path while leaving legacy tables/modules readable for compatibility.

- [ ] **Step 5: Run focused and mechanism tests**

Run: `node src/requirement-workflow.test.mjs && node src/bible.test.mjs && npm run test:mechanisms`  
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/requirement-workflow.mjs src/requirement-workflow.test.mjs src/bible.mjs src/bible.test.mjs src/index.mjs src/mechanism-acceptance.test.mjs package.json
git commit -m "feat: handle A1 requirements from DingTalk"
```

### Task 5: Requester-Bound A1 Status Notifications

**Files:**
- Create: `src/a1-sync.mjs`
- Create: `src/a1-sync.test.mjs`
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`
- Modify: `src/index.mjs`
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `A1Synchronizer.syncOnce()`, `runA1SyncLoop()`, state methods for subscriptions, events, and outbox delivery.
- Consumes: `A1Client.getWorkitem/getActivity`, `sendText`, and existing retry/backoff utilities.

- [ ] **Step 1: Write failing state and sync tests**

Assert one notification per real status transition; no notification for body-only updates; original requester/chat routing; retry without cursor advancement; ordered catch-up after restart; final notification and subscription close on completed/closed/cancelled states.

- [ ] **Step 2: Run tests and confirm failure**

Run: `node src/a1-sync.test.mjs && node src/state.test.mjs`  
Expected: missing tables/methods.

- [ ] **Step 3: Add SQLite schema and outbox methods**

Create `a1_requirement_subscription`, `a1_requirement_event`, and `a1_notification_outbox` with unique transition keys and due indexes. Mirror the proven pending/retry/dead-letter pattern without sharing Multica rows.

- [ ] **Step 4: Implement synchronizer and loop**

Poll every `300000` ms, fetch activity since the stored cursor, persist transitions transactionally, enqueue notifications, deliver with exponential backoff, and close terminal subscriptions only after the final notification is enqueued.

- [ ] **Step 5: Integrate health reporting**

Expose last sync time/error, scanned subscription count, pending notifications, and dead letters in the dashboard model. Replace active Multica maintenance warnings with A1 equivalents.

- [ ] **Step 6: Run tests**

Run: `node src/a1-sync.test.mjs && node src/state.test.mjs && node src/dashboard-model.test.mjs && npm run test:mechanisms`  
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/a1-sync.mjs src/a1-sync.test.mjs src/state.mjs src/state.test.mjs src/index.mjs src/dashboard-model.mjs src/dashboard-model.test.mjs package.json
git commit -m "feat: notify requesters about A1 status changes"
```

### Task 6: Source Inventory and Runtime Configuration Migration

**Files:**
- Create: `scripts/build-knowledge-inventory.mjs`
- Create: `scripts/build-knowledge-inventory.test.mjs`
- Modify: `config.json`
- Modify: `config.example.json`
- Modify: `knowledge-catalog.json`
- Modify: `src/config-assistant.mjs`
- Modify: `src/config-assistant.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: deterministic catalog merge from approved local/DingTalk/A1 source metadata.
- Consumes: Task 2 knowledge schema and identity filters.

- [ ] **Step 1: Write failing inventory tests**

Use fixture sources containing approved AIFlow/WebAgent records, ALT records, duplicate documents, unrelated private chat, and credentials. Assert only approved deduplicated metadata/summaries enter the catalog and no secret-looking value survives.

- [ ] **Step 2: Implement the inventory builder**

Accept only explicit source manifests and read-only DWS/A1 command output. Do not recursively ingest arbitrary home-directory files. Preserve source IDs, owners, timestamps, sensitivity, and cursors; store summaries, not raw unrelated conversations.

- [ ] **Step 3: Migrate active configuration**

Disable Multica as the runtime requirement system, add A1 binary/project/repository/sync settings, retain legacy Multica settings only for read-only compatibility, and update the configuration assistant labels and validation.

- [ ] **Step 4: Run inventory and configuration tests**

Run: `node scripts/build-knowledge-inventory.test.mjs && node src/config-assistant.test.mjs && node src/config-store.test.mjs && node scripts/check-config.mjs`  
Expected: all pass.

- [ ] **Step 5: Build the real approved inventory**

Run the script against the already verified DingTalk document/minutes metadata, A1 project/repository metadata, and approved local AI product-manager artifacts. Inspect the diff and confirm ALT and unrelated private material are absent.

- [ ] **Step 6: Commit**

```bash
git add scripts/build-knowledge-inventory.mjs scripts/build-knowledge-inventory.test.mjs config.json config.example.json knowledge-catalog.json src/config-assistant.mjs src/config-assistant.test.mjs package.json
git commit -m "feat: migrate runtime knowledge and A1 configuration"
```

### Task 7: Full Verification and Local Runtime Acceptance

**Files:**
- Modify: `docs/testing/MECHANISM_ACCEPTANCE.md`
- Modify: `docs/提交验收单.md`

**Interfaces:**
- Consumes: all previous tasks.
- Produces: repeatable verification evidence and a healthy local service.

- [ ] **Step 1: Run static and focused checks**

Run: `npm run check`  
Expected: exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`  
Expected: exit 0 with all existing and new tests passing.

- [ ] **Step 3: Back up and restart the service**

Use the repository's existing backup and service scripts. Do not delete the current SQLite database. Confirm a successful backup and graceful process replacement.

- [ ] **Step 4: Run health and dashboard smoke checks**

Run: `npm run health && npm run runtime-smoke && npm run dashboard-browser-smoke`  
Expected: service and dashboard healthy at `http://127.0.0.1:17655/`, Codex runtime selected, DingTalk channel active, A1 sync healthy, no active Multica requirement routing.

- [ ] **Step 5: Run non-mutating A1/DingTalk acceptance probes**

Read both A1 projects/repositories and the resolved DingTalk contact. Do not create a test requirement. Verify status polling with a fake adapter or existing subscribed fixture.

- [ ] **Step 6: Update acceptance documents and commit**

Record exact commands, timestamps, exit codes, service URL, and any remaining limitations.

```bash
git add docs/testing/MECHANISM_ACCEPTANCE.md docs/提交验收单.md
git commit -m "docs: record digital human acceptance evidence"
```

### Task 8: Final Authorized DingTalk Message

**Files:**
- No source changes unless a delivery defect is found.

**Interfaces:**
- Consumes: verified DWS profile `dingd8e1123006514592:384351`, recipient OpenDingTalkId `Ds7fDNenMeDJP7zCPiPJqRCLnkiS5ENiizHW`.
- Produces: one verified direct-message receipt.

- [ ] **Step 1: Re-resolve the recipient immediately before send**

Search `谢冰雪` and require the unique result to match employee ID `326584` and the stored OpenDingTalkId. Stop on mismatch or ambiguity.

- [ ] **Step 2: Send exactly one direct message**

Send:

```text
师姐，我满四周年啦，什么时候请我吃饭？——阿充（James）
```

Use DWS with JSON output and the current authorized profile. Do not resend on an uncertain result; query delivery/readback first.

- [ ] **Step 3: Verify the receipt**

Require a success result containing the returned message identifier or equivalent delivery proof. Report the recipient, exact text, timestamp, and receipt identifier.

- [ ] **Step 4: Final repository and service check**

Run: `git status --short && npm run health`  
Expected: clean worktree and healthy service.
