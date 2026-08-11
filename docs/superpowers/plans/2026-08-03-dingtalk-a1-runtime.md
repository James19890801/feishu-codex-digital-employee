# DingTalk + A1 Local Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run AIPRO locally without Feishu, use DingTalk as the primary IM channel, and replace the active Multica business runtime with a safe A1 workitem adapter.

**Architecture:** Make Feishu an explicit optional channel while preserving the existing default for other deployments. Add focused A1 client, planner, capability, synchronizer, persistence, dashboard, and smoke-test modules that call the official `a1` CLI with bounded JSON execution and reuse the existing preview/confirmation/mutation ledger. Keep dormant Multica source for compatibility, but remove it from this machine's startup and acceptance path.

**Tech Stack:** Node.js 24 ESM, built-in `node:sqlite`, `node:test`-style assertion scripts, official `dingtalk-workspace-cli` 1.0.55, official `a1` CLI, launchd, HTML/CSS/vanilla JavaScript dashboard.

## Global Constraints

- `feishuEnabled: false` must require no Feishu App ID, Open ID, CLI, OAuth, polling, or event consumer.
- DingTalk is the primary real-person channel and must use DWS `>=1.0.55`, `--ai-tag=false`, `--uuid`, and the two personal IM event keys.
- A1 is the only enabled R&D workitem runtime; `multicaEnabled` remains false in the local configuration.
- A1 commands must set `A1_NO_UPDATE_CHECK=1`, request JSON, bound time/output, and never expose BUC/PAT credentials.
- A1 create/update/comment operations require preview, confirmation, execution, and `workitem get` readback.
- Codex and Qoder must each receive a real response smoke test; production `auto` still selects one runtime.
- Missing authentication or unreadable external state is reported as unavailable, never as no activity.

---

### Task 1: Optional Feishu Startup Policy

**Files:**
- Create: `src/runtime-mode.mjs`
- Create: `src/runtime-mode.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/index.mjs`
- Modify: `src/channel-configuration.mjs`
- Modify: `src/channel-configuration.test.mjs`
- Modify: `scripts/check-config.mjs`
- Modify: `scripts/health-check.mjs`
- Modify: `scripts/verify.sh`
- Modify: `package.json`

**Interfaces:**
- Produces: `runtimeMode(config) -> { feishuEnabled, primaryChannel, pollingRequired, websocketRequired }`.
- Produces: `validateFeishuConfiguration(config)`, which is a no-op when Feishu is disabled and retains current validation when enabled.
- Consumes: existing `config`, polling, lark event, and channel status functions.

- [ ] **Step 1: Write failing runtime policy tests**

```js
assert.deepEqual(runtimeMode({ feishuEnabled: false, dingtalkEnabled: true }), {
  feishuEnabled: false,
  primaryChannel: 'dingtalk',
  pollingRequired: false,
  websocketRequired: false,
});
assert.doesNotThrow(() => validateFeishuConfiguration({ feishuEnabled: false }));
assert.throws(() => validateFeishuConfiguration({ feishuEnabled: true }), /feishuAppId/);
```

- [ ] **Step 2: Run `node src/runtime-mode.test.mjs` and verify RED because the module does not exist**
- [ ] **Step 3: Implement `runtime-mode.mjs`, add `feishuEnabled`, and make Feishu field/path validation conditional**
- [ ] **Step 4: Update `index.mjs` so disabled Feishu skips business client, baseline polling, poll loop, and Feishu WebSocket supervisors while DingTalk and drain processing continue**
- [ ] **Step 5: Make channel/dashboard health report Feishu as disabled instead of connected or failed**
- [ ] **Step 6: Run focused tests and `npm run check`; verify GREEN**
- [ ] **Step 7: Commit with `feat: support DingTalk-only startup`**

### Task 2: Bounded A1 CLI Client

**Files:**
- Create: `src/a1-client.mjs`
- Create: `src/a1-client.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `A1Client({ bin, defaultProjectId, runner, timeoutMs, pageSize, maxWorkitems })`.
- Produces: `whoami()`, `listProjects(keyword)`, `listWorkitems(filters)`, `getWorkitem(id)`, `getActivity(id)`, `createWorkitem(fields)`, `updateWorkitem(id, fields)`, `createComment(id, content)`.
- Produces normalized workitems with `id`, `projectId`, `title`, `status`, `assignee`, `category`, `type`, and `updatedAt`.

- [ ] **Step 1: Write failing tests that capture exact CLI arguments and normalize the observed A1 JSON shape**

```js
const client = new A1Client({
  bin: '/opt/a1',
  runner: async (bin, args, options) => {
    calls.push({ bin, args, options });
    return { stdout: JSON.stringify([{ identifier: '84886503', spaceIdentifier: '2165415', subject: '需求', status: 'New', gmtModified: '2026-08-03T10:00:00+08:00' }]), stderr: '' };
  },
});
assert.equal((await client.listWorkitems({ scope: 'personal' }))[0].id, '84886503');
assert.ok(calls[0].args.includes('--no-update-check'));
assert.deepEqual(calls[0].args.slice(-2), ['-f', 'json']);
assert.equal(calls[0].options.env.A1_NO_UPDATE_CHECK, '1');
```

- [ ] **Step 2: Run `node src/a1-client.test.mjs`; verify RED because `A1Client` is missing**
- [ ] **Step 3: Implement strict text/ID validation, JSON parsing, transient retry only for reads, and at-most-once mutations**
- [ ] **Step 4: Implement create/update/comment readback through `getWorkitem`; never retry an ambiguous write**
- [ ] **Step 5: Run client tests and all process-runner tests; verify GREEN**
- [ ] **Step 6: Commit with `feat: add bounded A1 CLI client`**

### Task 3: A1 Planner and Confirmed Capability

**Files:**
- Create: `src/a1-planner.mjs`
- Create: `src/a1-planner.test.mjs`
- Create: `src/a1-capability.mjs`
- Create: `src/a1-capability.test.mjs`
- Modify: `src/pending-actions.mjs`
- Modify: `src/pending-actions.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `looksLikeA1Request(text)`, `buildA1PlannerPrompt(input)`, `parseA1PlannerOutput(text)`, `normalizeA1Plan(proposal, context)`.
- Allowed actions: `answer`, `list`, `get`, `activity`, `create`, `update`, `comment`, `follow`, `unfollow`, `sync_here`, `stop_sync`.
- Produces: `A1Capability.execute(plan, context)`, `prepareMutation(plan, context)`, and `applyMutation(pending, context)`.

- [ ] **Step 1: Write failing planner tests for A1/1A/workitem intent, credential rejection, project resolution, allowed fields, and confirmation levels**
- [ ] **Step 2: Run planner tests and verify RED**
- [ ] **Step 3: Implement the constrained JSON planner; reject delete, raw API, shell, token, permission, and arbitrary-file actions**
- [ ] **Step 4: Write failing capability tests proving reads execute immediately and create/update/comment cannot execute without a matching chat/sender confirmation context**
- [ ] **Step 5: Implement previews, optimistic updated-at comparison, mutation execution, and verified readback messages**
- [ ] **Step 6: Add `a1` to `PendingActionStore.KINDS`; run planner/capability/pending tests and verify GREEN**
- [ ] **Step 7: Commit with `feat: add confirmed A1 workitem actions`**

### Task 4: Durable A1 Change Synchronization

**Files:**
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`
- Create: `src/a1-sync.mjs`
- Create: `src/a1-sync.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces persistence methods `upsertA1Workitem`, `getA1Workitem`, `subscribeA1Workitem`, `unsubscribeA1Workitem`, `a1WorkitemSubscribers`, `subscribeA1Project`, `unsubscribeA1Project`, `a1ProjectSubscribers`, and A1 outbox methods.
- Produces: `A1Synchronizer.cycle()` and `formatA1Change(change)`.

- [ ] **Step 1: Write failing state tests for A1 cache diffs, subscriptions, idempotent notification keys, retry, and dead-letter transitions**
- [ ] **Step 2: Run state tests and verify RED because the A1 schema/methods are missing**
- [ ] **Step 3: Add isolated `a1_*` SQLite tables and methods without migrating or deleting Multica tables**
- [ ] **Step 4: Write failing synchronizer tests for baseline suppression, configured-project-only global sync, individual follows, dedupe, delivery retry, and dead letters**
- [ ] **Step 5: Implement `A1Synchronizer` with bounded scan counts and no global scan when `a1DefaultProjectId` is empty**
- [ ] **Step 6: Run state and synchronizer tests; verify GREEN**
- [ ] **Step 7: Commit with `feat: add durable A1 workitem sync`**

### Task 5: Service, Dashboard, and Operator Integration

**Files:**
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `src/index.mjs`
- Modify: `src/operator-commands.mjs`
- Modify: `src/operator-commands.test.mjs`
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `src/dashboard-server.mjs`
- Modify: `dashboard/index.html`
- Modify: `dashboard/app.js`
- Modify: `dashboard/config-ui.js`
- Modify: `dashboard/config-ui.test.mjs`
- Modify: `scripts/health-check.mjs`
- Create: `scripts/a1-smoke.mjs`
- Modify: `scripts/verify.sh`
- Modify: `package.json`

**Interfaces:**
- Adds config keys `a1Enabled`, `a1Bin`, `a1DefaultProjectId`, `a1SyncIntervalMs`, and `a1MaxWorkitems`.
- Dashboard API produces `a1: { enabled, installed, authenticated, healthy, lastSyncAt, scanned, changes, pending, dead, lastError }`.
- Operator status and help use A1 terminology and no longer advertise Multica.

- [ ] **Step 1: Write failing dashboard/operator/config UI tests for A1 status and disabled Feishu copy**
- [ ] **Step 2: Run focused tests and verify RED**
- [ ] **Step 3: Wire A1 client/planner/capability/synchronizer into `index.mjs`; replace active Multica request/sync paths with A1 paths**
- [ ] **Step 4: Replace the dashboard Multica business card with A1 and expose exact auth/sync failure states**
- [ ] **Step 5: Add `npm run a1-smoke`; make verification conditionally skip Feishu and Multica checks and require A1 when enabled**
- [ ] **Step 6: Run focused tests, `npm test`, and `npm run check`; verify GREEN**
- [ ] **Step 7: Commit with `feat: integrate A1 runtime and dashboard`**

### Task 6: Local Configuration and Real Runtime Acceptance

**Files:**
- Create (gitignored): `config.local.json`
- Create (gitignored): `PERSONA.md`
- Create (gitignored): `BIBLE.md`
- Create (gitignored): `data/`
- Modify only if evidence requires it: `scripts/install-service.sh`, `scripts/install-dashboard-service.sh`

**Interfaces:**
- LaunchAgent `com.local.feishu-codex-digital-employee` runs the DingTalk-first main service despite its legacy label.
- LaunchAgent `com.local.feishu-codex-dashboard` serves `http://127.0.0.1:17655`.

- [ ] **Step 1: Install locked Node/Python dependencies and create local files without fake Feishu values**
- [ ] **Step 2: Write local config with `feishuEnabled:false`, `dingtalkEnabled:true`, `a1Enabled:true`, `multicaEnabled:false`, detected CLI paths, and `aiRuntime:auto`**
- [ ] **Step 3: Re-authorize DWS 1.0.55 if `auth status -f json` is false; confirm `[event] ready` from the two-event consumer**
- [ ] **Step 4: Run `a1 auth whoami -f json` and `npm run a1-smoke`; require authenticated identity and a read-only personal workitem response**
- [ ] **Step 5: Run Codex and Qoder real response samples independently, then run the configured runtime smoke**
- [ ] **Step 6: Install/restart both LaunchAgents, then read back `launchctl print`, logs, port 17655, `/api/status`, and SQLite health**
- [ ] **Step 7: Open the local dashboard in the in-app browser and verify visible DingTalk, A1, Codex, Qoder, and disabled Feishu states**
- [ ] **Step 8: Run `./scripts/verify.sh`; capture any external-auth blocker explicitly and do not report partial verification as complete**
- [ ] **Step 9: Commit tracked runtime/install fixes, if any, with `fix: complete local runtime acceptance`**

