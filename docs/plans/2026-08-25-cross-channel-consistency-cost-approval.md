# Cross-Channel Consistency and Cost Approval Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep professional answers substantively consistent across WeChat group/private chats and require authenticated James approval before any high-cost generation starts.

**Architecture:** Add deterministic request classification and approval snapshots in front of every expensive execution route, then extend the existing owner-consultation state machine to resume approved work idempotently. Add a channel-neutral professional response contract and request fingerprint so channel-specific context can affect presentation without changing the substantive answer.

**Tech Stack:** Node.js ESM, SQLite state store, GeWe personal WeChat channel, Node `assert` tests, existing mutation/idempotency framework.

---

### Task 1: Cost policy classifier

**Files:**
- Create: `src/cost-approval-policy.mjs`
- Create: `src/cost-approval-policy.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Cover image/video generation, explicit file artifacts, deep/complete reports, reading existing media, short summaries, and authenticated owner direct requests.

**Step 2: Run test to verify it fails**

Run: `node src/cost-approval-policy.test.mjs`

Expected: FAIL because the policy module does not exist.

**Step 3: Write minimal implementation**

Export `classifyHighCostRequest()` returning `{ required, category, summary, reason }`. Prefer narrow deterministic patterns and keep existing-media analysis outside the gate.

**Step 4: Run test to verify it passes**

Run: `node src/cost-approval-policy.test.mjs`

Expected: `COST_APPROVAL_POLICY_TEST_OK`.

**Step 5: Commit**

```bash
git add src/cost-approval-policy.mjs src/cost-approval-policy.test.mjs package.json
git commit -m "feat: classify high-cost generation requests"
```

### Task 2: Human-readable requester and location labels

**Files:**
- Modify: `src/owner-consultation.mjs`
- Modify: `src/owner-consultation.test.mjs`
- Modify: `src/im-channel-runtime.mjs`
- Modify: `src/index.mjs`

**Step 1: Write the failing tests**

Assert that approval text contains nickname, WeChat ID, real group name or single-chat label, exact deliverable summary, cost category, and the sentence `请求您的同意`.

**Step 2: Run tests to verify they fail**

Run: `node src/owner-consultation.test.mjs && node src/im-channel-runtime.test.mjs`

Expected: FAIL because the current consultation message has no structured location or requester ID.

**Step 3: Write minimal implementation**

Extend the message builder with `requesterId`, `locationLabel`, `costCategory`, and `approvalReason`. Resolve group names through the GeWe chatroom API, falling back to the group ID; use `与我的微信单聊` for p2p.

**Step 4: Run tests to verify they pass**

Run: `node src/owner-consultation.test.mjs && node src/im-channel-runtime.test.mjs`

Expected: both tests pass.

**Step 5: Commit**

```bash
git add src/owner-consultation.mjs src/owner-consultation.test.mjs src/im-channel-runtime.mjs src/index.mjs
git commit -m "feat: add concrete context to owner approvals"
```

### Task 3: Persistent cost approval snapshots

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`
- Modify: `src/owner-consultation.mjs`
- Modify: `src/owner-consultation.test.mjs`

**Step 1: Write failing state-machine tests**

Cover one approval per source message, exact request fingerprint binding, approve/reject/expire transitions, duplicate callbacks, and execution claim/recovery.

**Step 2: Run tests to verify they fail**

Run: `node src/state.test.mjs && node src/owner-consultation.test.mjs`

Expected: FAIL because consultation rows do not store resumable task snapshots or execution states.

**Step 3: Write minimal schema and coordinator changes**

Add bounded snapshot, request fingerprint, consultation purpose, cost category, location label, and executing/executed states. Reuse existing `executeMutationOnce` keys for notifications, resolution, and execution claims.

**Step 4: Run tests to verify they pass**

Run: `node src/state.test.mjs && node src/owner-consultation.test.mjs`

Expected: both pass with duplicate actions suppressed.

**Step 5: Commit**

```bash
git add src/state.mjs src/state.test.mjs src/owner-consultation.mjs src/owner-consultation.test.mjs
git commit -m "feat: persist resumable cost approvals"
```

### Task 4: Gate every expensive execution route

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `src/multica-artifact-delivery.test.mjs`
- Modify: `src/bible.mjs`
- Modify: `src/bible.test.mjs`

**Step 1: Write failing integration tests**

Prove that non-owner image/video generation, deep reports, artifact followups, Multica creation and reruns stop before execution; prove that media reading, short summaries and authenticated Owner self-chat bypass correctly.

**Step 2: Run tests to verify they fail**

Run: `node src/mechanism-acceptance.test.mjs && node src/multica-artifact-delivery.test.mjs && node src/bible.test.mjs`

Expected: at least the non-owner artifact and report cases fail because they currently execute.

**Step 3: Add the pre-execution gate and resume dispatcher**

Invoke the cost classifier after normalized identity/context resolution but before artifact, Multica or `runCodex` execution. Serialize only bounded allowlisted task fields. On approval, dispatch the stored task once and deliver to its original chat.

**Step 4: Run tests to verify they pass**

Run: `node src/mechanism-acceptance.test.mjs && node src/multica-artifact-delivery.test.mjs && node src/bible.test.mjs`

Expected: all pass and no execution spy is called before approval.

**Step 5: Commit**

```bash
git add src/index.mjs src/mechanism-acceptance.test.mjs src/multica-artifact-delivery.test.mjs src/bible.mjs src/bible.test.mjs
git commit -m "feat: require owner approval for costly generation"
```

### Task 5: Channel-neutral professional response contract

**Files:**
- Create: `src/professional-response-contract.mjs`
- Create: `src/professional-response-contract.test.mjs`
- Modify: `src/index.mjs`
- Modify: `src/wechat-relationship-memory.mjs`
- Modify: `src/wechat-relationship-memory.test.mjs`
- Modify: `package.json`

**Step 1: Write failing contract tests**

Assert stable normalization/fingerprints across @ and quote wrappers, separation of presentation preferences from substantive context, and refusal to reuse private-scoped evidence in groups.

**Step 2: Run tests to verify they fail**

Run: `node src/professional-response-contract.test.mjs && node src/wechat-relationship-memory.test.mjs`

Expected: FAIL because no shared professional contract exists.

**Step 3: Implement the minimal contract**

Generate a versioned request fingerprint from sender plus normalized task, inject an evidence-first substantive contract before channel styling, and audit the contract version/fingerprint/source scopes. Keep privacy scopes unchanged.

**Step 4: Run tests to verify they pass**

Run: `node src/professional-response-contract.test.mjs && node src/wechat-relationship-memory.test.mjs`

Expected: both pass.

**Step 5: Commit**

```bash
git add src/professional-response-contract.mjs src/professional-response-contract.test.mjs src/index.mjs src/wechat-relationship-memory.mjs src/wechat-relationship-memory.test.mjs package.json
git commit -m "feat: stabilize professional answers across wechat surfaces"
```

### Task 6: Full verification and production rollout

**Files:**
- Modify: `README.md` only if operator-facing behavior needs documentation.

**Step 1: Run focused tests**

Run: `node src/cost-approval-policy.test.mjs && node src/owner-consultation.test.mjs && node src/professional-response-contract.test.mjs`

Expected: PASS.

**Step 2: Run repository checks**

Run: `npm run check && npm test`

Expected: exit code 0.

**Step 3: Build and deploy using the existing release mechanism**

Create a versioned release, atomically repoint `current`, and restart the production LaunchAgent without changing unrelated configuration.

**Step 4: Verify production health**

Run the existing health check and inspect bounded startup logs.

Expected: process alive, WeChat connected/authenticated/callback listening, reliability layers healthy, no crash loop.

**Step 5: Record acceptance evidence**

Use synthetic/local test inputs only. Do not send approval requests to real contacts during verification.

