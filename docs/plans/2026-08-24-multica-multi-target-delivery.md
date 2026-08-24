# Multica Multi-Target Delivery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Deliver each Multica artifact idempotently to multiple IM destinations and backfill BEIJ-4's PDF and HTML to both named WeChat groups.

**Architecture:** Keep `multica_delivery_contract` as the artifact-format parent and add `multica_delivery_target` for per-destination delivery state. Resolve explicitly named destinations from validated configuration, then make the artifact delivery worker claim and record each target/attachment pair independently before aggregating the parent status.

**Tech Stack:** Node.js ESM, built-in SQLite (`node:sqlite`), Multica CLI wrapper, GeWe personal-WeChat channel, repository assertion tests.

---

### Task 1: Add persistent per-target delivery state

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`

**Step 1: Write failing state tests**

Add tests that create one parent contract with two targets, assert both can be listed, claim the same attachment independently, and verify a completed first target cannot be claimed again while the second remains pending. Open a database containing only the legacy parent row and assert startup creates the corresponding target row.

**Step 2: Run the state test and verify RED**

Run: `node src/state.test.mjs`

Expected: FAIL because multi-target methods and table do not exist.

**Step 3: Implement the schema and methods**

Create `multica_delivery_target` with primary key `(issue_id, channel, chat_id)`, per-target status/artifact/attempt/error timestamps, and a status index. Add startup `INSERT OR IGNORE ... SELECT` migration from legacy parent contracts.

Add:

```js
upsertMulticaDeliveryTarget(target)
multicaDeliveryTargets(issueId)
updateMulticaDeliveryTarget(issueId, channel, chatId, fields)
claimMulticaArtifactDeliveryTarget(issueId, channel, chatId, attachmentId)
```

Extend `upsertMulticaDeliveryContract` to accept `targets`; legacy single-target callers still create one child target. Reset child artifact progress only when required formats change; adding a target does not reset already delivered targets.

**Step 4: Run the state test and verify GREEN**

Run: `node src/state.test.mjs`

Expected: `STATE_TEST_OK`.

**Step 5: Commit**

```bash
git add src/state.mjs src/state.test.mjs
git commit -m "feat: persist Multica delivery targets"
```

### Task 2: Deliver attachments independently to every target

**Files:**
- Modify: `src/multica-artifact-delivery.mjs`
- Modify: `src/multica-artifact-delivery.test.mjs`

**Step 1: Write failing delivery tests**

Create a contract requiring PDF and HTML with two targets. Supply two attachments and assert four deliveries, target-specific idempotency keys, both target states `delivered`, parent state `delivered`, and zero sends on replay. Add a partial-failure test proving the completed target is not resent when another target becomes ambiguous.

**Step 2: Run and verify RED**

Run: `node src/multica-artifact-delivery.test.mjs`

Expected: FAIL because the worker only reads the parent target.

**Step 3: Implement target-level delivery**

Download each attachment once, loop over live target rows, claim `(issue,target,attachment)` atomically, and use an idempotency key derived from both attachment ID and target identity. Update success/failure on the target row. Aggregate the parent contract only after target updates; successful targets remain terminal even if another target fails.

**Step 4: Run and verify GREEN**

Run: `node src/multica-artifact-delivery.test.mjs`

Expected: `MULTICA_ARTIFACT_DELIVERY_TEST_OK`.

**Step 5: Commit**

```bash
git add src/multica-artifact-delivery.mjs src/multica-artifact-delivery.test.mjs
git commit -m "feat: deliver Multica artifacts to multiple targets"
```

### Task 3: Resolve named delivery destinations from requests

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `config.example.json`
- Modify: `src/delivery-routing.mjs`
- Modify: `src/delivery-routing.test.mjs`
- Modify: `src/multica-group-routing.mjs`
- Modify: `src/multica-group-routing.test.mjs`
- Modify: `src/index.mjs`

**Step 1: Write failing routing tests**

Test validated `multicaDeliveryDestinations` configuration and a pure resolver that maps a request mentioning `AI流程与组织变革交流一群和二群` to two exact WeChat group targets. Assert requests without a configured destination retain the origin conversation as their sole target. Assert pending-create delivery supplements preserve the two targets.

**Step 2: Run and verify RED**

Run:

```bash
node src/config.test.mjs
node src/delivery-routing.test.mjs
node src/multica-group-routing.test.mjs
```

Expected: FAIL on missing config/resolver/targets.

**Step 3: Implement validated destination routing**

Add `multicaDeliveryDestinations` entries containing `label`, `channel`, `chatId`, and bounded `aliases`. Implement `resolveConfiguredDeliveryTargets({request, defaultTarget, destinations})` with exact configured alias matching and unique `(channel,chatId)` output. Update all delivery-contract construction paths to include `targets`.

**Step 4: Run and verify GREEN**

Run the three tests above plus `node src/mechanism-acceptance.test.mjs`.

Expected: all pass and mechanism acceptance covers the multi-target handoff.

**Step 5: Commit**

```bash
git add config.example.json src/config.mjs src/config.test.mjs src/delivery-routing.mjs src/delivery-routing.test.mjs src/multica-group-routing.mjs src/multica-group-routing.test.mjs src/index.mjs src/mechanism-acceptance.test.mjs
git commit -m "feat: route named Multica deliveries to IM targets"
```

### Task 4: Deploy and backfill BEIJ-4 through the formal worker

**Files:**
- Modify: `/Users/Administrator/Library/Application Support/AIPRO/config/config.local.json`
- Deploy runtime files into a new immutable release under `/Users/Administrator/Library/Application Support/AIPRO/releases/`

**Step 1: Run full verification**

Run: `npm test`

Expected: exit 0 with all tests and mechanism acceptance passing.

**Step 2: Configure the two named destinations**

Add the two exact GeWe group IDs and aliases to production config, back up the file first, and validate both group names through `GeWeChannel.getChatroomInfo`.

**Step 3: Deploy**

Copy the current production release, apply only verified runtime changes, syntax-check, run a read-only migration smoke against a database copy, switch `current`, and restart `com.local.aipro-main`.

**Step 4: Backfill BEIJ-4**

Upsert a `pdf/html` parent contract with the two production targets. Invoke the deployed `MulticaArtifactDelivery.syncIssue` using the production client and delivery function path. Do not send if the target rows already show the attachment IDs.

**Step 5: Verify external and internal outcomes**

Require:

- exactly four successful target/artifact records;
- both target rows `delivered` with both attachment IDs;
- parent contract `delivered`;
- no second sends on replay;
- audit events for both groups;
- production health `healthy: true`, WeChat connected, and zero Multica failed/dead jobs.
