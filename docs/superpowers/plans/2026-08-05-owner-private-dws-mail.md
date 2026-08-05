# Owner-Private DWS Mail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add owner-private DingTalk enterprise-mail reading and confirmed send/reply/forward capabilities to AIPR0S without any Wukong runtime path.

**Architecture:** Add a narrow `DwsMailClient` at the external process boundary, a deterministic mail-intent/KQL parser, and a `MailWorkflow` that owns authorization, search context, preview/confirmation, idempotent writes, and delivery verification. Wire the workflow into the existing DingTalk event-stream path before generic AI fallback while preserving the existing Owner, pending-action, audit, and mutation-execution mechanisms.

**Tech Stack:** Node.js 24 ESM, `node:assert/strict`, `node:sqlite`, existing `runBufferedProcess`, standalone DWS CLI v1.0.56, existing `AgentState`, `PendingActionStore`, and `executeMutationOnce`.

## Global Constraints

- Use only the configured absolute standalone DWS binary, Profile, and `DWS_CHANNEL`.
- `dingtalkTransport` must equal `event-stream`; reject Wukong, `.real/.bin/dws`, and `wukong-polling`.
- Mail reads and even mailbox existence are available only to the verified Owner in a DingTalk P2P self-chat.
- Send, reply, reply-all, and forward are L2 actions with full preview and same-chat Owner confirmation within 15 minutes.
- Never guess mailbox or recipient addresses; ambiguous matches must stop.
- Default search limit is 10 and the hard maximum is 30.
- Do not persist mail bodies in audit, logs, knowledge sync, or long-lived search state.
- Never automatically retry a mail write after an ambiguous outcome.
- Automatic tests must not send a real email.

---

### Task 1: Standalone DWS Mail Client

**Files:**
- Create: `src/dws-mail-client.mjs`
- Create: `src/dws-mail-client.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `isSupportedDwsExecutable(value)` from `src/conversation-context-client.mjs`, `runBufferedProcess(command, args, options)` from `src/process-runner.mjs`.
- Produces: `DwsMailClient`, `DwsMailError`, `normalizeDeliveryStatus(root)`, and methods `listMailboxes()`, `searchMessages(input)`, `getMessage(input)`, `searchMailUsers(input)`, `searchContacts(input)`, `searchPeople(input)`, `getContacts(input)`, `sendMessage(input)`, `replyMessage(input)`, `replyAllMessage(input)`, `forwardMessage(input)`, `verifyDelivery(input)`.

- [ ] **Step 1: Write the failing client tests**

Create a fake runner that records calls and returns complete DWS-shaped JSON. Assert literal argument arrays, structured normalization, redacted audits, invalid path/transport rejection, malformed JSON failure, provider failure, and both top-level and nested delivery statuses.

```js
const client = new DwsMailClient({
  bin: '/opt/homebrew/bin/dws',
  profile: 'corp:user',
  transport: 'event-stream',
  env: { DWS_CHANNEL: 'channel-secret' },
  cwd: '/srv/aipro',
  runner,
  audit: (event, detail) => audits.push({ event, detail }),
});
const result = await client.searchMessages({
  email: 'owner@example.com', query: 'folderId:2 AND isRead:false', limit: 10,
});
assert.deepEqual(calls[0].args, [
  '--profile', 'corp:user', 'mail', 'message', 'search',
  '--email', 'owner@example.com', '--query', 'folderId:2 AND isRead:false',
  '--limit', '10', '--format', 'json',
]);
assert.equal(result.messages[0].id, 'message-1');
assert.doesNotMatch(JSON.stringify(audits), /owner@example\.com|周报|message-1/);
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `node src/dws-mail-client.test.mjs`

Expected: fail because `src/dws-mail-client.mjs` does not exist.

- [ ] **Step 3: Implement the minimal client**

Use one private `_run(action, args, normalize)` method. It must validate the binary and transport before invoking the runner, prefix `--profile`, suffix `--format json`, parse JSON, reject `success:false` or `error`, and audit only `{ action, durationMs, count, status, errorCategory }`.

```js
export class DwsMailClient {
  async searchMessages({ email, query, limit = 10, cursor = '' }) {
    return this._run('mail_search', [
      'mail', 'message', 'search', '--email', required(email, 'email'),
      '--query', required(query, 'query'), '--limit', String(boundedLimit(limit)),
      ...(cursor ? ['--cursor', cursor] : []),
    ], normalizeSearch);
  }
}
```

`normalizeDeliveryStatus` must read `root.result.message.sendStatus`, `root.message.sendStatus`, `root.result.sendStatus`, or `root.sendStatus` and return only `none|posting|partial_success|success|failed|unknown`.

- [ ] **Step 4: Run client tests and verify GREEN**

Run: `node src/dws-mail-client.test.mjs`

Expected: `DWS_MAIL_CLIENT_TEST_OK`.

- [ ] **Step 5: Add the focused test script and commit**

Add `"test:mail": "node src/dws-mail-client.test.mjs"` to `package.json`, include it in `pretest`, then run `npm run test:mail`.

Commit: `feat: add standalone DWS mail client`

---

### Task 2: Deterministic Mail Intent and KQL

**Files:**
- Create: `src/mail-intent.mjs`
- Create: `src/mail-intent.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `parseMailIntent(text, { now })`, `buildMailKql(filters)`, `escapeKqlValue(value)`, `parseMailWriteDraft(text)`, `isMailConfirmation(text)`, `isMailCancellation(text)`.
- `parseMailIntent` returns `{ kind, filters, limit, selection, draft }` where `kind` is `search|open|send|reply|reply_all|forward|null`.

- [ ] **Step 1: Write failing parser tests**

Cover exact literals for recent, today, unread, inbox, sent, sender, subject, body keyword, attachment, search limit clamping, unsafe control characters, open-by-number, send/reply/forward, confirmation, and cancellation.

```js
assert.deepEqual(
  parseMailIntent('看看今天未读的收件箱邮件', { now: new Date('2026-08-05T03:00:00Z') }),
  {
    kind: 'search', selection: null, draft: null, limit: 10,
    filters: { folderId: 2, isRead: false, after: '2026-08-04T16:00:00.000Z' },
  },
);
assert.equal(
  buildMailKql({ folderId: 2, isRead: false, subject: '项目 进展' }),
  'folderId:2 AND isRead:false AND subject:"项目 进展"',
);
assert.throws(() => escapeKqlValue('x\nOR folderId:6'), /control/i);
```

- [ ] **Step 2: Run parser tests and verify RED**

Run: `node src/mail-intent.test.mjs`

Expected: fail because `src/mail-intent.mjs` does not exist.

- [ ] **Step 3: Implement minimal deterministic parsing**

Generate all KQL operators in code. Quote values containing whitespace or punctuation, escape `\` and `"`, reject control characters, and never accept raw `AND|OR|NOT` from the user. Interpret calendar words in `Asia/Shanghai` and serialize full ISO timestamps.

Write parsing must require explicit separators:

```text
给 张三 发邮件，主题：周报，正文：本周完成 A
回复第 2 封，正文：已收到
转发第 1 封给 李四，附言：请查看
```

Missing subject/body/recipient stays in the draft as an empty field so the workflow can ask one deterministic follow-up.

- [ ] **Step 4: Run parser tests and verify GREEN**

Run: `node src/mail-intent.test.mjs`

Expected: `MAIL_INTENT_TEST_OK`.

- [ ] **Step 5: Add parser to focused tests and commit**

Update `test:mail` to run both mail test files. Run `npm run test:mail`.

Commit: `feat: parse owner mail intents safely`

---

### Task 3: Owner-Private Mail Workflow

**Files:**
- Create: `src/mail-workflow.mjs`
- Create: `src/mail-workflow.test.mjs`
- Modify: `src/pending-actions.mjs`
- Modify: `src/pending-actions.test.mjs`
- Modify: `src/mutation-execution.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `DwsMailClient`, mail intent helpers, `PendingActionStore`, `executeMutationOnce`, and `canAccessOwnerPrivateData`.
- Produces: `MailWorkflow.handle({ chatId, chatType, senderId, messageId, text, metadata }) -> Promise<{ handled, text, audit? }>`.
- Pending kind: `mail_write`; search context namespace: `mail_search_context` with 15-minute expiry.

- [ ] **Step 1: Write failing TTL and workflow authorization tests**

Add per-kind TTL support to the wished-for pending API:

```js
const pending = new PendingActionStore(state, {
  ttlMs: 86_400_000,
  kindTtlMs: { mail_write: 900_000 },
});
pending.set('mail_write', 'dingtalk:user:owner', 'dingtalk:owner', draft, 1_000);
assert.ok(pending.get('mail_write', 'dingtalk:user:owner', 'dingtalk:owner', 900_999));
assert.equal(pending.get('mail_write', 'dingtalk:user:owner', 'dingtalk:owner', 901_001), null);
```

Workflow tests must prove non-Owner, group, non-self-chat, missing channel, rejected DWS path, and missing client all return a privacy-safe response without calling the client.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `node src/pending-actions.test.mjs && node src/mail-workflow.test.mjs`

Expected: fail because `mail_write` and `MailWorkflow` are absent.

- [ ] **Step 3: Implement pending TTL and read workflow**

Authorization must require all of:

```js
const authorized = chatType === 'p2p'
  && metadata?.channel === 'dingtalk'
  && metadata?.selfChat === true
  && ownerIds.includes(senderId);
```

On search, choose exactly one enterprise mailbox, build KQL, call `searchMessages`, store only `{ expiresAt, email, items:[{ id }] }`, and return a numbered summary. On `open`, use only the stored same-chat context and call `getMessage`.

- [ ] **Step 4: Write failing recipient and write-state tests**

Tests must cover unique direct email, name resolution, inconsistent/multiple candidates, missing fields, preview, same-chat confirmation, modified-draft invalidation, cancellation, expiry, send idempotency, reply/reply-all/forward, delivery success/partial/failed/posting timeout, and ambiguous mutation without replay.

The fake client returns complete method values; assertions target workflow output and persisted state rather than fake call counters except where proving zero or one external write.

- [ ] **Step 5: Run write tests and verify RED**

Run: `node src/mail-workflow.test.mjs`

Expected: fail on preview/confirmation and delivery behavior.

- [ ] **Step 6: Implement recipient resolution and confirmed writes**

Collect recipient candidates from all available routes, normalize lowercase addresses, and proceed only when the union contains exactly one email. Store `{ operation, from, to, cc, subject, content, sourceMessageId, sourceMailId, draftHash }` in `mail_write`.

Confirmation must call:

```js
await executeMutationOnce({
  state,
  executionKey: `mail:${pending.sourceMessageId}:${pending.draftHash}`,
  kind: `dws_mail_${pending.operation}`,
  operation: () => clientMethod(pending),
});
```

If an `internetMessageId` is available, call `verifyDelivery` up to 4 times with bounded delays. Do not call the write method a second time. Return privacy-safe delivery text for every terminal and ambiguous state.

- [ ] **Step 7: Run focused workflow tests and verify GREEN**

Run: `npm run test:mail && node src/pending-actions.test.mjs && node src/mutation-execution.test.mjs`

Expected: all focused tests pass.

- [ ] **Step 8: Commit workflow**

Commit: `feat: add owner-private mail workflow`

---

### Task 4: Runtime Wiring, Policy, Help, and Mechanism Contracts

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/bible.mjs`
- Modify: `src/bible.test.mjs`
- Modify: `src/operator-commands.mjs`
- Modify: `src/operator-commands.test.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Instantiate `DWS_MAIL_CLIENT` from the same `config.dingtalkBin`, `config.dingtalkProfile`, `config.dingtalkTransport`, `dingtalkProcessEnv()`, `WORKDIR`, `runBufferedProcess`, and redacted state audit used by conversation history.
- Instantiate `MAIL_WORKFLOW` with Owner identities, state, pending store, client, and a delay function.

- [ ] **Step 1: Write failing policy and help tests**

Add literal behavior assertions:

```js
assert.equal(decideWorkflow('看看今天未读邮件').intent, 'mail');
assert.equal(decideWorkflow('给张三发邮件，主题：周报，正文：完成').action, 'preview_confirm');
assert.match(buildHelpReply({ dashboardUrl }), /本人私聊.*邮件/);
```

Add mechanism contracts that non-Owner/group requests are refused without mailbox calls and a confirmed Owner self-chat mail write executes once.

- [ ] **Step 2: Run policy tests and verify RED**

Run: `node src/bible.test.mjs && node src/operator-commands.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: mail policy/help assertions fail.

- [ ] **Step 3: Implement runtime wiring**

Add mail imports and initialize the client/workflow next to `CONVERSATION_CONTEXT_CLIENT`. In the main message handler, call `MAIL_WORKFLOW.handle(...)` after operator commands and before file/knowledge/A1/general-AI routing. When handled, remember only the user request and workflow response; do not store raw fetched body a second time.

Update `classifyIntent` so mail read requests are `intent=mail, level=L0, action=execute`, while `发邮件|回复邮件|回复全部|转发邮件` resolve to `level=L2, action=preview_confirm` before general L2 patterns.

- [ ] **Step 4: Run policy and mechanism tests and verify GREEN**

Run: `node src/bible.test.mjs && node src/operator-commands.test.mjs && node src/mechanism-acceptance.test.mjs`

Expected: all tests pass and mechanism total increases with new mail contracts.

- [ ] **Step 5: Update static checks and commit**

Add `node --check` entries for the three new production modules to `precheck` and `check`.

Run: `npm run precheck && npm run check && npm run test:mail`

Commit: `feat: wire mail capability into AIPR0S`

---

### Task 5: Full Verification, Live Read Acceptance, and Deployment

**Files:**
- Create: `docs/testing/2026-08-05-owner-private-dws-mail.md`
- Modify only if a verification test exposes a defect: the tested source and its existing/new regression test.

**Interfaces:**
- Live acceptance uses `config.local.json` internally but outputs no Profile, Channel, mailbox address, subject, sender, body, message ID, or internet message ID.

- [ ] **Step 1: Run focused and complete automated verification**

Run:

```bash
npm run test:mail
npm run precheck
npm run check
npm test
```

Expected: all commands exit 0; mechanism acceptance reports zero failures.

- [ ] **Step 2: Run privacy and Wukong scans**

Run `git diff --check`, inspect all new audit payloads, and search changed files for `wukong-polling`, `.real/.bin/dws`, raw local `DWS_CHANNEL` values, and real mailbox addresses. Expected: only explicit rejection assertions/documentation mention forbidden Wukong values; no secrets or real addresses appear.

- [ ] **Step 3: Run a real owner mailbox read acceptance**

Using the configured binary/Profile/Channel, call `mail mailbox list` and a bounded search such as `folderId:2 AND date>2026-08-05T00:00:00Z` with `--limit 1 --format json`. Parse in-process and output only `{ success, accountCount, enterpriseMailbox, searchSucceeded, resultCount, responseShapeValid }`.

Expected: mailbox and search calls succeed through `/Users/fengzhouchong.fzc/.npm-global/bin/dws`; no mail content is printed.

- [ ] **Step 4: Install and verify the service**

Run `./scripts/install-service.sh`, then `npm run health` and `npm run event-health`. Expected: `healthy=true`, DingTalk enabled/authenticated/connected, event-stream ready, and no Wukong process/path.

- [ ] **Step 5: Write the test evidence report**

Record commit IDs, exact commands, exit codes, mechanism count, sanitized live-read result, health result, and the explicit statement that no real email was sent automatically.

- [ ] **Step 6: Commit verification evidence**

Commit: `test: verify owner-private DWS mail capability`
