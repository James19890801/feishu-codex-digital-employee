# Multica Workspace Default Squad Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically assign every digital-employee-created Issue in the Beijing training workspace to `詹老师的搞事小团队`, with live CLI validation and fail-closed behavior.

**Architecture:** Add a validated configuration list keyed by immutable workspace and squad IDs. Centralize configured-squad resolution in the pure Multica routing module, then reuse it in every create route after the workspace is resolved and the live squad list is loaded. Preserve existing workspace clarification and fallback behavior for all other workspaces.

**Tech Stack:** Node.js ESM, built-in `node:test`/assert-style repository tests, Multica CLI wrapper, JSON runtime configuration, SQLite audit log.

---

### Task 1: Validate workspace default-squad configuration

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `config.example.json`

**Step 1: Write the failing test**

Add a config fixture containing `multicaWorkspaceDefaultSquads` and assert that the exported config preserves trimmed `workspaceId`, `squadId`, `workspaceName`, and `squadName`. Add invalid duplicate-workspace and missing-ID cases that must reject configuration loading.

**Step 2: Run test to verify it fails**

Run: `node src/config.test.mjs`

Expected: FAIL because `multicaWorkspaceDefaultSquads` is not exported or validated.

**Step 3: Write minimal implementation**

Add a bounded validator:

```js
function workspaceDefaultSquads(value) {
  const effective = value === undefined ? [] : value;
  if (!Array.isArray(effective) || effective.length > 100) {
    throw new Error('multicaWorkspaceDefaultSquads must be an array with at most 100 entries');
  }
  const routes = effective.map(item => ({
    workspaceId: String(item?.workspaceId || '').trim(),
    squadId: String(item?.squadId || '').trim(),
    workspaceName: String(item?.workspaceName || '').trim(),
    squadName: String(item?.squadName || '').trim(),
  }));
  if (routes.some(route => !route.workspaceId || !route.squadId)
    || new Set(routes.map(route => route.workspaceId)).size !== routes.length) {
    throw new Error('multicaWorkspaceDefaultSquads entries require unique workspaceId and squadId');
  }
  return routes;
}
```

Export the validated value on `config`, and document its JSON shape in `config.example.json`.

**Step 4: Run test to verify it passes**

Run: `node src/config.test.mjs`

Expected: PASS.

**Step 5: Commit**

```bash
git add src/config.mjs src/config.test.mjs config.example.json
git commit -m "feat: validate Multica workspace squad routes"
```

### Task 2: Resolve a configured squad from the live workspace squad list

**Files:**
- Modify: `src/multica-task-routing.mjs`
- Modify: `src/multica-task-routing.test.mjs`

**Step 1: Write the failing tests**

Test a new pure helper with these cases:

```js
assert.deepEqual(
  configuredWorkspaceSquadSelection('beijing-ws', liveSquads, routes),
  { mode: 'squad', squad: liveSquads[0] },
);
assert.equal(configuredWorkspaceSquadSelection('other-ws', liveSquads, routes), null);
assert.throws(
  () => configuredWorkspaceSquadSelection('beijing-ws', [], routes),
  /configured default squad is unavailable/i,
);
```

Also assert selection is by exact `squadId`, never by name or array order.

**Step 2: Run test to verify it fails**

Run: `node src/multica-task-routing.test.mjs`

Expected: FAIL because the helper is not exported.

**Step 3: Write minimal implementation**

Implement `configuredWorkspaceSquadSelection(workspaceId, squads, routes)`: return `null` when the workspace has no route; return `{ mode: 'squad', squad }` for an exact live ID match; throw a diagnostic error when a route exists but the configured squad is absent.

**Step 4: Run test to verify it passes**

Run: `node src/multica-task-routing.test.mjs`

Expected: `MULTICA_TASK_ROUTING_TEST_OK`.

**Step 5: Commit**

```bash
git add src/multica-task-routing.mjs src/multica-task-routing.test.mjs
git commit -m "feat: resolve configured Multica default squads"
```

### Task 3: Apply the default squad in every new-Issue route

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write the failing acceptance checks**

Add source-level acceptance checks proving that:

- `startMulticaCreateRouting` consults configured defaults before asking for a squad;
- completed intake consults the same resolver;
- a workspace selected or corrected from pending routing uses the same resolver;
- configured-route errors produce a user-visible failure and an audit event rather than falling back to create-only.

**Step 2: Run test to verify it fails**

Run: `node src/mechanism-acceptance.test.mjs`

Expected: FAIL on the new default-squad routing checks.

**Step 3: Write minimal implementation**

Import `configuredWorkspaceSquadSelection`, add one local resolver that combines the configured selection with the existing no-squad automatic selection, and call it at each point after `listSquads`. For pending workspace selection/correction, immediately call `applyRoutedMulticaCreate` when a configured selection exists; otherwise retain the current squad question. Audit successful automatic routing and fail-closed configuration errors.

**Step 4: Run focused tests**

Run:

```bash
node src/multica-task-routing.test.mjs
node src/multica-group-routing.test.mjs
node src/multica-planner.test.mjs
node src/mechanism-acceptance.test.mjs
```

Expected: all focused suites pass.

**Step 5: Commit**

```bash
git add src/index.mjs src/mechanism-acceptance.test.mjs
git commit -m "feat: auto-route Beijing Issues to default squad"
```

### Task 4: Configure production and assign the current Issue

**Files:**
- Modify: `/Users/Administrator/Library/Application Support/AIPRO/config/config.local.json`

**Step 1: Back up and patch production configuration**

Add:

```json
"multicaWorkspaceDefaultSquads": [
  {
    "workspaceId": "0a87c021-0a7e-448f-afa2-9cade200ecaf",
    "workspaceName": "北京AI流程管理特训营",
    "squadId": "a99127ae-906c-4926-a9e4-3e26946ee8f1",
    "squadName": "詹老师的搞事小团队"
  }
]
```

**Step 2: Validate production IDs read-only**

Use `MulticaClient.listSquads(workspaceId)` and require an exact match for the configured squad ID and name.

**Step 3: Assign `BEIJ-4`**

Read `BEIJ-4`, abort if it is no longer in the Beijing workspace, then update only its `assigneeId` and execution status through `MulticaCapability`/CLI. Read it back and verify the live assignee.

**Step 4: Record audit evidence**

Record the Issue ID, identifier, workspace ID, squad ID, and mutation result in the production audit database.

### Task 5: Full verification and deployment

**Files:**
- Deploy changed runtime files into a new immutable release under `/Users/Administrator/Library/Application Support/AIPRO/releases/`

**Step 1: Run full tests**

Run: `npm test`

Expected: exit 0 with all repository and mechanism-acceptance tests passing.

**Step 2: Build a production release**

Copy the current production release, replace only verified changed source files, syntax-check them, make the release read-only, atomically switch `current`, and restart `com.local.aipro-main`.

**Step 3: Run production smoke checks**

Load the production config, list the Beijing space squads through the real CLI, and assert the configured resolver returns `a99127ae-906c-4926-a9e4-3e26946ee8f1` without mutation.

**Step 4: Run health and log checks**

Run the production health check and require `healthy: true`, WeChat `connected: true`, and zero Multica failed/dead jobs. Search the new release startup logs for errors.

**Step 5: Verify receipt behavior**

Confirm the create receipt names `詹老师的搞事小团队` and the audit trail records the automatic workspace default route.
