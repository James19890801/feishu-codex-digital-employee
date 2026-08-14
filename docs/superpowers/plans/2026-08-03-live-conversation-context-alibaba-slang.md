# Live Conversation Context and Alibaba Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every natural-language DingTalk reply use the current conversation's real latest 30 messages, respond to the other party's latest sentence in Achong's style, understand Alibaba grade shorthand contextually, and finish with a full-chain regression report.

**Architecture:** Keep the existing DWS v1.0.55 event-stream inbound and outbound path and the local Codex runtime. Add pure normalization/prompt modules plus a narrow DWS history client, then integrate them immediately before ordinary AI generation; never enable Wukong polling or call the Wukong-bundled executable.

**Tech Stack:** Node.js ESM, `node:assert/strict`, SQLite via existing `AgentState`, existing buffered-process runner, DWS CLI v1.0.55, Codex CLI, A1 CLI, localhost dashboard.

## Global Constraints

- Use `/Users/fengzhouchong.fzc/.npm-global/bin/dws` with the configured profile/channel and `event-stream` transport.
- Do not enable Wukong polling, use `~/.real/.bin/dws/bin/dws`, or add a second DingTalk channel.
- Read only the current conversation; never merge another direct chat, group, or thread.
- Normalize at most 30 messages and at most 8 Achong-authored style samples.
- Treat bare `5`–`9` as `P5`–`P9` only in people/grade/recruiting/promotion contexts; preserve dates, amounts, counts, versions, durations, and IDs.
- Do not call Codex when current-conversation history cannot be fetched or validated.
- Use test-driven development for every production behavior: write the test, observe the expected failure, implement minimally, and rerun.
- Preserve the existing AI product-manager identity, privacy filters, A1 workflow, reliable queue, idempotency, and status notification rules.
- A final result is `通过` only after static checks, every Node test, runtime smoke, DWS live read, A1 read-only probes, service restart, browser acceptance, and the single verified message to 谢冰雪 all succeed.

---

### Task 1: Stabilize the Existing A1 Runtime Baseline

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`
- Modify: `src/process-runner.test.mjs`
- Modify: `scripts/health-check.mjs`

**Interfaces:**
- Consumes: existing SQLite files created by pre-A1 versions.
- Produces: idempotent legacy A1 schema migration and a health check that reports A1 state instead of dormant Multica state.

- [ ] **Step 1: Run the focused regression that proves the already-written migration tests pass**

Run:

```bash
node src/state.test.mjs && node src/process-runner.test.mjs && node scripts/health-check.mjs
```

Expected: all tests pass; health JSON is parseable and contains `a1Enabled` and no schema exception.

- [ ] **Step 2: Review the pending diff for unrelated edits**

Run:

```bash
git diff --check
git diff -- src/state.mjs src/state.test.mjs src/process-runner.test.mjs scripts/health-check.mjs
```

Expected: only legacy A1 schema compatibility, process-test timeout hardening, and A1 health fields are present.

- [ ] **Step 3: Commit the baseline repair**

```bash
git add src/state.mjs src/state.test.mjs src/process-runner.test.mjs scripts/health-check.mjs
git commit -m "fix: migrate legacy A1 runtime state"
```

### Task 2: Normalize the Latest 30 DingTalk Messages

**Files:**
- Create: `src/conversation-context.test.mjs`
- Create: `src/conversation-context.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `buildDingTalkHistoryArgs(context, { beforeTime, profile }) -> string[]`.
- Produces: `normalizeConversationHistory(result, options) -> { messages, currentMessage, latestCounterpartyMessage, styleSamples }`.
- Produces: `formatConversationContext(context) -> string`.

- [ ] **Step 1: Write failing tests for exact DWS arguments**

Test literals:

```js
assert.deepEqual(buildDingTalkHistoryArgs(
  { kind: 'direct', targetId: 'open-user' },
  { beforeTime: '2026-08-03 15:00:01', profile: 'corp:user' },
), [
  'chat', 'message', 'list', '--open-dingtalk-id', 'open-user',
  '--time', '2026-08-03 15:00:01', '--direction', 'older',
  '--limit', '30', '--format', 'json', '--profile', 'corp:user', '-y',
]);
assert.deepEqual(buildDingTalkHistoryArgs(
  { kind: 'group', targetId: 'cid-group' },
  { beforeTime: '2026-08-03 15:00:01', profile: 'corp:user' },
), [
  'chat', 'message', 'list', '--group', 'cid-group',
  '--time', '2026-08-03 15:00:01', '--direction', 'older',
  '--limit', '30', '--format', 'json', '--profile', 'corp:user', '-y',
]);
```

Run: `node src/conversation-context.test.mjs`  
Expected: FAIL because `conversation-context.mjs` does not exist.

- [ ] **Step 2: Implement strict argument construction**

Reject empty target IDs, unknown kinds, missing time, or unknown profile. Do not accept arbitrary additional CLI arguments from message text or metadata.

- [ ] **Step 3: Run the argument tests**

Run: `node src/conversation-context.test.mjs`  
Expected: argument cases pass.

- [ ] **Step 4: Add failing table-driven normalization tests**

Fixtures must cover DWS shapes with `result.messages`, `data.messages`, and raw `messages`; 0/1/29/30/31/100 messages; reverse order; duplicate IDs; missing IDs; empty/system/media messages; direct and group speakers; current message present and absent; and owner style sample caps.

Literal expectations:

```js
assert.equal(context.messages.length, 30);
assert.equal(context.messages[0].messageId, 'm71');
assert.equal(context.messages[29].messageId, 'm100');
assert.equal(context.latestCounterpartyMessage.content, '最后一句');
assert.deepEqual(context.styleSamples.map(item => item.content), ['阿充最近回复', '阿充上一条回复']);
```

Run: `node src/conversation-context.test.mjs`  
Expected: FAIL because normalization is not implemented.

- [ ] **Step 5: Implement normalization and formatting**

Normalize sender direction using the configured owner openDingTalkId/userId; sort ascending; deduplicate by message ID, or sender/time/content hash fallback; append the trusted current inbound message only when absent; filter non-text placeholders; cap history at 30 and style samples at 8; format explicit time/speaker lines and a separate current-target block.

- [ ] **Step 6: Run and commit the pure context module**

```bash
node src/conversation-context.test.mjs
git add src/conversation-context.mjs src/conversation-context.test.mjs package.json
git commit -m "feat: normalize live DingTalk conversation context"
```

### Task 3: Fetch History Through the Existing DWS Event-Stream Installation

**Files:**
- Create: `src/conversation-context-client.test.mjs`
- Create: `src/conversation-context-client.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `buildDingTalkHistoryArgs()` and `normalizeConversationHistory()` from Task 2.
- Produces: `ConversationContextClient.fetch(context) -> normalized context`.

- [ ] **Step 1: Write failing success and failure tests**

Use a deterministic fake runner only at the external process boundary. The fake response mirrors real DWS fields: `success`, `result.messages`, `openMessageId`, `senderOpenDingTalkId`, `sender`, `content`, `createTime`, and `openConversationId`.

Assert returned normalized behavior, not the fake itself. Cover:

- authenticated success with 30 messages;
- `success: false`;
- non-JSON stdout;
- empty/malformed result;
- runner timeout/error;
- configured binary not equal to `/Users/fengzhouchong.fzc/.npm-global/bin/dws`;
- configured transport not equal to `event-stream`.

Run: `node src/conversation-context-client.test.mjs`  
Expected: FAIL because the client does not exist.

- [ ] **Step 2: Implement the narrow client**

Constructor contract:

```js
new ConversationContextClient({
  bin,
  profile,
  transport,
  env,
  cwd,
  ownerIds,
  runner,
  timeoutMs,
  audit,
})
```

`fetch()` must validate the original DWS path and event-stream transport, execute once, require valid success JSON, call Task 2 normalization, and audit only counts/timing/error categories—never raw message content.

- [ ] **Step 3: Run and commit the client**

```bash
node src/conversation-context-client.test.mjs
git add src/conversation-context-client.mjs src/conversation-context-client.test.mjs package.json
git commit -m "feat: fetch live context through the existing DWS path"
```

### Task 4: Add Contextual Alibaba Language Semantics

**Files:**
- Create: `src/alibaba-language.test.mjs`
- Create: `src/alibaba-language.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `annotateAlibabaLanguage(text, history) -> { annotations, ambiguous }`.
- Produces: `formatAlibabaLanguageAnnotations(result) -> string`.

- [ ] **Step 1: Write failing literal grade-disambiguation tests**

Positive fixtures:

```js
['招一个6', '这个同学是7', '5晋6', 'P8向9汇报', '这个HC要几级，先按7看']
```

Expected annotations include `P6`, `P7`, `P5 晋升 P6`, `P8/P9`, and `P7` respectively.

Negative fixtures:

```js
['8月9日上线', '预算9万', '需要6个人', 'V7版本', '跑5分钟', '需求84886503', '第9页']
```

Expected: no grade annotation.

Run: `node src/alibaba-language.test.mjs`  
Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement contextual rules without rewriting source text**

Use explicit people/grade/recruiting/promotion context patterns and explicit date/amount/count/version/duration/ID exclusion patterns. Add concise definitions for 同学、拿结果、闭环、抓手、颗粒度、横向、纵向、owner、对焦、共识、体感、链路、沉淀、复盘、卡点、倒排.

- [ ] **Step 3: Add failing ambiguity and glossary tests**

`“按7来”` without supporting history must remain ambiguous; the same sentence after `“这个岗位定什么层级”` must annotate `P7`. Glossary terms must produce concise semantic notes without altering quoted user text.

- [ ] **Step 4: Run and commit the language module**

```bash
node src/alibaba-language.test.mjs
git add src/alibaba-language.mjs src/alibaba-language.test.mjs package.json
git commit -m "feat: understand Alibaba product language contextually"
```

### Task 5: Integrate Context Before Every Natural-Language Reply

**Files:**
- Create: `src/reply-context.test.mjs`
- Create: `src/reply-context.mjs`
- Modify: `src/index.mjs`
- Modify: `src/identity-policy.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `ConversationContextClient.fetch()`, `annotateAlibabaLanguage()`, and Task 2 formatting.
- Produces: `prepareReplyContext(messageContext) -> { historyPrompt, currentTarget, stylePrompt, languagePrompt }`.
- `runCodex()` consumes the four explicit prompt sections instead of the 12-entry in-process summary as its primary history.

- [ ] **Step 1: Write a failing reply-context orchestration test**

Assert observable output from a real `ReplyContextService` with a deterministic context-client boundary:

```js
assert.match(result.historyPrompt, /最近 30 条真实消息/);
assert.equal(result.currentTarget, '对方最后一句');
assert.match(result.stylePrompt, /阿充最近回复/);
assert.match(result.languagePrompt, /P6/);
```

Add a failure test where history fetch throws and verify `prepare()` rejects with `CONVERSATION_HISTORY_UNAVAILABLE`; no partial prompt is returned.

Run: `node src/reply-context.test.mjs`  
Expected: FAIL because the service does not exist.

- [ ] **Step 2: Implement the reply-context service**

The service must keep the trusted current inbound message, generate the four prompt sections, and never expose another conversation's content.

- [ ] **Step 3: Run the reply-context tests**

Run: `node src/reply-context.test.mjs`  
Expected: PASS.

- [ ] **Step 4: Add a failing integration contract test**

Extend the mechanism acceptance test with a real exported prompt builder or orchestration function. The contract must prove:

- history preparation occurs exactly once before ordinary AI generation;
- the current target is explicit;
- the old 12-entry summary is not labeled as the primary real history;
- a history error prevents the AI runner from being invoked;
- A1 deterministic routes and operator commands do not create duplicate history fetches or duplicate mutations.

Run: `node src/mechanism-acceptance.test.mjs`  
Expected: FAIL on the new contract.

- [ ] **Step 5: Integrate with `index.mjs` minimally**

Instantiate the client with `config.dingtalkBin`, `config.dingtalkProfile`, `config.dingtalkTransport`, `dingtalkProcessEnv()`, `runBufferedProcess`, owner IDs, and audit. For DingTalk natural-language requests call it after deterministic routing and before `runCodex`. Feishu-disabled compatibility may retain the existing local summary path, but DingTalk must not silently fall back to it.

Update the runtime prompt to say:

```text
先回应“当前回应目标”。最近30条只用于消歧；风格样本只来自阿充本人，模仿表达方式但不复制承诺、隐私或历史事实。
```

- [ ] **Step 6: Run focused integration and privacy tests**

```bash
node src/reply-context.test.mjs
node src/mechanism-acceptance.test.mjs
node src/privacy-boundary.test.mjs
node src/identity-policy.test.mjs
node src/im-channels.test.mjs
node src/event-consumer.test.mjs
```

Expected: every command exits 0.

- [ ] **Step 7: Commit the integration**

```bash
git add src/reply-context.mjs src/reply-context.test.mjs src/index.mjs src/identity-policy.test.mjs src/mechanism-acceptance.test.mjs package.json
git commit -m "feat: ground every DingTalk reply in live conversation context"
```

### Task 6: Full-Chain Regression, Repair Loop, and Report

**Files:**
- Create: `docs/testing/2026-08-03-full-chain-regression-report.md`
- Modify when evidence changes: `docs/testing/MECHANISM_ACCEPTANCE.md`
- Modify when evidence changes: `docs/提交验收单.md`

**Interfaces:**
- Consumes: all prior tasks and live local services.
- Produces: a source-backed report with each scenario, command, timestamp, result, failure root cause, repair commit, retest, and final conclusion.

- [ ] **Step 1: Run static and focused gates**

```bash
npm run check
node src/conversation-context.test.mjs
node src/conversation-context-client.test.mjs
node src/alibaba-language.test.mjs
node src/reply-context.test.mjs
```

Record exact exits and outputs.

- [ ] **Step 2: Run the complete Node regression**

Run: `npm test`  
Expected: exit 0. If any test fails, reproduce it alone, write or strengthen the regression test when needed, fix the cause, rerun the focused set, then restart `npm test` from the beginning.

- [ ] **Step 3: Verify the local Codex runtime**

Run: `npm run runtime-smoke`  
Expected: `healthy=true`, `selected=codex`, `label=Codex CLI`.

- [ ] **Step 4: Run live DWS read-only acceptance through the original path**

Use `/Users/fengzhouchong.fzc/.npm-global/bin/dws`, the configured profile/channel, `chat message list`, `--direction older`, `--limit 30`, and JSON output for a controlled direct conversation. Confirm ordering, current-message presence, both sides, and no Wukong process/path.

- [ ] **Step 5: Run A1 and code repository read-only probes**

Query project `2165415`, project `2168196`, `enterprise-development/ai-lab-agent`, and `enterprise-development/ai-native-flow-platform` branch `feature/20260606_29656382_init_project_1`. Do not create a test work item.

- [ ] **Step 6: Restart and verify services**

Create a verified SQLite backup, restart the main service and dashboard, run `npm run health`, inspect logs, and verify the launchd processes are running. Expected health: `healthy=true`, no issues, DingTalk connected/authenticated, Feishu disabled, A1 enabled, Codex selected.

- [ ] **Step 7: Verify the live dashboard in the in-app browser**

Reload `http://127.0.0.1:17655/`, verify it shows online/healthy, A1 instead of Multica, no `Maintenance required`, and no console errors. Keep the dashboard tab as the deliverable browser tab.

- [ ] **Step 8: Write the regression report and commit it**

The report must explicitly list passed, failed-then-fixed, and unexecuted cases. Every repair records root cause, files, commit, and retest evidence. Do not label missing evidence as passed.

```bash
git add docs/testing/2026-08-03-full-chain-regression-report.md docs/testing/MECHANISM_ACCEPTANCE.md docs/提交验收单.md
git commit -m "docs: record full-chain digital human regression"
```

- [ ] **Step 9: Send and verify the single final DingTalk message**

Resolve 谢冰雪 immediately before sending. Require the unique contact to match the previously verified identity and send exactly once:

```text
师姐，我满四周年啦，什么时候请我吃饭？——阿充（James）
```

Require structured DWS success and a definite message/task receipt. If send outcome is uncertain, do not retry automatically.

- [ ] **Step 10: Run final cleanliness and health gates**

```bash
git status --short
npm run health
```

Expected: clean tracked worktree and healthy runtime. Report ignored local Persona/config artifacts separately without exposing secrets.
