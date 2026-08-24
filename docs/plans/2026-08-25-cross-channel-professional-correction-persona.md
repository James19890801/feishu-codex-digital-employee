# Cross-Channel Professional Correction Persona Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every normal AI-generated Feishu, DingTalk, and WeChat reply rational, evidence-first, direct about material errors, warm in expression, and never flattering at the expense of correctness.

**Architecture:** Keep the private `PERSONA.md` and `BIBLE.md` as the installed cross-channel source of truth already injected by `runCodex()`, while keeping the same generic contract in the tracked example templates. Put stable identity and tone in Persona, put executable correction and evidence rules in Bible, and add a deterministic template contract test that protects new installations and the shared prompt assembly without committing private identity data.

**Tech Stack:** Markdown persona/configuration files, Node.js ESM, `node:assert/strict`, existing AIPRO launchd deployment.

---

### Task 1: Add the persona contract regression

**Files:**
- Create: `src/persona-contract.test.mjs`
- Modify: `package.json`
- Modify: `templates/PERSONA.example.md`
- Modify: `templates/BIBLE.example.md`
- Test: `src/persona-contract.test.mjs`

**Step 1: Write the failing test**

Create a test that reads the tracked Persona and Bible templates plus `src/index.mjs`, then asserts:

```js
assert.match(persona, /专业判断[^\n]*理性/);
assert.match(persona, /不迎合、不讨好/);
assert.match(persona, /有温度/);
assert.match(bible, /## 1\.2 专业纠错与证据标准/);
assert.match(bible, /结论 → 关键错误与证据 → 正确框架或答案 → 必要建议/);
assert.match(bible, /不攻击人格/);
assert.match(bible, /权威来自事实、推理和可验证性/);
assert.match(indexSource, /\$\{PERSONA_TEXT\}[\s\S]*\$\{BIBLE_TEXT\}/);
```

Add `node src/persona-contract.test.mjs` to the existing `pretest` command without changing any other script behavior.

**Step 2: Run the test to verify it fails**

Run: `node src/persona-contract.test.mjs`

Expected: FAIL because the new Persona and Bible rules do not exist yet.

### Task 2: Implement the professional correction persona

**Files:**
- Modify: `templates/PERSONA.example.md`
- Modify: `templates/BIBLE.example.md`
- Apply the same tested rules to ignored local `PERSONA.md` and `BIBLE.md`
- Test: `src/persona-contract.test.mjs`

**Step 1: Update Persona**

Add a concise global style statement to the tracked template and local private Persona covering professional rationality, evidence priority, non-flattery, warmth, sharpness without personal attack, and pyramid-principle answers for important questions.

**Step 2: Update Bible**

Add `## 1.2 专业纠错与证据标准` to the tracked template and local private Bible with the approved nine rules from the design document.

**Step 3: Run focused tests**

Run:

```bash
node src/persona-contract.test.mjs
node src/bible.test.mjs
```

Expected: both pass.

**Step 4: Run full verification**

Run:

```bash
npm test
npm run check
```

Expected: exit 0; mechanism acceptance remains 132/132 or higher.

### Task 3: Publish the shared memory to production

**Files:**
- Modify: `/Users/Administrator/Library/Application Support/AIPRO/config/PERSONA.md`
- Modify: `/Users/Administrator/Library/Application Support/AIPRO/config/BIBLE.md`

**Step 1: Back up production memory**

Copy the two current production files into the existing production configuration backup directory with one UTC timestamp. Do not alter credentials or `config.local.json`.

**Step 2: Apply the verified files**

Apply the exact tested Persona and Bible changes to production, then verify production and workspace file hashes match.

**Step 3: Restart the shared runtime**

Require zero currently processing inbound messages, then restart `com.local.aipro-main`. Because all three normal IM channels use the same `runCodex()` prompt assembly, one restart activates the shared Persona and Bible everywhere.

**Step 4: Verify production health**

Require:

- the main process is running;
- the production start timestamp is newer than deployment;
- WeChat is authenticated, connected, callback-listening, and callback-registered;
- the reliability supervisor reports `healthy` for local service, tunnel, public callback, provider, and callback registration;
- no new startup syntax, fatal, or callback errors appear;
- production Persona and Bible hashes still match the tested workspace copies.

### Task 4: Commit the isolated implementation

**Files:**
- `templates/PERSONA.example.md`
- `templates/BIBLE.example.md`
- `src/persona-contract.test.mjs`
- `package.json` (only the new test invocation hunk)
- `docs/plans/2026-08-25-cross-channel-professional-correction-persona.md`

**Step 1: Inspect the exact diff**

Run `git diff --check` and verify no unrelated worktree changes enter the staged patch.

**Step 2: Commit only the implementation files/hunks**

Commit message:

```text
feat: enforce evidence-first correction persona
```

If an existing dirty file contains unrelated changes, stage only the intended hunk or leave that file uncommitted rather than capturing another owner's work.
