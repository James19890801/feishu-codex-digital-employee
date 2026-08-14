# WeChat Group Multica for Every Participant Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let any explicitly mentioning WeChat group participant create and manage Multica work, use squad selection as the create authorization, continue sender-scoped high-risk confirmation without repeated mentions, and automatically execute and deliver through the original group.

**Architecture:** Expand the narrow WeChat group authorization predicate to authenticated normalized participants, while leaving ingress invocation gating and sender-scoped pending actions intact. Resolve the configured default workspace internally as `My workspace`, expose only squad selection, and bypass context-only observation only for a same-sender pending Multica interaction before reusing the existing confirmation, origin subscription, synchronization, and artifact-delivery pipeline.

**Tech Stack:** Node.js ESM, `node:test`, GeWe webhook normalization, SQLite-backed pending actions and Multica state, existing Multica client/synchronizer/artifact delivery.

---

## Task 1: Authorize every routed WeChat group participant

**Files:**
- Modify: `src/multica-access.mjs`
- Modify: `src/multica-access.test.mjs`
- Modify: `src/multica-capability.test.mjs`

**Step 1: Write failing authorization tests**

Assert that a non-owner `wechat:` sender in a group is authorized when the
request carries `explicitBotMention: true`, while an unmentioned initial request
is denied. Keep Feishu and DingTalk owner-only expectations unchanged.

**Step 2: Run tests and verify the expected failure**

Run: `node --test src/multica-access.test.mjs src/multica-capability.test.mjs`

Expected: the explicitly mentioning non-owner WeChat participant is denied.

**Step 3: Implement the minimal authorization rule**

Authorize a normalized WeChat group participant when the sender has a `wechat:`
identity and the interaction is either an explicit invocation or a validated
same-sender pending continuation. Do not trust arbitrary channel metadata without
the normalized sender prefix.

**Step 4: Rerun focused tests**

Expected: PASS.

## Task 2: Continue pending group actions without repeated mentions

**Files:**
- Create or modify: `src/multica-group-routing.mjs`
- Create or modify: `src/multica-group-routing.test.mjs`
- Modify: `src/index.mjs`
- Modify: `package.json`

**Step 1: Write failing routing-policy tests**

Test a pure helper that returns true only for a WeChat group context-only message
whose same `chatId + senderId` owns a pending `multica_create_route` or `multica`
action and whose text is a valid squad selection, artifact-format supplement,
confirmation, or cancellation.
Different senders and unrelated prose must return false.

**Step 2: Run and verify failure**

Run: `node --test src/multica-group-routing.test.mjs`

Expected: helper/module is absent or returns false for the valid continuation.

**Step 3: Implement and wire the policy**

Check the sender-scoped pending store before `shouldObserveWithoutReply`. For a
valid continuation, clear only the context-only suppression for processing; do
not synthesize a new explicit mention. Pass a pending-continuation authorization
flag into the Multica context so the existing confirmation workflow can execute.
When a pending create receives a PDF or other explicit artifact format, merge it
into the same request, plan description, and origin-bound delivery contract.
Resolve the configured default workspace internally and expose only squad
selection. Apply a create immediately after that selection; do not issue a
second six-digit confirmation for the create path.

**Step 4: Rerun routing, access, and mechanism tests**

Run: `node --test src/multica-group-routing.test.mjs src/multica-access.test.mjs src/mechanism-acceptance.test.mjs`

Expected: PASS.

## Task 3: Verify direct-chat lifecycle parity through delivery

**Files:**
- Modify: `src/multica-capability.test.mjs`
- Modify: `src/multica-sync.test.mjs`
- Modify: `src/multica-artifact-delivery.test.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Add a group-origin creation test**

Prepare and apply a squad-assigned create plan for a non-owner WeChat group
participant. Assert Issue origin, Issue subscription, conversation binding,
sender identity, group chat type, and channel are preserved.

**Step 2: Add progress and artifact delivery assertions**

Verify the synchronizer selects the original WeChat group recipient and the
artifact delivery contract returns the real file through that group. A different
group must never receive the update or artifact.

**Step 3: Run lifecycle suites**

Run: `node --test src/multica-capability.test.mjs src/multica-sync.test.mjs src/multica-artifact-delivery.test.mjs src/mechanism-acceptance.test.mjs`

Expected: PASS.

## Task 4: Full verification and queue-safe deployment

**Files:**
- Verify only unless a scoped regression fix is required.

**Step 1: Run syntax and focused checks**

Run: `git diff --check && node --check src/index.mjs`

Run: `npm run test:multimodal`

Expected: PASS.

**Step 2: Run the full suite**

Run: `npm test`

Expected: exit 0 and mechanism acceptance has zero failures.

**Step 3: Restart only with an empty active inbox**

Read the SQLite inbound counts. Proceed only when pending, failed-due, and
processing total zero. Restart `com.local.feishu-codex-digital-employee`, confirm
a new live PID and green WeChat configuration/authentication/connection/callback
state. Do not send or backfill real messages.

## Task 5: Commit and push the reproducible source

**Files:**
- Stage tracked source/tests/plans and required untracked source modules only.
- Exclude `config.local.json`, tokens, Keychain data, SQLite data, logs,
  `outputs/`, generated knowledge indexes, and security/private reports.

**Step 1: Review staged content for secrets and unrelated generated data**

Run `git diff --cached --check`, inspect `git status --short`, and scan staged
paths/content for credential patterns and private runtime data.

**Step 2: Commit the deployable source**

Create scoped commits without staging excluded runtime artifacts.

**Step 3: Push the current `codex/` branch**

Push to the configured GitHub remote with upstream tracking. Do not force-push.

**Step 4: Verify the remote branch**

Confirm local HEAD equals the remote branch HEAD and report the branch name and
commit, without exposing repository-private identifiers beyond the configured
remote URL already owned by the user.
