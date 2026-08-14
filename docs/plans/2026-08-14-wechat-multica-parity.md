# WeChat Multica Parity Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make personal WeChat use the same Multica query, mutation, execution, progress, synchronization, and artifact-delivery lifecycle as Feishu and DingTalk without replaying historical messages.

**Architecture:** Keep all Multica planning and lifecycle components channel-neutral. Add a narrowly authenticated WeChat self-chat identity for `filehelper`, a GeWe file-send operation, and a short-lived artifact route on the existing public webhook server. Reuse the current origin binding, delivery contract, synchronizer, and outbound echo guard.

**Tech Stack:** Node.js ESM, GeWe REST/Webhook, local HTTP server, SQLite-backed AgentState, Multica CLI client, node:test-style assertion scripts.

---

### Task 1: Authenticate WeChat Owner self-chat

**Files:**
- Modify: `src/im-channels.test.mjs`
- Modify: `src/im-channels.mjs`
- Modify: `src/multica-access.test.mjs`
- Modify: `src/multica-access.mjs`
- Modify: `src/index.mjs`

**Step 1: Write the failing normalization tests**

Add a GeWe event sent by the logged-in wxid to `filehelper` and assert:

```js
assert.equal(payload.message.chat_id, 'wechat:user:filehelper');
assert.equal(payload.message.chat_type, 'p2p');
assert.equal(payload.metadata.selfChat, true);
assert.equal(payload.metadata.ownerControlAuthenticated, true);
```

Also assert that an Owner message sent to a normal contact has no `selfChat` flag.

**Step 2: Run the normalization test and verify RED**

Run: `node src/im-channels.test.mjs`

Expected: FAIL because GeWe filehelper events are not marked as self-chat.

**Step 3: Implement minimal normalization**

In `normalizeGeWeWebhook`, derive:

```js
const selfChat = isSelf && !group && toUser === 'filehelper';
```

Add `selfChat: true` only for that case. Keep `ownerControlAuthenticated` tied to the authenticated GeWe self-origin event.

**Step 4: Write and run the failing authorization tests**

Test that only this context authorizes a write:

```js
{
  senderId: 'wechat:wxid_owner',
  chatType: 'p2p',
  metadata: {
    channel: 'wechat', selfChat: true,
    ownerControlAuthenticated: true,
  },
}
```

Reject WeChat groups, contacts, missing authentication, and authenticated messages without self-chat. Run `node src/multica-access.test.mjs` and expect FAIL.

**Step 5: Implement authorization and self-chat processing**

Allow `isVerifiedMulticaOwner` to accept WeChat only when `ownerControlAuthenticated === true`. In `processIncoming`, do not classify the verified WeChat filehelper self-chat as ordinary silent Owner activity; let it continue into the existing Multica router.

**Step 6: Verify GREEN**

Run: `node src/im-channels.test.mjs && node src/multica-access.test.mjs`

Expected: PASS.

### Task 2: Add GeWe file sending

**Files:**
- Modify: `src/im-channel-runtime.test.mjs`
- Modify: `src/im-channel-runtime.mjs`

**Step 1: Write the failing test**

Call:

```js
await channel.sendFile(
  { channel: 'wechat', kind: 'group', id: 'room@chatroom' },
  { fileUrl: 'https://callback.example/artifact/token', fileName: 'report.pdf' },
);
```

Assert a POST to `/gewe/v2/api/message/postFile` with `appId`, `toWxid`, `fileUrl`, and `fileName`. Assert HTTPS-only file URLs and normal send serialization.

**Step 2: Run and verify RED**

Run: `node src/im-channel-runtime.test.mjs`

Expected: FAIL because `sendFile` does not exist.

**Step 3: Implement minimal `sendFile`**

Add a serialized GeWe operation that validates the target and HTTPS URL, then calls the documented `postFile` endpoint. Reuse status reporting and rate spacing from text sends.

**Step 4: Verify GREEN**

Run: `node src/im-channel-runtime.test.mjs`

Expected: PASS.

### Task 3: Serve short-lived artifact leases

**Files:**
- Modify: `src/gewe-webhook.test.mjs`
- Modify: `src/im-channel-runtime.mjs`

**Step 1: Write failing server tests**

Start `GeWeWebhookServer` on an ephemeral port, register a temporary file, and assert:

- the returned route contains no local path;
- `GET` returns the exact bytes, `Content-Length`, safe attachment disposition, and `Cache-Control: no-store`;
- an invalid or expired token returns 404;
- webhook POST behavior remains unchanged.

**Step 2: Run and verify RED**

Run: `node src/gewe-webhook.test.mjs`

Expected: FAIL because artifact leases are unsupported.

**Step 3: Implement the lease registry and GET handler**

Use a high-entropy random token stored in memory with `{ path, fileName, expiresAt }`. Route it below the callback-secret namespace, stream only explicitly registered regular files, prune expired entries, and never derive file paths from URL input.

**Step 4: Verify GREEN**

Run: `node src/gewe-webhook.test.mjs`

Expected: PASS.

### Task 4: Connect Multica artifact delivery to WeChat

**Files:**
- Modify: `src/channel-artifact-delivery.test.mjs`
- Modify: `src/channel-artifact-delivery.mjs`
- Modify: `src/multica-artifact-delivery.test.mjs`
- Modify: `src/index.mjs`

**Step 1: Write failing delivery-plan and integration tests**

Assert that a WeChat delivery plan is accepted without shell arguments and retains channel, caption, and idempotency metadata. Assert that a WeChat Multica contract invokes the injected WeChat file-delivery function and records `delivered` only after success.

**Step 2: Run and verify RED**

Run: `node src/channel-artifact-delivery.test.mjs && node src/multica-artifact-delivery.test.mjs`

Expected: FAIL because WeChat artifact delivery is not implemented.

**Step 3: Implement the WeChat branch**

In `deliverMulticaArtifact`:

1. Keep existing workspace-path validation.
2. Register a short-lived route with `GeWeWebhookServer`.
3. Combine it with `gewePublicCallbackBaseUrl`.
4. Call `geWeChannel.sendFile` for the parsed original target.
5. Send the existing caption only after successful file submission.

Update channel-visible wording so WeChat is named correctly.

**Step 4: Verify GREEN**

Run: `node src/channel-artifact-delivery.test.mjs && node src/multica-artifact-delivery.test.mjs`

Expected: PASS.

### Task 5: Cross-channel acceptance and deployment

**Files:**
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Add the failing acceptance contract**

Assert that a WeChat origin remains bound to WeChat through Multica synchronization and that no WeChat mutation can originate from a group or ordinary contact chat.

**Step 2: Run and verify RED, then implement only missing wiring**

Run: `node src/mechanism-acceptance.test.mjs`

Expected before final wiring: FAIL. Add only the missing source-channel or recipient wiring, then rerun for PASS.

**Step 3: Run the full relevant regression suite**

Run:

```bash
node src/im-channels.test.mjs
node src/im-channel-runtime.test.mjs
node src/gewe-webhook.test.mjs
node src/multica-access.test.mjs
node src/multica-capability.test.mjs
node src/multica-work-lifecycle.test.mjs
node src/multica-artifact-delivery.test.mjs
node src/multica-sync.test.mjs
node src/mechanism-acceptance.test.mjs
npm test
```

Expected: all PASS.

**Step 4: Verify no historical replay and restart**

Read `inbound_message` counts. Require zero `queued`, `retry`, or `processing` rows older than deployment time. Restart `com.local.feishu-codex-digital-employee`, verify the new PID and GeWe/Multica health, and do not requeue dead or completed records.

**Step 5: Commit implementation**

Stage only files touched by this feature and commit with a focused message.
