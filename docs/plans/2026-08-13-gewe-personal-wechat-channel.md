# GeWe Personal WeChat Channel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the existing GeWe adapter a production personal-WeChat channel that reuses the unified AIPRO response runtime and treats verified owner messages as five-minute conversation-level human takeover activity.

**Architecture:** Keep GeWe as a thin transport adapter: normalize inbound callbacks, enqueue them in the existing persistent inbox, and send final replies through `postText`. Extend the existing cross-channel human-takeover and outbound-echo mechanisms instead of adding WeChat-specific response logic; clarify in Dashboard that GeWe is the formal channel and the macOS UI bridge remains experimental.

**Tech Stack:** Node.js ESM, built-in `node:test`-style assertion scripts, SQLite-backed `AgentState`, GeWe REST/Webhook, macOS Keychain, vanilla HTML/JavaScript Dashboard.

---

### Task 1: Normalize verified GeWe owner activity

**Files:**
- Modify: `src/im-channels.mjs:585-650`
- Test: `src/im-channels.test.mjs:650-760`

**Step 1: Write the failing tests**

Add v1 and v2 callback cases showing that a normal message sent by the logged-in WeChat account is no longer discarded. Require the normalized payload to target the actual direct contact or group and carry:

```js
metadata: {
  channel: 'wechat',
  ownerActivity: true,
  ownerControlAuthenticated: true,
  // existing appId and callbackVersion remain present
}
```

Keep a test proving that a non-text self callback is still ignored.

**Step 2: Run the tests to verify failure**

Run:

```bash
node src/im-channels.test.mjs
```

Expected: FAIL because an ordinary self-authored GeWe callback currently returns `null`.

**Step 3: Implement the minimal normalization change**

In `normalizeGeWeWebhook`, remove the early return that accepts only takeover commands for self-authored events. Preserve the existing target calculation, and attach `ownerActivity: true` plus `ownerControlAuthenticated: true` to all verified self-authored text events. Keep `operatorControl: true` only when `matchHumanTakeoverCommand(rawContent)` returns a command, so normal owner messages cannot be mistaken for explicit administrative commands.

**Step 4: Run focused tests**

Run:

```bash
node src/im-channels.test.mjs
```

Expected: `IM_CHANNELS_TEST_OK`.

**Step 5: Commit**

```bash
git add src/im-channels.mjs src/im-channels.test.mjs
git commit -m "feat: normalize GeWe owner activity"
```

Before committing, inspect the staged diff and ensure unrelated pre-existing edits in these files are not staged.

### Task 2: Route authenticated owner activity through unified takeover

**Files:**
- Modify: `src/index.mjs:2350-2385`
- Test: `src/human-takeover.test.mjs`
- Test: `src/im-channel-runtime.test.mjs`

**Step 1: Add behavior tests**

Extend the human-takeover tests to cover the transport-neutral owner-activity contract:

```js
const first = applyOwnerActivityHistory([ownerMessageAt(nowMs)], {
  ownerId: 'wechat:wxid_owner',
  current: null,
  nowMs,
});
assert.equal(first.active, true);
assert.equal(first.state.pausedUntilMs, nowMs + MINIMUM_TAKEOVER_MS);

const extended = applyOwnerActivityHistory([ownerMessageAt(nowMs + 60_000)], {
  ownerId: 'wechat:wxid_owner',
  current: first.state,
  nowMs: nowMs + 60_000,
});
assert.equal(extended.state.pausedUntilMs, nowMs + 60_000 + MINIMUM_TAKEOVER_MS);
```

Add or retain coverage for explicit pause/resume commands and group conversation identifiers.

**Step 2: Run tests and confirm the missing integration**

Run:

```bash
node src/human-takeover.test.mjs
node src/im-channel-runtime.test.mjs
```

Expected: helper-level tests pass; inspection of `processIncoming` still shows that verified GeWe activity cannot enter the owner-activity branch because it requires the Feishu `OWNER_OPEN_ID` and `p2p`.

**Step 3: Generalize the existing runtime gate**

Derive an authenticated activity flag without changing response policy:

```js
const authenticatedOwnerActivity = metadata.ownerActivity === true
  && (senderOpenId === OWNER_OPEN_ID || metadata.ownerControlAuthenticated === true);
```

Use it for both direct and group WeChat conversations. Continue excluding bot chats and explicit bot mentions where applicable. Pass `senderOpenId` as the owner ID to `applyOwnerActivityHistory`, persist the resulting `human_takeover` state, remember the manual message as context, audit it, and return without generating a reply.

Keep the current Feishu and DingTalk behavior intact.

**Step 4: Run focused regression tests**

Run:

```bash
node src/human-takeover.test.mjs
node src/im-channels.test.mjs
node src/im-channel-runtime.test.mjs
node src/reply-routing.test.mjs
```

Expected: all focused tests pass.

**Step 5: Commit**

Stage only the relevant hunks in the already-dirty `src/index.mjs`, then commit:

```bash
git commit -m "feat: apply unified takeover to WeChat owner activity"
```

### Task 3: Apply outbound echo protection to GeWe sends

**Files:**
- Modify: `src/index.mjs:784-840`
- Test: `src/state.test.mjs`
- Test: `src/im-channels.test.mjs`

**Step 1: Add/confirm failing integration expectations**

Add a focused assertion showing a normalized self-authored GeWe callback carries `ownerActivity`, and use the existing `AgentState` echo tests to prove that a recorded outbound text can be consumed once for the same WeChat chat ID and cannot be consumed for another chat.

**Step 2: Run focused tests**

Run:

```bash
node src/state.test.mjs
node src/im-channels.test.mjs
```

Expected: normalization expectations fail before Task 1 or pass afterward; source inspection still shows the GeWe send path bypassing `sendWithEchoGuard`.

**Step 3: Wrap GeWe sends with the existing echo guard**

Change only the WeChat branch in `sendText`:

```js
if (target?.channel === 'wechat') {
  if (!geWeChannel) throw new Error('GeWe personal WeChat channel is not connected');
  return sendWithEchoGuard(chatId, outboundText, () => geWeChannel.send(target, outboundText));
}
```

This records the outbound text before GeWe can reflect it through the callback. The callback is normalized as authenticated owner activity, `enqueueInbound` consumes the echo, and no takeover or reply loop occurs.

**Step 4: Run focused regression tests**

Run:

```bash
node src/state.test.mjs
node src/im-channels.test.mjs
node src/im-channel-runtime.test.mjs
node src/outbound-repeat-controller.test.mjs
```

Expected: all tests pass.

**Step 5: Commit**

Stage only the echo-guard hunk from `src/index.mjs`, then commit:

```bash
git commit -m "fix: prevent GeWe outbound echo loops"
```

### Task 4: Present GeWe as the formal Dashboard channel

**Files:**
- Modify: `dashboard/index.html:132-147`
- Modify: `dashboard/i18n.js:55-75,430-455`
- Modify: `dashboard/app.js:430-450`
- Test: `dashboard/i18n.test.mjs`
- Test: `dashboard/visual-contract.test.mjs`

**Step 1: Write failing label/contract tests**

Require both locales to identify the primary personal-WeChat card as GeWe, remove “legacy/旧版” from that card and action, and identify the macOS UI bridge as experimental rather than the production channel. Preserve the third-party risk notice.

**Step 2: Run Dashboard tests to verify failure**

Run:

```bash
node dashboard/i18n.test.mjs
node dashboard/visual-contract.test.mjs
```

Expected: FAIL because the current UI calls GeWe “legacy/旧版”.

**Step 3: Update the smallest set of labels and rendering calls**

Use labels equivalent to:

- `个人微信 / GeWe`
- `真人身份 · GeWe REST + HTTPS Webhook`
- `配置连接`
- `个人微信本机桥接（实验）`

Do not remove the POC implementation in this task. Do not change any configuration API or status schema.

**Step 4: Run Dashboard tests**

Run:

```bash
node dashboard/i18n.test.mjs
node dashboard/visual-contract.test.mjs
node dashboard/config-ui.test.mjs
```

Expected: all pass.

**Step 5: Commit**

```bash
git add dashboard/index.html dashboard/i18n.js dashboard/app.js dashboard/i18n.test.mjs dashboard/visual-contract.test.mjs
git commit -m "ui: promote GeWe personal WeChat channel"
```

### Task 5: Verify the unified channel implementation

**Files:**
- Verify only: all files changed by Tasks 1-4

**Step 1: Run syntax checks for changed runtime files**

```bash
node --check src/im-channels.mjs
node --check src/index.mjs
node --check dashboard/app.js
node --check dashboard/i18n.js
```

Expected: no output and exit status 0.

**Step 2: Run the focused channel suite**

```bash
node src/im-channels.test.mjs
node src/im-channel-runtime.test.mjs
node src/gewe-webhook.test.mjs
node src/human-takeover.test.mjs
node src/state.test.mjs
node src/outbound-repeat-controller.test.mjs
node dashboard/i18n.test.mjs
node dashboard/visual-contract.test.mjs
node dashboard/config-ui.test.mjs
```

Expected: every script prints its success marker and exits 0.

**Step 3: Run the repository test suite**

```bash
npm test
```

Expected: exit status 0. If an unrelated pre-existing dirty-worktree test fails, capture the exact command and evidence; do not alter unrelated user work to force green.

**Step 4: Review diff and secrets boundary**

```bash
git diff HEAD~4 --check
git status --short
```

Expected: no whitespace errors; no Token, callback secret, App ID, internal IDs, or generated local configuration staged in Git.

### Task 6: Configure and perform live GeWe acceptance

**Files:**
- Local-only configuration: `config.local.json` (never commit)
- Local-only secret: macOS Keychain service `aipro-gewe`

**Step 1: Open the required local and provider pages**

Open the GeWe provider console/documentation and the local AIPRO Dashboard channel configuration. The account owner performs any provider login or QR scan.

**Step 2: Collect only non-secret identifiers in configuration**

Enter the stable GeWe App ID/device ID, public HTTPS callback base URL, and current WeChat display-name aliases. Enter the API Token only in the Dashboard credential field so the backend stores it directly in Keychain.

**Step 3: Save and run the built-in connection acceptance**

Enable the channel through the existing protected configuration flow. Expected checks:

- required configuration present;
- Keychain credential readable;
- loopback callback listener active;
- public callback registered;
- GeWe account online;
- other IM channels remain healthy.

If any check fails, keep `geweEnabled` false or allow the existing configuration rollback to restore the prior state.

**Step 4: Run live message acceptance**

Use a second WeChat account or trusted contact to verify:

1. direct message receives one reply;
2. group message without @ receives none;
3. group message with explicit @ receives one reply;
4. owner manual message pauses that conversation for five minutes;
5. another owner message extends the pause;
6. a new message after expiry resumes response;
7. no outbound echo creates a second reply;
8. Dashboard audit and channel health show the expected events.

**Step 5: Record acceptance without secrets**

Record timestamps, redacted chat type, pass/fail, channel status and any error code. Never record message contents, contact names, wxids, App ID, Token, callback path secret or account identifiers in committed files.
