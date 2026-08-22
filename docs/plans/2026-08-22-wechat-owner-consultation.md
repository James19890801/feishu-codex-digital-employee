# WeChat Owner Consultation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a durable personal-WeChat consultation loop that asks `fung5115` for a decision and relays the authorized answer to the originating chat exactly once.

**Architecture:** Add a dedicated consultation state machine backed by SQLite. Keep trigger and decision parsing deterministic, integrate it before ordinary AI generation, and reuse the existing GeWe sender, group mention routing, reliable inbound queue, and `executeMutationOnce` boundary for outbound side effects.

**Tech Stack:** Node.js ESM, `node:sqlite`, GeWe REST/Webhook, `node:assert`, existing `AgentState`, `executeMutationOnce`, and channel routing helpers.

---

### Task 1: Pure consultation policy

**Files:**
- Create: `src/owner-consultation.mjs`
- Create: `src/owner-consultation.test.mjs`

**Step 1: Write failing tests**

Cover explicit trigger phrases, ordinary mentions, negation/quotation, contextual “好，你去问”, natural Owner request formatting without visible IDs, and Owner decisions `approve`, `reject`, `revise`, and `ambiguous`.

**Step 2: Verify failure**

Run: `node src/owner-consultation.test.mjs`

Expected: module-not-found failure.

**Step 3: Implement pure helpers**

Export:

```js
export function detectOwnerConsultationRequest({ text, recentAssistantText = '' }) {}
export function buildOwnerConsultationMessage(input) {}
export function parseOwnerConsultationDecision(text) {}
export function buildRequesterRelay({ decision, approvedReply }) {}
```

Use bounded text, deterministic regexes, and natural Chinese templates. Never expose the internal consultation ID.

**Step 4: Verify pass**

Run: `node src/owner-consultation.test.mjs`

Expected: `OWNER_CONSULTATION_POLICY_TEST_OK`.

**Step 5: Commit**

```bash
git add src/owner-consultation.mjs src/owner-consultation.test.mjs
git commit -m "feat: define WeChat owner consultation policy"
```

### Task 2: Durable consultation state

**Files:**
- Modify: `src/state.mjs`
- Create: `src/owner-consultation-state.test.mjs`

**Step 1: Write failing tests**

Test idempotent creation by source message ID, owner-message lookup, unique-active fallback, concurrent claim transitions, reminder claim once, expiry claim once, resolution, relay completion, and ambiguous terminal states.

**Step 2: Verify failure**

Run: `node src/owner-consultation-state.test.mjs`

Expected: missing state methods.

**Step 3: Add schema and methods**

Add `owner_consultation` with indexes on source identity, Owner notification message ID, status/reminder, and status/expiry. Add bounded row normalization and transactional methods:

```js
createOwnerConsultation(input)
ownerConsultationById(id)
ownerConsultationByNotificationMessageId(messageId)
activeOwnerConsultations(ownerId, nowMs)
claimOwnerConsultationNotification(id)
markOwnerConsultationAwaiting(id, notificationMessageId)
claimOwnerConsultationResolution(id, decision)
markOwnerConsultationRelayed(id, status)
claimDueOwnerConsultationReminder(nowMs)
claimDueOwnerConsultationExpiry(nowMs)
markOwnerConsultationAmbiguous(id, phase, error)
```

**Step 4: Verify pass and state regression**

Run: `node src/owner-consultation-state.test.mjs && node src/state.test.mjs`

Expected: both pass.

**Step 5: Commit**

```bash
git add src/state.mjs src/owner-consultation-state.test.mjs
git commit -m "feat: persist owner consultation state"
```

### Task 3: Consultation coordinator

**Files:**
- Modify: `src/owner-consultation.mjs`
- Create: `src/owner-consultation-coordinator.test.mjs`

**Step 1: Write failing integration tests**

Use fake state and send functions to cover create-before-send, requester acknowledgement, natural Owner notification, quoted-message correlation, single-active fallback, multi-active ambiguity, Owner spoof rejection, approval/rejection/revision relay, group mention preservation, duplicate Owner response, and ambiguous send handling.

**Step 2: Verify failure**

Run: `node src/owner-consultation-coordinator.test.mjs`

Expected: missing coordinator.

**Step 3: Implement coordinator**

Export `OwnerConsultationCoordinator`. Inject `state`, `ownerIds`, `send`, `executeOnce`, `audit`, and `now`. Keep all external effects behind stable keys:

```text
owner-consultation:<id>:requester-ack
owner-consultation:<id>:owner-notify
owner-consultation:<id>:owner-reminder
owner-consultation:<id>:relay
owner-consultation:<id>:expired
```

Quoted message IDs take precedence. Unquoted replies resolve only when exactly one active record exists.

**Step 4: Verify pass**

Run: `node src/owner-consultation-coordinator.test.mjs`

Expected: `OWNER_CONSULTATION_COORDINATOR_TEST_OK`.

**Step 5: Commit**

```bash
git add src/owner-consultation.mjs src/owner-consultation-coordinator.test.mjs
git commit -m "feat: coordinate owner consultation replies"
```

### Task 4: Runtime and configuration integration

**Files:**
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `config.distribution.json`
- Modify: `src/index.mjs`
- Modify: `src/pending-actions.mjs` only if shared validation is needed
- Create: `src/owner-consultation-runtime.test.mjs`

**Step 1: Write failing runtime contract tests**

Assert that personal-WeChat inbound invokes the coordinator before ordinary AI generation, only configured Owner private messages can resolve consultations, quoted metadata is passed through, group relays mention the requester, and the maintenance loop processes reminders and expirations.

**Step 2: Verify failure**

Run: `node src/owner-consultation-runtime.test.mjs`

Expected: integration contracts missing.

**Step 3: Add configuration**

Add bounded settings:

```json
{
  "geweOwnerConsultationEnabled": true,
  "geweOwnerWxids": ["fung5115"],
  "geweOwnerConsultationReminderMs": 14400000,
  "geweOwnerConsultationTtlMs": 86400000
}
```

**Step 4: Integrate runtime**

Instantiate the coordinator after GeWe is ready. In `processIncoming`, handle valid Owner decisions first, then explicit third-party consultation triggers, then continue existing routes. Add a one-minute recovery loop using the existing shutdown guard and serialized queues. Preserve existing `sendText` relationship memory and group mention behavior.

**Step 5: Verify pass and syntax**

Run: `node src/owner-consultation-runtime.test.mjs && node --check src/index.mjs && node --check src/config.mjs`

Expected: all pass.

**Step 6: Commit**

```bash
git add src/config.mjs config.example.json config.distribution.json src/index.mjs src/owner-consultation-runtime.test.mjs
git commit -m "feat: integrate WeChat owner consultation loop"
```

### Task 5: Observability and acceptance

**Files:**
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `package.json`

**Step 1: Write failing tests**

Add status counts for active, expired, and ambiguous consultations without message bodies. Add acceptance contracts for explicit trigger, Owner identity, quoted correlation, timeout worker, and original-chat relay.

**Step 2: Verify failure**

Run: `node src/dashboard-model.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: missing consultation observability.

**Step 3: Implement bounded metrics**

Expose only counts, latest status time, and safe error codes. Add the focused tests to the package test chain.

**Step 4: Verify focused suite**

Run:

```bash
node src/owner-consultation.test.mjs \
  && node src/owner-consultation-state.test.mjs \
  && node src/owner-consultation-coordinator.test.mjs \
  && node src/owner-consultation-runtime.test.mjs \
  && node src/dashboard-model.test.mjs \
  && node src/mechanism-acceptance.test.mjs
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/dashboard-model.mjs src/dashboard-model.test.mjs src/mechanism-acceptance.test.mjs package.json
git commit -m "test: verify WeChat owner consultation lifecycle"
```

### Task 6: Full verification and live-safe rollout

**Files:**
- Modify only if verification reveals a defect.

**Step 1: Run syntax and focused tests**

Run: `npm run check && npm test`

Expected: pass without changing unrelated dirty files.

**Step 2: Inspect configuration and health read-only**

Confirm the configured Owner list contains `fung5115`, the main service is healthy, and no pending/failed inbound messages would be replayed unexpectedly.

**Step 3: Restart through the repository service mechanism**

Restart only the existing local service. Do not send a synthetic live message to another person.

**Step 4: Read back health**

Verify GeWe is online, the consultation worker is active, and ambiguous count is zero.

**Step 5: Commit any verification fix**

If needed, commit only consultation-related files with a focused message.
