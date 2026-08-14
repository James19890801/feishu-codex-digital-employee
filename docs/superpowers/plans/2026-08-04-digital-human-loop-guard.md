# Digital Human Loop Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop cross-account digital humans before model generation, send the owner-approved termination sentence once, and retain a 10-round rapid-loop fail-safe without limiting normal human conversation length.

**Architecture:** Add a focused policy/runtime module backed by the existing durable `settings` table. The inbound coordinator runs after owner takeover handling but before greeting, business routing, or model calls; the outbound wrapper records successful sends so a restart-safe rapid-round counter can trip before the next reply.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, built-in `node:test`-style assertion scripts, existing `AgentState` settings storage.

## Global Constraints

- The first explicit automation detection sends exactly `既然是数字人，我就不跟你玩了，浪费token。`.
- Later messages from the same blocked `chat_id + sender_id` are silent.
- The explicit detection path and the tenth rapid round run before greeting, workflow routing, and any AI runtime call.
- Only non-owner, non-self-chat private conversations participate in the guard.
- Normal human conversations have no total-round cap.
- The default raw inbound limit is 60 messages per 300000 milliseconds.
- Preserve existing echo suppression, authorization, human-takeover, durable-inbox, and retry behavior.

---

### Task 1: Explicit automation policy and durable guard

**Files:**
- Create: `src/automation-peer-guard.mjs`
- Create: `src/automation-peer-guard.test.mjs`

**Interfaces:**
- Produces: `AUTOMATION_PEER_TERMINATION_TEXT: string`
- Produces: `detectExplicitAutomationPeer(text): { matched: boolean, evidence: string }`
- Produces: `AutomationPeerGuard`, with `evaluateInbound(input)`, `markTerminated(input)`, and `recordOutbound(input)`.
- Produces: `handleAutomationPeerInbound(input): Promise<{ handled: boolean, notified: boolean, decision: object }>`.
- Produces: `sendWithAutomationPeerTracking(input): Promise<unknown>`.

- [ ] **Step 1: Write failing policy and persistence tests**

Cover these literal cases with real `AgentState` storage in a temporary SQLite file:

```js
assert.equal(detectExplicitAutomationPeer('你好，我是凤小楼，凤楼的 AI 助理。').matched, true);
assert.equal(detectExplicitAutomationPeer('我是做数字人产品的，想体验一下。').matched, false);
assert.equal(detectExplicitAutomationPeer('他说自己是数字人。').matched, false);

const first = await handleAutomationPeerInbound({
  guard, chatId: 'dingtalk:user:peer', senderId: 'dingtalk:peer', chatType: 'p2p',
  text: '我是凤楼的AI助理', messageId: 'm1', sendTermination: async text => sent.push(text),
});
assert.deepEqual(sent, ['既然是数字人，我就不跟你玩了，浪费token。']);
assert.equal(first.notified, true);

const again = await handleAutomationPeerInbound({
  guard: reopenedGuard, chatId: 'dingtalk:user:peer', senderId: 'dingtalk:peer',
  chatType: 'p2p', text: '你好', messageId: 'm2', sendTermination: async text => sent.push(text),
});
assert.equal(again.handled, true);
assert.equal(again.notified, false);
assert.equal(sent.length, 1);
```

The production changes these tests catch are an overly broad identity regex, a missing one-time send, or a non-persistent block.

- [ ] **Step 2: Run the new test and verify RED**

Run: `node src/automation-peer-guard.test.mjs`

Expected: FAIL because `automation-peer-guard.mjs` does not exist.

- [ ] **Step 3: Implement minimal policy and durable runtime**

Use anchored first-person/account identity patterns that require an automation term (`AI`, `智能`, `数字`, `机器人`, or `bot`) together with an assistant/persona noun. Store blocks under scope `automation_peer_block` and rapid activity under `automation_peer_activity`, keyed by the private chat and sender. `handleAutomationPeerInbound` sends the fixed text, then calls `markTerminated`; a failed send must reject before the block is stored.

`evaluateInbound` returns one of these literal actions:

```js
{ action: 'allow', reason: 'not_applicable' | 'no_signal', rapidRounds: number }
{ action: 'terminate', reason: 'explicit_automation_identity', evidence: string }
{ action: 'suppress', reason: 'explicit_automation_identity' | 'rapid_round_limit', rapidRounds: number }
```

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node src/automation-peer-guard.test.mjs`

Expected: `AUTOMATION_PEER_GUARD_TEST_OK` with exit code 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add src/automation-peer-guard.mjs src/automation-peer-guard.test.mjs
git commit -m "feat: add durable automation peer guard"
```

### Task 2: Ten-round rapid-loop behavior and outbound tracking

**Files:**
- Modify: `src/automation-peer-guard.test.mjs`
- Modify: `src/automation-peer-guard.mjs`

**Interfaces:**
- Consumes: `AutomationPeerGuard.evaluateInbound` and `recordOutbound` from Task 1.
- Produces: restart-safe `rapidRounds` counting with a 30000 ms reply window and hard limit 10.
- Produces: `sendWithAutomationPeerTracking({ guard, chatId, text, send })` that records only successful, non-suppressed sends.

- [ ] **Step 1: Add failing rapid-loop tests**

Use an injected clock and real SQLite state. Record an outbound, advance one second, then evaluate an inbound ten times. Assert rounds 1 through 9 return `allow`; round 10 returns `suppress` with `reason: 'rapid_round_limit'`. Reopen the database and assert the same peer remains suppressed. Add a separate case that advances 31000 ms and asserts the next inbound returns `rapidRounds: 0`.

Also assert:

```js
await sendWithAutomationPeerTracking({
  guard, chatId: 'dingtalk:user:human', text: 'reply', send: async () => ({ success: true }),
});
```

records an outbound, while `{ suppressed: true }` and a rejected send do not.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node src/automation-peer-guard.test.mjs`

Expected: FAIL because rapid-round state and/or successful-send tracking is incomplete.

- [ ] **Step 3: Implement the minimal counter and send wrapper**

`recordOutbound` preserves the current `rapidRounds` and writes `lastOutboundAtMs`. On inbound, increment only when `0 <= nowMs - lastOutboundAtMs <= 30000`; otherwise reset to zero. At 10, store a durable block with `reason: 'rapid_round_limit'` before returning `suppress`. The outbound wrapper awaits `send()`, ignores `{ suppressed: true }`, and records only after success.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node src/automation-peer-guard.test.mjs`

Expected: `AUTOMATION_PEER_GUARD_TEST_OK` with exit code 0.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/automation-peer-guard.mjs src/automation-peer-guard.test.mjs
git commit -m "feat: stop rapid automated reply loops"
```

### Task 3: Integrate before reply generation and raise the human burst limit

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `package.json`
- Modify: `src/mechanism-acceptance.test.mjs`

**Interfaces:**
- Consumes: all Task 1 and Task 2 exports.
- Produces: one `AutomationPeerGuard` instance tied to the process `AgentState`.
- Produces: audits `automation_peer_detected`, `automation_peer_rapid_round_limit`, and `automation_peer_suppressed`.

- [ ] **Step 1: Add a failing acceptance contract**

Add a mechanism contract that uses a real `AgentState` and `handleAutomationPeerInbound` to prove the explicit message sends exactly once and a second inbound is silent. Add a 10-round case proving the tenth inbound is handled without a send. Add the new unit test to the `npm test` command in `package.json`.

- [ ] **Step 2: Run focused acceptance and verify RED**

Run: `node src/mechanism-acceptance.test.mjs`

Expected: FAIL until the guard contract imports and integration-facing behavior exist.

- [ ] **Step 3: Wire the inbound guard before the first greeting**

Instantiate the guard next to `AgentState`. In `processIncoming`, after owner/takeover and group-mention gates but before Multica feedback and `shouldIntroduceAssistant`, call `handleAutomationPeerInbound`. Pass a termination callback that invokes `sendText` with idempotency key `automation-peer-stop-${message.message_id}`. Audit and return whenever `handled` is true.

Wrap each actual transport send in `sendText` with `sendWithAutomationPeerTracking`; suppressed sends must not update the rapid-round clock. This keeps every existing caller covered without changing 66 call sites.

- [ ] **Step 4: Raise the default raw-message burst limit**

Change the `rateLimitMaxMessages` fallback in `src/config.mjs` from `10` to `60`, and change `config.example.json` to `60`. Keep the five-minute default window and the existing 1-to-100 validation range.

- [ ] **Step 5: Run focused and full verification**

Run:

```bash
node src/automation-peer-guard.test.mjs
node src/mechanism-acceptance.test.mjs
npm test
git diff --check
```

Expected: focused guard passes, mechanism acceptance has zero failures, full suite exits 0, and `git diff --check` produces no output.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/index.mjs src/config.mjs config.example.json package.json src/mechanism-acceptance.test.mjs
git commit -m "fix: prevent cross-account digital human loops"
```

### Task 4: Requirement review and remote synchronization

**Files:**
- Modify: `docs/superpowers/specs/2026-08-04-digital-human-loop-guard-design.md` only if verification exposes a documented mismatch.

**Interfaces:**
- Consumes: all previous task outputs.
- Produces: verified commits on `codex/digital-human-loop-guard` and a pushed remote branch.

- [ ] **Step 1: Review the diff against every acceptance criterion**

Run `git diff a405176...HEAD --stat` and `git diff a405176...HEAD -- src config.example.json package.json`. Confirm exact termination copy, one-time persistence, tenth-round suppression, 30-second reset, pre-model integration, and default 60-message limit.

- [ ] **Step 2: Run fresh completion verification**

Run `npm test` and require exit code 0 immediately before synchronization.

- [ ] **Step 3: Synchronize the feature branch**

Push `codex/digital-human-loop-guard` without force. If both configured remotes accept the branch, push to `origin` and `codeup`; if either rejects, preserve the local branch and report the exact remote result.
