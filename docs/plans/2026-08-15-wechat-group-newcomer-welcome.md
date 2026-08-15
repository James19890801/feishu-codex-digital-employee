# WeChat Group Newcomer Welcome Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically welcome every newly detected member in one configured personal-WeChat group, introduce 小詹, and state that `@小詹` wakes the digital human.

**Architecture:** Extend GeWe normalization to emit a non-conversational group-system signal, then reconcile the target group's official member roster against a privacy-preserving SQLite snapshot. A dedicated welcome controller performs immediate event-driven reconciliation plus a two-minute periodic fallback, persists pending deliveries, retries failures, and sends one merged welcome per detected batch.

**Tech Stack:** Node.js ESM, built-in `node:test`/`assert`, GeWe REST and webhook v1/v2, existing `AgentState` SQLite settings, existing launchd-managed AIPRO runtime.

---

### Task 1: Add validated welcome configuration and roster API support

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `src/im-channel-runtime.mjs`
- Modify: `src/im-channel-runtime.test.mjs`
- Modify: `config.example.json`
- Modify: `config.distribution.json`

**Step 1: Write failing tests**

Add configuration assertions for disabled defaults, a bounded reconciliation interval, a required `@chatroom` target when enabled, and a non-empty expected group name. Add a `GeWeChannel.getChatroomMemberList(chatroomId)` test that expects a POST to `/gewe/v2/api/group/getChatroomMemberList` and a bounded normalized list of `{ memberId, displayName }`.

**Step 2: Run tests to verify RED**

Run: `node src/config.test.mjs && node src/im-channel-runtime.test.mjs`

Expected: failure because the configuration fields and roster method do not exist.

**Step 3: Implement minimal configuration and roster client**

Add:

```js
geweNewcomerWelcomeEnabled: raw.geweNewcomerWelcomeEnabled === true,
geweNewcomerWelcomeGroupId: String(raw.geweNewcomerWelcomeGroupId || '').trim(),
geweNewcomerWelcomeGroupName: String(raw.geweNewcomerWelcomeGroupName || '').trim(),
geweNewcomerWelcomeIntervalMs: boundedInteger(raw.geweNewcomerWelcomeIntervalMs, {
  name: 'geweNewcomerWelcomeIntervalMs', fallback: 120_000, min: 30_000, max: 900_000,
}),
```

Validate enabled configuration without logging the group ID. Implement the roster request and normalize `displayName || nickName || '新朋友'`; reject invalid chatroom IDs and malformed API data.

**Step 4: Run tests to verify GREEN**

Run: `node src/config.test.mjs && node src/im-channel-runtime.test.mjs`

Expected: `CONFIG_TEST_OK` and `IM_CHANNEL_RUNTIME_TEST_OK`.

**Step 5: Commit**

```bash
git add src/config.mjs src/config.test.mjs src/im-channel-runtime.mjs src/im-channel-runtime.test.mjs config.example.json config.distribution.json
git commit -m "feat: configure WeChat newcomer welcome roster"
```

### Task 2: Normalize GeWe group-system signals without entering normal conversation handling

**Files:**
- Modify: `src/im-channels.mjs`
- Modify: `src/im-channels.test.mjs`

**Step 1: Write failing tests**

Add one GeWe v1 `AddMsg` fixture with `MsgType=10000` and one v2 fixture with `msgType='SYSTEM'`. Assert both normalize to the target group with `message_type='system'` and `metadata.groupMembershipSignal=true`. Assert a non-group system event and a normal text message do not gain this flag.

**Step 2: Run test to verify RED**

Run: `node src/im-channels.test.mjs`

Expected: the system fixtures return `null` because only text and image types are currently accepted.

**Step 3: Implement minimal system-event normalization**

Before normal text/image parsing exits, recognize only group-scoped v1 `MsgType=10000` and v2 `SYSTEM`. Produce a bounded system payload with a synthetic system sender and no mentions. Do not parse localized system text to decide who joined; the roster reconciliation is authoritative.

**Step 4: Run test to verify GREEN**

Run: `node src/im-channels.test.mjs`

Expected: `IM_CHANNELS_TEST_OK`.

**Step 5: Commit**

```bash
git add src/im-channels.mjs src/im-channels.test.mjs
git commit -m "feat: detect GeWe group system signals"
```

### Task 3: Build the persistent newcomer welcome controller

**Files:**
- Create: `src/wechat-newcomer-welcome.mjs`
- Create: `src/wechat-newcomer-welcome.test.mjs`

**Step 1: Write failing tests**

Cover:

1. First roster creates a baseline and sends nothing.
2. One added member produces one welcome containing the name, group name, capability introduction, and `@小詹`.
3. Multiple added members produce one merged message.
4. Repeated reconciliation sends nothing after success.
5. A failed send remains pending and succeeds on a later retry.
6. Group-name mismatch disables delivery.
7. Stored state contains member hashes but no raw member IDs.
8. `start()` performs immediate reconciliation and schedules the two-minute fallback; `stop()` cancels it.

**Step 2: Run test to verify RED**

Run: `node src/wechat-newcomer-welcome.test.mjs`

Expected: module-not-found failure.

**Step 3: Implement minimal controller**

Create `WeChatNewcomerWelcome` with injected `state`, `channel`, `groupId`, `groupName`, `intervalMs`, clock and timer functions. Use SHA-256 member fingerprints, a serialized reconciliation promise, persisted `members` and `pending` state, bounded names, and exponential retry timestamps. Save pending work before sending; remove it only after the GeWe send succeeds. Audit only counts, attempt numbers and sanitized errors.

**Step 4: Run test to verify GREEN**

Run: `node src/wechat-newcomer-welcome.test.mjs`

Expected: all newcomer controller tests pass.

**Step 5: Commit**

```bash
git add src/wechat-newcomer-welcome.mjs src/wechat-newcomer-welcome.test.mjs
git commit -m "feat: persist and retry WeChat newcomer welcomes"
```

### Task 4: Integrate the controller with the live GeWe lifecycle

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify locally only: `config.local.json`

**Step 1: Write failing acceptance assertions**

Assert the runtime imports the controller, routes `groupMembershipSignal` to immediate reconciliation without enqueueing it as a user question, starts the controller only after callback registration and online checks succeed, and stops it before clearing the GeWe channel.

**Step 2: Run test to verify RED**

Run: `node src/mechanism-acceptance.test.mjs`

Expected: failure because lifecycle integration is absent.

**Step 3: Implement minimal lifecycle integration**

Instantiate the controller with the configured target after GeWe reports online. In the webhook callback, intercept the signal, call `triggerReconcile('system-event')`, log only sanitized failures, and return without entering `enqueueInbound`. Stop the controller in both GeWe startup failure cleanup and graceful shutdown.

Enable the feature in `config.local.json` with the locally resolved immutable target group ID, expected group name and `120000` interval. Do not copy the real ID into example files, audit logs, design docs or Git.

**Step 4: Run focused tests**

Run:

```bash
node src/wechat-newcomer-welcome.test.mjs
node src/im-channels.test.mjs
node src/im-channel-runtime.test.mjs
node src/config.test.mjs
node src/mechanism-acceptance.test.mjs
node src/gewe-webhook.test.mjs
node --check src/index.mjs
```

Expected: every command exits zero.

**Step 5: Commit**

```bash
git add src/index.mjs src/mechanism-acceptance.test.mjs
git commit -m "feat: run newcomer welcomes on personal WeChat"
```

### Task 5: Deploy, establish the baseline, and verify without posting a historical message

**Files:**
- Runtime state: `data/agent-state.sqlite` (not committed)
- Runtime logs: `bridge.log`, `bridge-error.log` (not committed)

**Step 1: Restart the launchd service**

Run: `launchctl kickstart -k gui/$(id -u)/com.local.feishu-codex-digital-employee`

Expected: the service returns to `state = running` and `127.0.0.1:17656` listens.

**Step 2: Verify a read-only baseline was created**

Query only boolean/count fields from `settings` scope `wechat-newcomer-welcome`. Confirm `initialized=true`, current member count is non-zero, pending count is zero, and no welcome send occurred during initialization.

**Step 3: Run the complete relevant verification**

Run the focused tests from Task 4 plus `npm run check`. Confirm no failures and inspect new runtime errors.

**Step 4: Verify live channel health**

Confirm `authenticated`, `connected`, `callbackListening`, and `callbackRegistered` are true and `lastError` is null. Do not send a synthetic message to the real group.

**Step 5: Push to GitHub main**

```bash
git push origin HEAD:main
```

Expected: local `HEAD` equals `origin/main`; unrelated untracked files remain untouched.
