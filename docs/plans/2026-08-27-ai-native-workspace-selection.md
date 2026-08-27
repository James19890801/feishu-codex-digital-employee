# AI-Native Workspace Selection Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a constrained AI semantic fallback for Multica workspace selection while preserving deterministic fast paths and fail-closed writes.

**Architecture:** A new pure workspace-selection module first calls the existing deterministic parser and only invokes an injected AI runtime when that parser returns no match. The AI response is accepted only when it contains an exact current candidate ID with `high` confidence; all other outcomes produce a compact clarification rather than another full workspace list. The runtime uses this resolver only during active workspace-selection pending states.

**Tech Stack:** Node.js ESM, built-in `node:assert`, existing Codex AI runtime, SQLite-backed pending actions.

---

### Task 1: Constrained semantic resolver

**Files:**
- Create: `src/multica-workspace-selection.mjs`
- Create: `src/multica-workspace-selection.test.mjs`

**Step 1: Write the failing tests**

Cover these exact cases:

```js
await resolveWorkspaceSelection({ response: '6', workspaces, runAi });
// returns workspace 6 and never calls runAi

await resolveWorkspaceSelection({ response: '最后那个', workspaces, runAi });
// accepts {workspaceId:'ws-6', confidence:'high'}

await resolveWorkspaceSelection({ response: '培训那个', workspaces, runAi });
// rejects an invented ID or low-confidence result
```

Also verify prompt candidates contain only `index/id/name/slug`, output parsing rejects malformed JSON, and AI errors return an ambiguous result instead of throwing into the inbound retry loop.

**Step 2: Run test to verify it fails**

Run: `node src/multica-workspace-selection.test.mjs`

Expected: FAIL because the module does not exist.

**Step 3: Implement the minimal resolver**

Export:

```js
buildWorkspaceSelectionPrompt(input)
parseWorkspaceSelectionDecision(output, workspaces)
resolveWorkspaceSelection(input)
buildWorkspaceSelectionRetryQuestion(missing)
looksLikeSemanticWorkspaceSelectionReply(text)
```

The resolver must call `parseWorkspaceSelection` first, accept only an exact candidate ID plus `confidence: "high"`, and return `{ workspace, source, reason }` without performing any Multica write.

**Step 4: Run tests**

Run: `node src/multica-workspace-selection.test.mjs`

Expected: `MULTICA_WORKSPACE_SELECTION_TEST_OK`.

**Step 5: Commit**

```bash
git add src/multica-workspace-selection.mjs src/multica-workspace-selection.test.mjs
git commit -m "feat: add semantic workspace selection resolver"
```

### Task 2: Preserve pending group continuations

**Files:**
- Modify: `src/multica-group-routing.mjs`
- Modify: `src/multica-group-routing.test.mjs`

**Step 1: Write the failing tests**

Add active-pending group cases for `最后那个`, `培训那个空间`, and `就放到刚才说的那边`; unrelated group text such as `大家下午好` must remain unconsumed.

**Step 2: Run test to verify it fails**

Run: `node src/multica-group-routing.test.mjs`

Expected: the semantic follow-up assertions fail.

**Step 3: Implement the minimal continuation gate**

Use `looksLikeSemanticWorkspaceSelectionReply` only when the same sender already has an active `intake` or `workspace` pending action. Do not broaden ordinary group-message routing.

**Step 4: Run tests**

Run: `node src/multica-group-routing.test.mjs`

Expected: `MULTICA_GROUP_ROUTING_TEST_OK`.

**Step 5: Commit**

```bash
git add src/multica-group-routing.mjs src/multica-group-routing.test.mjs
git commit -m "fix: retain semantic workspace followups"
```

### Task 3: Wire semantic fallback into the create state machine

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write the failing acceptance assertions**

Verify the runtime imports `resolveWorkspaceSelection`, passes bounded conversation context and the existing AI runtime, audits `multica_workspace_semantic_resolved` or `multica_workspace_semantic_ambiguous`, and uses the compact retry question after a failed continuation.

**Step 2: Run test to verify it fails**

Run: `node src/mechanism-acceptance.test.mjs`

Expected: the new `multica-access`/workspace-selection contract fails.

**Step 3: Implement intake and workspace-stage wiring**

For active `intake` and `workspace` stages:

```js
const resolution = await resolveWorkspaceSelection({
  response: cleanText,
  request: pending.originalRequest,
  history: formatHistory(...),
  workspaces: pending.workspaces,
  fallbackWorkspaceId: pending.fallbackWorkspaceId,
  runAi: async prompt => (await runAiRuntime(prompt, boundedOptions)).text,
});
```

On deterministic or semantic match, continue the existing squad/create-confirmation path. On ambiguity or AI failure, keep the pending action and send the compact retry question without repeating all workspace names. Never let the semantic resolver create or update an Issue directly.

**Step 4: Run focused tests**

Run:

```bash
node src/multica-workspace-selection.test.mjs
node src/multica-task-routing.test.mjs
node src/multica-group-routing.test.mjs
node src/mechanism-acceptance.test.mjs
```

Expected: all pass.

**Step 5: Commit**

```bash
git add src/index.mjs src/mechanism-acceptance.test.mjs
git commit -m "feat: use AI fallback for workspace selection"
```

### Task 4: Full verification and production rollout

**Files:**
- Modify deployed release copies of the production files only after source verification.

**Step 1: Run full regression**

Run: `npm test`

Expected: exit 0.

**Step 2: Verify deployed code before restart**

Run syntax checks and the semantic resolver test against the release path. Confirm malformed or invented IDs do not select a workspace.

**Step 3: Restart the main LaunchAgent**

Run: `launchctl kickstart -k gui/501/com.local.aipro-main`

Expected: the main process receives a new PID and all configured channels reconnect.

**Step 4: Run health and state checks**

Run the installed `scripts/health-check.mjs` with production environment variables. Confirm `healthy: true`, no stale processing messages, and the existing `fung5115` pending create request remains present.

**Step 5: Commit any final source-only verification adjustment**

Stage only files belonging to this feature; do not stage unrelated dirty-worktree changes.
