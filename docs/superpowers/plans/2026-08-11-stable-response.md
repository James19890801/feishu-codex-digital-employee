# AIPR0S Stable Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port explicit-mention response obligations, required-generation fallback, and bounded group semantic-loop protection into the local DingTalk-first AIPR0S branch without importing proactive group behavior.

**Architecture:** Add five focused policy/controller modules around the existing `processIncoming` and final generated-reply path. Persist inbound and outbound semantic claims in the existing SQLite `AgentState`, keep hard safety gates ahead of response obligations, and leave the current DingTalk subscription set unchanged.

**Tech Stack:** Node.js ESM, `node:test`-style executable assertion files, `node:sqlite`, existing DWS channel wrapper, existing durable inbox and audit store.

## Global Constraints

- Preserve the current DingTalk/DWS channel, live reply-context, A1, mail, knowledge, blocklist, human-takeover, outbound-echo, and automation-peer paths.
- Do not subscribe to `user_im_message_receive_group_all` or process unmentioned group traffic.
- Do not add semantic group auto-engagement, delayed group-host mode, adaptive discussion budgets, or quoted approval.
- Hard safety boundaries remain stronger than `responseRequired`.
- Defaults are a 30-minute inbound semantic window, two visible replies, and a 10-minute outbound semantic window.
- Raw inbound text, generated text, prompts, credentials, and private history must not be copied into audit details.
- Preserve the user's existing uncommitted changes to `package.json`, `scripts/nightly-knowledge-sync.mjs`, and `scripts/nightly-knowledge-sync.test.mjs` when the finished commits are integrated back.
- Use the existing branch's `James`/AIPR0S identity; do not import remote AIPRO branding or Feishu prerequisites.

---

### Task 1: Response Obligation and Required Fallback

**Files:**

- Create: `src/response-obligation.mjs`
- Create: `src/response-obligation.test.mjs`
- Create: `src/required-response-fallback.mjs`
- Create: `src/required-response-fallback.test.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`

**Interfaces:**

- Produces: `normalizeResponseMentionAliases(values, defaults): string[]`
- Produces: `assessResponseObligation({ message, metadata, text, aliases }): { explicitAssistantMention: boolean, responseRequired: boolean, reasonCode: string }`
- Produces: `REQUIRED_RESPONSE_FALLBACK_REPLY: string`
- Produces: `resolveRequiredResponse({ responseRequired, generate }): Promise<{ text: string, fallback: boolean, error: string }>`
- Produces config: `responseMentionAliases: string[]`

- [ ] **Step 1: Write the failing response-obligation test**

Create table-driven assertions covering a DingTalk `user_im_message_receive_at` group event, a structured Feishu group mention, admitted group text ending in `@詹老师`, a message that only mentions another person, a mixed mention, and a direct message. Literal expected results must distinguish `structured_assistant_mention`, `assistant_alias_mention`, `other_mention`, and `not_group`.

```js
assert.deepEqual(assessResponseObligation({
  message: { chat_type: 'group', mentions: [{ id: 'dingtalk-current-user' }] },
  metadata: { channel: 'dingtalk', eventType: 'user_im_message_receive_at' },
  text: '@James 看一下',
  aliases: ['James', '詹老师'],
}), {
  explicitAssistantMention: true,
  responseRequired: true,
  reasonCode: 'structured_assistant_mention',
});
```

- [ ] **Step 2: Run the response-obligation test and verify RED**

Run: `node src/response-obligation.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `response-obligation.mjs`.

- [ ] **Step 3: Implement the minimal obligation classifier**

Normalize aliases with NFKC, trimming, deduplication, and a 20-item bound. For admitted group messages, treat the DingTalk `receive_at` event or a structured current-assistant mention as explicit. Detect text aliases only as `@`/`＠` tokens with a safe end boundary. Do not classify direct messages as response obligations.

- [ ] **Step 4: Run the obligation test and verify GREEN**

Run: `node src/response-obligation.test.mjs`

Expected: `RESPONSE_OBLIGATION_TEST_OK`.

- [ ] **Step 5: Write the failing required-fallback test**

Cover normal generation, required generation failure, and non-required generation failure. Use the literal fallback text from the design and assert that non-required failure rethrows the original error.

```js
const reply = await resolveRequiredResponse({
  responseRequired: true,
  generate: async () => { throw new Error('AI unavailable'); },
});
assert.equal(reply.fallback, true);
assert.equal(reply.text, '收到，这条我先接住。刚才回复生成失败了，你不用重复发，我恢复后继续处理。');
```

- [ ] **Step 6: Run the fallback test and verify RED**

Run: `node src/required-response-fallback.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `required-response-fallback.mjs`.

- [ ] **Step 7: Implement the minimal fallback wrapper**

Call `generate` exactly once. Return the generated text unchanged on success. Return the deterministic fallback and bounded error text only for required responses; otherwise rethrow.

- [ ] **Step 8: Add validated alias configuration**

Add these defaults to `config.example.json`:

```json
"responseMentionAliases": ["James", "詹老师", "数字人", "AIPR0S"]
```

In `src/config.mjs`, derive `config.responseMentionAliases` with `normalizeResponseMentionAliases(raw.responseMentionAliases, [operatorProfile.brandName, "James", "詹老师", "数字人", "AIPR0S"])`. Invalid entries are removed; an explicitly empty list falls back to the safe defaults.

- [ ] **Step 9: Run focused and configuration checks**

Run:

```bash
node src/response-obligation.test.mjs
node src/required-response-fallback.test.mjs
node --check src/config.mjs
```

Expected: both test sentinels and all exit codes 0.

- [ ] **Step 10: Commit Task 1**

```bash
git add config.example.json src/config.mjs src/response-obligation.mjs src/response-obligation.test.mjs src/required-response-fallback.mjs src/required-response-fallback.test.mjs
git commit -m "feat: define required response obligations"
```

---

### Task 2: Deterministic Semantic Topics and Atomic Inbound Claims

**Files:**

- Create: `src/semantic-repeat-guard.mjs`
- Create: `src/semantic-repeat-guard.test.mjs`
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`

**Interfaces:**

- Produces: `normalizeSemanticText(text): string`
- Produces: `semanticTopic(text): SemanticTopic`
- Produces: `compareSemanticTopics(previous, current, options): { repeat: boolean, similarity: number, reason: string }`
- Produces: `AgentState.claimSemanticRepeat({ channel, chatId, senderId, messageId, topic, nowMs, windowMs, maxReplies })`
- Produces: `AgentState.semanticRepeatStats(nowMs)`

- [ ] **Step 1: Write the failing semantic-topic test**

Cover mention removal, exact normalized repeats, conservative paraphrases, different URLs/Issue IDs/dates/numbers, explicit continuation, terminal handoff variants, and short ambiguous fail-open behavior. Expected values must be literal and must not call the production normalizer to build assertions.

- [ ] **Step 2: Run the semantic-topic test and verify RED**

Run: `node src/semantic-repeat-guard.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement deterministic topic comparison**

Port only the pure local normalization and conservative comparison behavior from remote `origin/main:src/semantic-repeat-guard.mjs`. Retain structured-signal resets and do not call the AI runtime.

- [ ] **Step 4: Run the semantic-topic test and verify GREEN**

Run: `node src/semantic-repeat-guard.test.mjs`

Expected: `SEMANTIC_REPEAT_GUARD_TEST_OK`.

- [ ] **Step 5: Add failing state tests for atomic repeat claims**

Extend `src/state.test.mjs` with a temporary real SQLite database. Assert:

```js
assert.equal(state.claimSemanticRepeat({ ...base, messageId: 'm1', nowMs: 1_000 }).action, 'process');
assert.equal(state.claimSemanticRepeat({ ...base, messageId: 'm2', nowMs: 2_000 }).action, 'close');
assert.equal(state.claimSemanticRepeat({ ...base, messageId: 'm3', nowMs: 3_000 }).action, 'suppress');
assert.equal(state.claimSemanticRepeat({ ...base, messageId: 'm3', nowMs: 3_100 }).reason, 'same_inbound_retry');
```

Also assert sender/chat isolation, expiry reset, changed structured signals reset, and sanitized stats.

- [ ] **Step 6: Run the state test and verify RED**

Run: `node src/state.test.mjs`

Expected: FAIL because `claimSemanticRepeat` is not defined.

- [ ] **Step 7: Add the SQLite table and transaction**

Create `semantic_repeat_guard` keyed by `(channel, chat_id, sender_id)` with bounded topic JSON, reply/suppression counts, timestamps, expiry, last action, similarity, and last message ID. Implement `claimSemanticRepeat` with `BEGIN IMMEDIATE`, same-message idempotency, rollback on failure, and `maxReplies` bounded to 2–5. Add expiry cleanup to `prune()` and return its count as `semanticRepeat`.

- [ ] **Step 8: Run focused state verification**

Run:

```bash
node src/semantic-repeat-guard.test.mjs
node src/state.test.mjs
```

Expected: both exit 0.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/semantic-repeat-guard.mjs src/semantic-repeat-guard.test.mjs src/state.mjs src/state.test.mjs
git commit -m "feat: persist semantic repeat claims"
```

---

### Task 3: Inbound Repeat Controller and Configuration

**Files:**

- Create: `src/semantic-repeat-controller.mjs`
- Create: `src/semantic-repeat-controller.test.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`

**Interfaces:**

- Consumes: `AgentState.claimSemanticRepeat(...)`
- Produces: `SEMANTIC_REPEAT_CLOSE_REPLY`
- Produces: `SEMANTIC_REPEAT_REQUIRED_ACK_REPLY`
- Produces: `semanticRepeatEligibility(input)`
- Produces: `applySemanticRepeatGate(input): Promise<RepeatDecision>`
- Produces config: `semanticRepeatGuardEnabled`, `semanticRepeatWindowMs`, `semanticRepeatMaxReplies`

- [ ] **Step 1: Write the failing controller test**

Use a real temporary `AgentState`. Assert first process, second deterministic close without an AI call, third silent suppression, later required acknowledgement, new structured information reset, direct-message bypass, unsupported-channel bypass, operator-command bypass, same-inbound send retry, and audit redaction.

- [ ] **Step 2: Run the controller test and verify RED**

Run: `node src/semantic-repeat-controller.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the minimal controller**

Eligible channels are `feishu` and `dingtalk`; eligible chat type is `group`; eligible message types are `text` and `post`. On `close`, send `这个话题我们先到这里，有新情况再 @ 我。`. On later suppression with `responseRequired=true`, send `收到，这条我看到了；相同内容我不重复展开，有新问题我继续接。`. Use message-specific idempotency keys and sanitized audit details.

- [ ] **Step 4: Add validated controller configuration**

Add to `config.example.json`:

```json
"semanticRepeatGuardEnabled": true,
"semanticRepeatWindowMs": 1800000,
"semanticRepeatMaxReplies": 2
```

Use `boundedInteger` in `src/config.mjs` with the exact bounds from the design.

- [ ] **Step 5: Run focused verification**

Run:

```bash
node src/semantic-repeat-controller.test.mjs
node --check src/config.mjs
```

Expected: controller sentinel and exit codes 0.

- [ ] **Step 6: Commit Task 3**

```bash
git add config.example.json src/config.mjs src/semantic-repeat-controller.mjs src/semantic-repeat-controller.test.mjs
git commit -m "feat: bound repeated group responses"
```

---

### Task 4: Outbound Semantic Duplicate Protection

**Files:**

- Create: `src/outbound-repeat-controller.mjs`
- Create: `src/outbound-repeat-controller.test.mjs`
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`

**Interfaces:**

- Produces: `AgentState.claimOutboundReply({ chatId, audienceKey, content, nowMs, windowMs })`
- Produces: `AgentState.releaseOutboundReplyClaim(claimId)`
- Produces: `sendUnlessRecentRepeat({ state, chatId, audienceKey, text, responseRequired, nowMs, windowMs, send, audit })`
- Produces config: `outboundRepeatWindowMs`

- [ ] **Step 1: Write failing outbound state/controller tests**

Use real SQLite state and assert exact and high-confidence semantic duplicates are suppressed for the same chat/audience, changed numeric facts are sent, other audiences are isolated, failed sends release claims, downstream suppression releases claims, and `responseRequired=true` sends the deterministic acknowledgement rather than returning silent suppression.

```js
const required = await sendUnlessRecentRepeat({
  ...base,
  text: '同一个结论！',
  responseRequired: true,
  send: async text => sent.push(text),
});
assert.equal(required.acknowledged, true);
assert.equal(sent.at(-1), '收到，这条我看到了；相同内容我不重复展开，有新问题我继续接。');
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node src/outbound-repeat-controller.test.mjs
node src/state.test.mjs
```

Expected: missing module or missing state methods.

- [ ] **Step 3: Implement outbound claim persistence**

Add `outbound_reply_guard` with chat, audience, signature, bounded topic JSON, creation, and expiry. Compare at most 20 recent topics, require similarity at least 0.9 for fuzzy semantic suppression, and clean expired claims before matching. Add pruning and return `outboundReply` count.

- [ ] **Step 4: Implement the outbound controller**

Claim before send. Release the claim on a thrown send or downstream `{ suppressed: true }`. For a duplicate required response, send `SEMANTIC_REPEAT_REQUIRED_ACK_REPLY` directly and audit `outbound_repeat_required_acknowledged`; for a duplicate ordinary response, return `{ suppressed: true, reason: 'outbound_repeat' }` and audit `outbound_repeat_suppressed`.

- [ ] **Step 5: Add validated outbound window configuration**

Add `"outboundRepeatWindowMs": 600000` to `config.example.json`; bound it from 60,000 to 3,600,000 ms in `src/config.mjs`.

- [ ] **Step 6: Run focused verification**

Run:

```bash
node src/outbound-repeat-controller.test.mjs
node src/state.test.mjs
node --check src/config.mjs
```

Expected: all exit codes 0.

- [ ] **Step 7: Commit Task 4**

```bash
git add config.example.json src/config.mjs src/outbound-repeat-controller.mjs src/outbound-repeat-controller.test.mjs src/state.mjs src/state.test.mjs
git commit -m "feat: suppress repeated outbound replies"
```

---

### Task 5: Wire the Policies into the Existing DingTalk Reply Path

**Files:**

- Create: `src/stable-response-policy.mjs`
- Create: `src/stable-response-policy.test.mjs`
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes all Task 1–4 interfaces.
- Produces: `evaluateStableResponseInbound(input): Promise<{ responseRequired: boolean, handled: boolean, obligation: object, repeat: object }>`
- Produces: `generateStableResponse({ responseRequired, generate, audit }): Promise<{ text: string, fallback: boolean, error: string }>`
- Produces: `sendStableGeneratedReply({ state, message, senderId, text, responseRequired, windowMs, send, audit }): Promise<object>`
- Preserves `sendText(client, chatId, text, uuid, options)` as the only delivery path.
- Produces integration behavior: required mention detection, pre-generation repeat gating, required fallback, and generated-group outbound deduplication.

- [ ] **Step 1: Write the failing stable-response integration test**

Create `src/stable-response-policy.test.mjs` against the wished-for integration API. With a real temporary `AgentState`, prove that a third repeated DingTalk `receive_at` message returns `handled=true`, sends the required acknowledgement, and never invokes the supplied generator. Also prove required generation failure returns the deterministic fallback and a repeated required outbound answer becomes an acknowledgement.

- [ ] **Step 2: Run the integration test and verify RED**

Run: `node src/stable-response-policy.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `stable-response-policy.mjs`.

- [ ] **Step 3: Implement the stable-response policy adapter**

Compose Task 1–4 functions without adding new policy. `evaluateStableResponseInbound` calculates the obligation and applies the inbound gate. `generateStableResponse` delegates to `resolveRequiredResponse` and emits only sanitized fallback audit detail. `sendStableGeneratedReply` bypasses outbound semantic protection for direct messages and uses `sendUnlessRecentRepeat` for group messages.

- [ ] **Step 4: Run the integration test and verify GREEN**

Run: `node src/stable-response-policy.test.mjs`

Expected: `STABLE_RESPONSE_POLICY_TEST_OK`.

- [ ] **Step 5: Add mechanism-acceptance contracts**

Import the new pure/controller interfaces into `src/mechanism-acceptance.test.mjs`. Add contracts proving:

- a DingTalk group `receive_at` event creates a response obligation;
- a third repeated explicit mention is acknowledged without an AI call;
- required generation failure yields the deterministic fallback;
- a repeated required outbound answer is acknowledged rather than silent;
- direct messages bypass the inbound semantic gate;
- human takeover and the communication blocklist remain stronger gates through their existing contracts.

- [ ] **Step 6: Run mechanism acceptance**

Run: `node src/mechanism-acceptance.test.mjs`

Expected: all old and new behavioral contracts pass before the monolithic runtime wiring changes.

- [ ] **Step 7: Import and calculate the response obligation**

In `processIncoming`, after human takeover, the existing group-mention admission gate, and automation-peer handling, call `assessResponseObligation`. Audit `response_obligation_detected` without text. Compute `operatorCommand` before the repeat gate so owner help/status commands bypass semantic repeat logic.

- [ ] **Step 8: Apply the inbound semantic-repeat gate**

Before Multica/A1/general generation paths, call `applySemanticRepeatGate` with the current channel, sender, message, clean text, configuration, and `responseRequired`. The `sendClose` callback must call existing `sendText` with the supplied idempotency key. Return immediately when the controller handles the message.

- [ ] **Step 9: Wrap the final general answer generation**

Wrap the full DingTalk grounded-reply or ordinary `runCodex` branch inside `resolveRequiredResponse`. If fallback is used, audit `required_response_fallback_sent` with a bounded error summary. Remember and send the resolved text exactly once.

- [ ] **Step 10: Apply outbound deduplication only to generated group replies**

For the final general-answer send at the end of `processIncoming`, call `sendUnlessRecentRepeat` only when `message.chat_type === 'group'`. Use `senderOpenId` as `audienceKey`, `config.outboundRepeatWindowMs`, and an existing `sendText` callback. Do not wrap status, authorization, mutation receipts, error receipts, direct messages, or deterministic inbound-repeat closures.

- [ ] **Step 11: Add the new focused tests to the existing test entrypoint**

Append the five new test files to `pretest` without changing the user's existing `test:nightly-knowledge` edit:

```json
"pretest": "node src/response-obligation.test.mjs && node src/required-response-fallback.test.mjs && node src/semantic-repeat-guard.test.mjs && node src/semantic-repeat-controller.test.mjs && node src/outbound-repeat-controller.test.mjs && node src/stable-response-policy.test.mjs && npm run test:operator-profile && npm run test:communication-blocklist && npm run test:dws-deployment-policy && npm run test:identity && npm run test:memory && npm run test:nightly-knowledge && npm run test:a1 && npm run test:conversation-context && npm run test:mail && npm run test:alibaba-language && npm run test:reply-context && npm run test:inventory"
```

- [ ] **Step 12: Run focused integration verification**

Run:

```bash
node src/response-obligation.test.mjs
node src/required-response-fallback.test.mjs
node src/semantic-repeat-guard.test.mjs
node src/semantic-repeat-controller.test.mjs
node src/outbound-repeat-controller.test.mjs
node src/stable-response-policy.test.mjs
node src/im-channels.test.mjs
node src/human-takeover.test.mjs
node src/automation-peer-guard.test.mjs
node src/mechanism-acceptance.test.mjs
node --check src/index.mjs
```

Expected: all sentinels and exit codes 0.

- [ ] **Step 13: Commit Task 5**

```bash
git add package.json src/index.mjs src/mechanism-acceptance.test.mjs src/stable-response-policy.mjs src/stable-response-policy.test.mjs
git commit -m "feat: enforce stable group response policy"
```

---

### Task 6: Full Verification, Integration, and Local Runtime Readback

**Files:**

- Verify: all files from Tasks 1–5
- Preserve: `scripts/nightly-knowledge-sync.mjs`, `scripts/nightly-knowledge-sync.test.mjs`, and the user's package edit

**Interfaces:**

- Consumes the completed stable-response implementation.
- Produces verified commits safely integrated into `agent/aipro-commercial-platform-upgrade` and a restarted local runtime if all gates pass.

- [ ] **Step 1: Review the implementation against the design**

Read `docs/superpowers/specs/2026-08-11-stable-response-design.md` and map each objective, non-goal, safety priority, audit rule, and test requirement to a concrete diff or test. Remove any accidental proactive-group, group-host, discussion-budget, quoted-approval, Feishu prerequisite, or branding change.

- [ ] **Step 2: Run the full verification gate in the isolated worktree**

Run:

```bash
npm test
npm run check
git diff --check HEAD~5..HEAD
git status --short
```

Expected: test and check exit 0, no whitespace errors, and a clean feature worktree.

- [ ] **Step 3: Integrate feature commits back into the original local branch**

Cherry-pick only the stable-response implementation commits onto `agent/aipro-commercial-platform-upgrade`. Do not cherry-pick or stage unrelated working-tree changes. If `package.json` overlaps, preserve the user's `test:nightly-knowledge` command and add the new `pretest` entries manually, then continue the cherry-pick.

- [ ] **Step 4: Verify the integrated dirty working tree**

Run the focused suite, `npm test`, `npm run check`, and `git diff --check` from the original checkout. Confirm `git status --short` still shows the pre-existing nightly knowledge-sync changes and no unexpected files.

- [ ] **Step 5: Restart and read back the local service**

Run the repository-supported service installer, wait for process and DingTalk channel readiness, then run `npm run health`. Do not send synthetic messages into a real group. Inspect the current audit/state schema and recent sanitized counts to confirm the new tables are present without claiming a live @ reply was exercised.

- [ ] **Step 6: Report evidence and remaining live-verification boundary**

Report separately:

- implemented and committed behavior;
- focused/full/check verification results;
- service restart and current DingTalk health;
- the unchanged pre-existing working-tree files;
- live group @ behavior as unverified unless a real inbound message occurs naturally.
