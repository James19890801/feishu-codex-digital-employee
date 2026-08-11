# DingTalk Cross-Organization Auto-Authorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically request all-target-organization DingTalk chat data access through the configured DWS Channel when live history returns `CrossOrgPermissionDenied`, then retry once and continue the grounded reply.

**Architecture:** Extend the existing `ConversationContextClient` boundary because it owns both the DWS subprocess and provider-response validation. Detect only the exact cross-organization denial, share one in-flight grant per client, validate grant JSON, retry the original history call once, and leave all other errors fail-closed.

**Tech Stack:** Node.js ESM, injected subprocess runner, DWS CLI v1.0.56, `node:assert/strict` tests.

## Global Constraints

- Use the existing absolute DWS binary, configured profile, `event-stream` transport, and command-scoped `DWS_CHANNEL` environment without substitution.
- Grant `chat.data:cross-org` for all target organizations with `grant-type=timed` and `ttl=24h`.
- Trigger only on the exact `CrossOrgPermissionDenied` provider code or marker.
- Retry history exactly once after a successful grant; never add an authorization loop or local-history fallback.
- Keep audit payloads metadata-only and never include message, conversation, profile, Channel, organization, credential, or raw provider content.
- Preserve all unrelated committed and uncommitted workspace changes.

---

### Task 1: Add cross-organization authorization and one-shot history retry

**Files:**
- Modify: `src/conversation-context-client.mjs`
- Test: `src/conversation-context-client.test.mjs`

**Interfaces:**
- Consumes: the existing `ConversationContextClient` constructor fields and injected `runner(bin, args, options)`.
- Produces: unchanged `fetch(context) -> Promise<NormalizedConversationHistory>` behavior, with internal automatic authorization for exact cross-organization denials.

- [ ] **Step 1: Write failing behavioral tests**

Add literal runner fixtures that exercise the real client and prove these observable call sequences:

```js
assert.deepEqual(calls.map(call => call.args.slice(0, 4)), [
  ['chat', 'message', 'list', '--open-dingtalk-id'],
  ['chat', 'data-auth', 'cross-org', '--all'],
  ['chat', 'message', 'list', '--open-dingtalk-id'],
]);
assert.deepEqual(calls[1].args, [
  'chat', 'data-auth', 'cross-org', '--all',
  '--grant-type', 'timed', '--ttl', '24h',
  '--format', 'json', '--profile', 'corp:user', '-y',
]);
assert.equal(result.latestCounterpartyMessage.content, '跨组织问题');
```

Use a complete provider-denial fixture with `success: false`, `error.code: 'CrossOrgPermissionDenied'`, and an error message. The first history call returns the denial, the grant returns `{ success: true }`, and the retry returns a complete message-list response. Assert every call receives the original environment object containing the test Channel.

Add separate tests proving:

- `auth expired` rejects after one history call and makes no grant call;
- `{ success: false, error: { code: 'GrantDenied' } }` from the grant rejects without a second history call;
- two concurrent `fetch()` calls that both receive `CrossOrgPermissionDenied` cause exactly one grant call and each receive one successful history retry.

- [ ] **Step 2: Run RED and confirm the missing behavior**

Run:

```bash
node src/conversation-context-client.test.mjs
```

Expected: FAIL because the client throws immediately after the first `CrossOrgPermissionDenied` response and never emits the grant call.

- [ ] **Step 3: Implement the minimum authorization path**

In `src/conversation-context-client.mjs`:

- add a private in-flight grant promise on `ConversationContextClient`;
- isolate one DWS invocation helper that preserves `bin`, `cwd`, `env`, timeout, and output bounds;
- identify `CrossOrgPermissionDenied` from parsed provider error code/marker only;
- build the exact all-organization timed grant arguments from the configured profile;
- validate grant JSON and provider success;
- audit requested, granted, and failed outcomes with duration/category only;
- retry the original history request once after the shared grant succeeds;
- preserve all current normalization and fail-closed errors for other cases.

- [ ] **Step 4: Run GREEN and targeted regressions**

Run:

```bash
node src/conversation-context-client.test.mjs
node src/reply-context.test.mjs
node src/mechanism-acceptance.test.mjs
```

Expected: all commands exit 0 and the conversation-context client prints `CONVERSATION_CONTEXT_CLIENT_TEST_OK`.

- [ ] **Step 5: Commit the implementation**

```bash
git add src/conversation-context-client.mjs src/conversation-context-client.test.mjs
git commit -m "fix: authorize cross-org DingTalk history"
```

### Task 2: Verify, activate, and publish to Codeup

**Files:**
- Modify only if required by an exact acceptance-count assertion: `docs/testing/MECHANISM_ACCEPTANCE.md`, `src/mechanism-acceptance.test.mjs`, `package.json`

**Interfaces:**
- Consumes: Task 1 committed client behavior and the existing runtime configuration.
- Produces: tested local implementation, live authorization/history evidence, healthy restarted service, and a verified Codeup branch SHA.

- [ ] **Step 1: Run full repository verification**

Run:

```bash
npm test
npm run check
git diff --check
```

Expected: every command exits 0 with no test failures or whitespace errors. Report unrelated pre-existing warnings separately.

- [ ] **Step 2: Exercise the authorized DWS business path**

Using the configured binary, profile, and command-scoped `DWS_CHANNEL`, execute:

```text
chat data-auth cross-org --all --grant-type timed --ttl 24h --format json --profile "$CONFIGURED_DINGTALK_PROFILE" -y
```

Then rerun one known cross-organization `chat message list` request through the same context and confirm the response contains a message list. Do not print profile, Channel, conversation IDs, message bodies, credentials, or raw provider payloads in the handoff.

- [ ] **Step 3: Restart and verify runtime state**

Run the existing service installer/restart path, wait for readiness, then run:

```bash
npm run health
```

Confirm `healthy=true` and DingTalk `authenticated=true`, `connected=true`. Query audit metadata to confirm the authorization/read path without exposing conversation contents.

- [ ] **Step 4: Push only to Codeup and read back**

Fetch Codeup, confirm the target branch is a fast-forward from its remote tracking branch, then push the current implementation branch only to the matching Codeup branch. Do not push GitHub and do not force-push.

Read back the remote SHA with `git ls-remote codeup refs/heads/agent/aipro-commercial-platform-upgrade` and compare it to the pushed local commit.

- [ ] **Step 5: Final verification record**

Report separately:

- code implemented and committed;
- automated targeted/full test results;
- live grant/history readback result;
- runtime restart/health result;
- Codeup branch and exact remote SHA;
- any live cross-organization reply not exercised end-to-end.
