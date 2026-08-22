# WeChat Official Account Private Message Block Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent personal WeChat from generating or sending private-chat replies to official accounts while preserving the configured owner-article syndication automation.

**Architecture:** Add a small pure policy module that recognizes `gh_...` official-account identities and point-to-point targets. Mark normalized GeWe callbacks, short-circuit generic inbound processing after the existing owner-article observer gets first refusal, and enforce a second hard block in all GeWe private-message send methods before any network call.

**Tech Stack:** Node.js ESM, built-in `node:assert/strict` tests, GeWe personal-WeChat adapter.

---

### Task 1: Define the official-account boundary

**Files:**
- Create: `src/wechat-official-account-policy.mjs`
- Modify: `src/im-channels.test.mjs`

**Step 1: Write the failing policy tests**

Add assertions that:

```js
assert.equal(isWechatOfficialAccountId('gh_07e3d1422f5e'), true);
assert.equal(isWechatOfficialAccountId('wechat:gh_07e3d1422f5e'), true);
assert.equal(isWechatOfficialAccountId('wxid_friend'), false);
assert.equal(isWechatOfficialAccountPrivateTarget({
  channel: 'wechat', kind: 'user', id: 'gh_07e3d1422f5e',
}), true);
assert.equal(isWechatOfficialAccountPrivateTarget({
  channel: 'wechat', kind: 'group', id: 'gh_07e3d1422f5e@chatroom',
}), false);
```

**Step 2: Run the test to verify it fails**

Run: `node src/im-channels.test.mjs`

Expected: FAIL because `src/wechat-official-account-policy.mjs` does not exist.

**Step 3: Implement the pure policy**

Create bounded normalization and export:

```js
export function isWechatOfficialAccountId(value) {
  const id = String(value || '').replace(/^wechat:(?:user:)?/, '').trim();
  return /^gh_[A-Za-z0-9_-]{3,252}$/.test(id);
}

export function isWechatOfficialAccountPrivateTarget(target) {
  return target?.channel === 'wechat'
    && target?.kind === 'user'
    && isWechatOfficialAccountId(target.id);
}
```

Also export an inbound predicate requiring the WeChat channel, `p2p` chat type, and an official-account sender ID. It may trust either the normalized metadata marker or the sender ID, so stored callbacks remain safe across deployments.

**Step 4: Run the test to verify it passes**

Run: `node src/im-channels.test.mjs`

Expected: `IM_CHANNELS_TEST_OK`.

**Step 5: Commit**

Stage only the new policy and new test hunks, preserving unrelated dirty-worktree changes.

```bash
git commit -m "test: define WeChat official account boundary"
```

### Task 2: Mark callbacks and short-circuit generic inbound replies

**Files:**
- Modify: `src/im-channels.mjs:789-880`
- Modify: `src/im-channels.test.mjs:880-910`
- Modify: `src/index.mjs:2686-2750`

**Step 1: Write the failing callback test**

Extend the existing public-account article callback fixture:

```js
assert.equal(payload.metadata.officialAccountPrivateMessage, true);
```

Add a normal direct-message assertion:

```js
assert.equal(friendPayload.metadata.officialAccountPrivateMessage, undefined);
```

**Step 2: Run the test to verify it fails**

Run: `node src/im-channels.test.mjs`

Expected: FAIL because the marker is absent.

**Step 3: Mark normalized GeWe callbacks**

Import the policy helper into `src/im-channels.mjs` and set:

```js
...(!group && !isSelf && isWechatOfficialAccountId(senderId)
  ? { officialAccountPrivateMessage: true }
  : {}),
```

**Step 4: Add the inbound short circuit**

In `processIncoming`, calculate the sender identity before expensive content work. Preserve the existing order:

```js
if (metadata.channel === 'wechat' && metadata.linkCandidate && wechatOwnerArticleSyndication) {
  const syndication = await wechatOwnerArticleSyndication.observe(...);
  if (syndication.eligible) return;
}

if (isWechatOfficialAccountPrivateInbound({ message, sender, metadata })) {
  audit('wechat_official_account_private_message_ignored', message, senderOpenId, {
    reason: 'official_account_private_reply_disabled',
  });
  return;
}
```

This must execute before relationship-memory capture, attachment resolution, ordinary AI generation, or reply dispatch.

**Step 5: Run focused tests**

Run: `node src/im-channels.test.mjs && node src/wechat-owner-article-syndication.test.mjs`

Expected: both tests pass; the existing syndication assertions prove configured articles remain eligible.

**Step 6: Commit**

Stage only this task's hunks.

```bash
git commit -m "feat: silence WeChat official account private messages"
```

### Task 3: Add an outbound hard stop

**Files:**
- Modify: `src/im-channel-runtime.mjs:690-800`
- Modify: `src/im-channel-runtime.test.mjs`
- Modify: `src/index.mjs:879-930`

**Step 1: Write failing GeWe send tests**

Use a fake `fetchImpl` counter and assert text, image, and file sends all reject:

```js
await assert.rejects(
  channel.send({ channel: 'wechat', kind: 'user', id: 'gh_public' }, '不要发送'),
  error => error.code === 'WECHAT_OFFICIAL_ACCOUNT_PRIVATE_SEND_BLOCKED',
);
assert.equal(fetchCalls, 0);
```

Repeat for `sendImage` and `sendFile`. Also retain a normal friend send assertion to prove no regression.

**Step 2: Run the test to verify it fails**

Run: `node src/im-channel-runtime.test.mjs`

Expected: FAIL because GeWe currently calls the network for the official-account target.

**Step 3: Implement the hard guard**

Add a shared assertion called at the top of `sendNow`, `sendImageNow`, and `sendFileNow`:

```js
function assertWechatPrivateSendAllowed(target) {
  if (!isWechatOfficialAccountPrivateTarget(target)) return;
  const error = new Error('WeChat official account private sends are disabled');
  error.code = 'WECHAT_OFFICIAL_ACCOUNT_PRIVATE_SEND_BLOCKED';
  throw error;
}
```

The assertion must run before rate-limit sleeps, URL parsing, and `request()`.

**Step 4: Add the upper-layer suppression**

At the start of `sendText`, parse the channel target. For an official-account private target, write `wechat_official_account_private_send_suppressed` and return:

```js
{ suppressed: true, reason: 'wechat_official_account_private_send_blocked' }
```

This prevents policy blocks from being retried as transport failures. The GeWe hard guard remains the final defense for image/file and direct adapter calls.

**Step 5: Run focused tests**

Run: `node src/im-channel-runtime.test.mjs && node src/im-channels.test.mjs`

Expected: both tests pass and `fetchCalls` remains zero for every blocked send type.

**Step 6: Commit**

```bash
git commit -m "feat: block outbound WeChat messages to official accounts"
```

### Task 4: Verify behavior and regression safety

**Files:**
- Verify: `src/wechat-official-account-policy.mjs`
- Verify: `src/im-channels.mjs`
- Verify: `src/im-channel-runtime.mjs`
- Verify: `src/index.mjs`

**Step 1: Run syntax checks**

Run:

```bash
node --check src/wechat-official-account-policy.mjs
node --check src/im-channels.mjs
node --check src/im-channel-runtime.mjs
node --check src/index.mjs
```

Expected: exit code 0.

**Step 2: Run the focused policy and channel tests**

Run:

```bash
node src/im-channels.test.mjs
node src/im-channel-runtime.test.mjs
node src/wechat-owner-article-policy.test.mjs
node src/wechat-owner-article-syndication.test.mjs
```

Expected: all report their success markers.

**Step 3: Run the full repository test suite**

Run: `npm test`

Expected: exit code 0. If an unrelated pre-existing failure occurs, record the exact command and failure without modifying unrelated user work.

**Step 4: Review the final diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only intended unstaged user changes remain.

