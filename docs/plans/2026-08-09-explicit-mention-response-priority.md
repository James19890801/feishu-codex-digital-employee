# Explicit Mention Response Priority Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a direct @ of the configured digital-human identity create a response obligation without bypassing hard safety or execution boundaries.

**Architecture:** Add deterministic assistant-target recognition to semantic group engagement and carry a `responseRequired` flag through the discussion and semantic-repeat gates. Normal suppression becomes a short idempotent acknowledgement only for response-required messages; human takeover, self/app filtering, validation and rate limiting remain unchanged.

**Tech Stack:** Node.js ESM, SQLite state contracts, DingTalk/Feishu normalization, assertion-based Node tests.

---

### Task 1: Reproduce assistant @ misattribution

**Files:**
- Modify: `src/semantic-group-engagement.test.mjs`
- Modify: `src/semantic-group-engagement.mjs`

**Step 1: Write the failing test**

Add cases using the production-shaped text with empty structured mentions:

```js
const direct = assessGroupEngagement({
  ...base,
  text: '这篇我收了，回头有规则再同步你。 @詹老师',
  mentionedOther: true,
});
assert.equal(direct.action, 'reply_named');
```

Also assert that `@另一位同事` remains `observe`, and `@另一位同事 @詹老师` replies.

**Step 2: Run test to verify it fails**

Run: `node src/semantic-group-engagement.test.mjs`
Expected: FAIL because the production-shaped message returns `addressed_other`.

**Step 3: Write minimal implementation**

Extract deterministic configured-alias targeting and evaluate it before `mentionedOther`. Require direct `@` or the existing direct-address grammar; do not treat arbitrary prose containing an alias as an explicit target.

**Step 4: Run test to verify it passes**

Run: `node src/semantic-group-engagement.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/semantic-group-engagement.mjs src/semantic-group-engagement.test.mjs
git commit -m "fix: prioritize direct assistant mentions"
```

### Task 2: Preserve response obligation through suppression gates

**Files:**
- Modify: `src/discussion-budget-controller.mjs`
- Modify: `src/discussion-budget-controller.test.mjs`
- Modify: `src/semantic-repeat-controller.mjs`
- Modify: `src/semantic-repeat-controller.test.mjs`
- Modify: `src/index.mjs`

**Step 1: Write failing gate tests**

For discussion cooldown/finalizing and semantic-repeat suppress states, pass `responseRequired: true` and assert a short acknowledgement is sent and the result action records an acknowledgement rather than silent suppression.

**Step 2: Run tests to verify they fail**

Run: `node src/discussion-budget-controller.test.mjs && node src/semantic-repeat-controller.test.mjs`
Expected: FAIL because current gates silently handle suppression.

**Step 3: Implement minimal gate behavior**

Add a shared deterministic acknowledgement constant or controller-local equivalent. When `responseRequired` is true, convert silent suppression to a single idempotent acknowledgement. Keep normal unmentioned suppression unchanged.

In `src/index.mjs`, derive the response-required result from the semantic engagement decision or structured group mention and pass it to both gates.

**Step 4: Run focused tests**

Run: `node src/semantic-group-engagement.test.mjs && node src/discussion-budget-controller.test.mjs && node src/semantic-repeat-controller.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/index.mjs src/discussion-budget-controller.mjs src/discussion-budget-controller.test.mjs src/semantic-repeat-controller.mjs src/semantic-repeat-controller.test.mjs
git commit -m "fix: keep explicit mentions responsive"
```

### Task 3: Add mechanism acceptance and verify

**Files:**
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Add acceptance contracts**

Add success, denial, boundary and recovery-oriented contracts for direct assistant @, other-person @, mixed @, and response-required suppression conversion.

**Step 2: Run targeted acceptance**

Run: `npm run test:mechanisms`
Expected: all contracts pass and total count increases.

**Step 3: Run full verification**

Run: `npm run check && npm test`
Expected: exit 0, no mechanism failures.

**Step 4: Commit**

```bash
git add src/mechanism-acceptance.test.mjs
git commit -m "test: require replies to explicit mentions"
```

### Task 4: Integrate and deploy

**Files:**
- No new production files.

**Step 1: Merge into `main` while preserving unrelated untracked files.**

**Step 2: Re-run `npm test` on merged `main`.**

**Step 3: Restart the LaunchAgent with `zsh scripts/install-service.sh`.**

**Step 4: Verify service health and both IM channel states.**

**Step 5: Push `main` to GitHub through the configured local proxy.**
