# WeChat Relationship Memory Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local, audience-safe person and relationship memory layer shared by personal WeChat direct chats, groups, and Moments.

**Architecture:** Persist immutable, idempotent person-scoped episodes plus temporal facts and a compact relationship profile in the existing SQLite database. Capture events synchronously without model latency, consolidate facts in a serialized background worker, and inject a bounded audience-filtered relationship capsule before every WeChat model call and Moments decision.

**Tech Stack:** Node.js ESM, built-in `node:sqlite`, existing AI runtime, GeWe REST/webhook adapter, existing audit and lifecycle framework.

---

### Task 1: Relationship-memory persistence primitives

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`

**Step 1: Write the failing test**

Add state tests that create two people with the same nickname but different `wxid`, insert the same episode twice, insert temporal facts with evidence, invalidate a superseded fact, and query episodes/facts by person and allowed audience scopes.

**Step 2: Run test to verify it fails**

Run: `node src/state.test.mjs`
Expected: FAIL because relationship tables and methods do not exist.

**Step 3: Write minimal implementation**

Create `relationship_person`, `relationship_episode`, `relationship_fact`, and `relationship_profile` tables with indexes. Add methods for upserting identity metadata, idempotently recording episodes, listing unprocessed episodes, marking consolidation, upserting/invalidation facts, storing profiles, filtering recall by person and allowed audience, and deleting a person's relationship memory transactionally.

**Step 4: Run test to verify it passes**

Run: `node src/state.test.mjs`
Expected: `STATE_TEST_OK`.

**Step 5: Commit**

```bash
git add src/state.mjs src/state.test.mjs
git commit -m "feat: persist temporal relationship memory"
```

### Task 2: Identity, audience, extraction, and recall engine

**Files:**
- Create: `src/wechat-relationship-memory.mjs`
- Create: `src/wechat-relationship-memory.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Cover canonical `wechat:<wxid>` identity, direct/group/Moments audience scopes, nickname collision isolation, deterministic episode capture, strict extraction JSON, rejection of missing evidence and sensitive facts, temporal conflict invalidation, bounded capsule generation, relevance ordering, no private-to-group/Moments leakage, and natural empty-memory fallback.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-relationship-memory.test.mjs`
Expected: FAIL because the module does not exist.

**Step 3: Write minimal implementation**

Implement:

- `canonicalWeChatPersonId()` and `relationshipAudience()`;
- `parseRelationshipReflection()` with strict schema, evidence, confidence, sensitivity and length checks;
- `WeChatRelationshipMemory.observeChat()`, `observeMoment()`, and `observeOutbound()`;
- `contextFor()` that always resolves by canonical person ID, hard-filters audience scopes and current facts, ranks facts/episodes by relevance, importance and recency, and emits a bounded internal capsule;
- `consolidatePerson()` that sends only pending episodes and current memory to the AI callback, writes accepted facts/profile, and marks episodes processed;
- `nudge()`, serialized timer processing, error audit, start/stop lifecycle.

No raw memory text may be written to audit logs.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-relationship-memory.test.mjs`
Expected: `WECHAT_RELATIONSHIP_MEMORY_TEST_OK`.

**Step 5: Commit**

```bash
git add src/wechat-relationship-memory.mjs src/wechat-relationship-memory.test.mjs package.json
git commit -m "feat: build audience-safe relationship recall"
```

### Task 3: Capture WeChat chat events and inject relationship context

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `src/wechat-relationship-memory.test.mjs`

**Step 1: Write the failing test**

Add mechanism contracts proving that inbound WeChat messages are observed before early-return gates, WeChat model calls include relationship context, outbound replies are recorded only after successful sends, and non-WeChat channels do not receive WeChat relationship memory.

**Step 2: Run test to verify it fails**

Run: `node src/mechanism-acceptance.test.mjs`
Expected: FAIL on missing lifecycle and prompt wiring.

**Step 3: Write minimal implementation**

Instantiate one relationship-memory service. Observe every normalized WeChat inbound event using message ID as idempotency key. Extend `runCodex` with an optional relationship context block; before the final WeChat generation call, request a capsule for sender, chat type, chat ID and task. Record successful WeChat outbound messages with the target person from reply context. Never inject this context into DingTalk, Feishu, or WeCom.

**Step 4: Run tests to verify they pass**

Run: `node src/wechat-relationship-memory.test.mjs && node src/mechanism-acceptance.test.mjs && node --check src/index.mjs`
Expected: relationship test OK and all mechanism contracts pass.

**Step 5: Commit**

```bash
git add src/index.mjs src/mechanism-acceptance.test.mjs src/wechat-relationship-memory.test.mjs
git commit -m "feat: ground WeChat replies in relationship memory"
```

### Task 4: Integrate Moments relationship memory

**Files:**
- Modify: `src/wechat-moments-engagement.mjs`
- Modify: `src/wechat-moments-engagement.test.mjs`
- Modify: `src/index.mjs`

**Step 1: Write the failing test**

Add tests that a scanned post/comment becomes an idempotent public episode, a reply decision requests context for the actual author/commenter `wxid`, the prompt contains only public-safe relationship context, and a successful comment records an outbound public episode once.

**Step 2: Run test to verify it fails**

Run: `node src/wechat-moments-engagement.test.mjs`
Expected: FAIL because relationship callbacks are absent.

**Step 3: Write minimal implementation**

Add `observeRelationship`, `retrieveRelationship`, and `observeRelationshipOutbound` callbacks. Observe hydrated Moments before decisions; choose the commenter for thread replies and the post author for proactive replies; inject the public capsule into the existing strict prompt; record outbound only after a non-replayed successful mutation.

**Step 4: Run test to verify it passes**

Run: `node src/wechat-moments-engagement.test.mjs && node src/wechat-relationship-memory.test.mjs`
Expected: both tests pass.

**Step 5: Commit**

```bash
git add src/wechat-moments-engagement.mjs src/wechat-moments-engagement.test.mjs src/index.mjs
git commit -m "feat: personalize Moments with public relationship memory"
```

### Task 5: Configuration, lifecycle, and local history backfill

**Files:**
- Create: `scripts/backfill-wechat-relationship-memory.mjs`
- Create: `scripts/backfill-wechat-relationship-memory.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `config.example.json`
- Modify: `config.distribution.json`
- Modify: `src/index.mjs`
- Modify: `package.json`

**Step 1: Write the failing tests**

Test bounded configuration, background worker start/stop, and a dry-run/backfill function that maps existing `wechat:user:*` and `wechat:group:*` conversation rows into idempotent episodes without exposing text in console output.

**Step 2: Run tests to verify they fail**

Run: `node src/config.test.mjs && node scripts/backfill-wechat-relationship-memory.test.mjs`
Expected: FAIL because config and script are missing.

**Step 3: Write minimal implementation**

Add enabled-by-default local settings for worker interval, capsule size, recall limits, and background batch size. Start/stop the worker with GeWe lifecycle. Build a backfill script that accepts `--dry-run` and `--apply`, writes source-message-id keyed episodes, prints counts only, and can be rerun safely.

**Step 4: Run tests to verify they pass**

Run: `node src/config.test.mjs && node scripts/backfill-wechat-relationship-memory.test.mjs && node --check src/index.mjs`
Expected: all pass.

**Step 5: Commit**

```bash
git add scripts/backfill-wechat-relationship-memory.mjs scripts/backfill-wechat-relationship-memory.test.mjs src/config.mjs src/config.test.mjs config.example.json config.distribution.json src/index.mjs package.json
git commit -m "feat: operate and backfill relationship memory"
```

### Task 6: Privacy, regression, and live rollout verification

**Files:**
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `docs/plans/2026-08-16-wechat-relationship-memory-design.md` if implementation evidence changes the design

**Step 1: Add final acceptance contracts**

Assert wrong-person isolation, no private-to-public leakage, evidence-backed facts, temporal invalidation, bounded capsule, idempotent chat/Moments capture, worker lifecycle, and no relationship memory on non-WeChat channels.

**Step 2: Run focused verification**

Run: `node src/state.test.mjs && node src/wechat-relationship-memory.test.mjs && node src/wechat-moments-engagement.test.mjs && node src/mechanism-acceptance.test.mjs && git diff --check`
Expected: all pass.

**Step 3: Run full verification**

Run: `npm run check && npm test && git diff --check`
Expected: exit 0 and all mechanism contracts pass.

**Step 4: Apply local backfill and inspect counts**

Run: `node scripts/backfill-wechat-relationship-memory.mjs --dry-run`, then `--apply` after count validation. Query counts, distinct people, duplicate source IDs, and audience scopes without printing content.

**Step 5: Restart and verify live service**

Restart the LaunchAgent, verify process and webhook port, confirm new inbound events create person-scoped episodes, confirm capsule audit contains only IDs/counts, and confirm Moments uses `public_moments` scope.

**Step 6: Commit final contracts**

```bash
git add src/mechanism-acceptance.test.mjs docs/plans/2026-08-16-wechat-relationship-memory-design.md
git commit -m "test: enforce relationship memory privacy contracts"
```

