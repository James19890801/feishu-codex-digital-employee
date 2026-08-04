# Wukong DingTalk and Achong Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run DingTalk permanently through the authenticated Wukong DWS polling transport and present every external reply as Achong's digital human.

**Architecture:** Add transport-aware DingTalk argument builders and a pure normalizer for Wukong `chat message list-all` pages. The main runtime selects either the existing event stream or the new durable polling loop, but local configuration selects only `wukong-polling`; outbound sends use the same selected binary. Persona and privacy copy are changed independently from the James product and licensing identity.

**Tech Stack:** Node.js ES modules, SQLite-backed `AgentState`, DWS CLI 0.2.87 Wukong edition, macOS LaunchAgent, built-in `node:assert` tests.

## Global Constraints

- Keep `James` as the product, dashboard, installer, and licensing product ID.
- External persona must be `阿充的数字人`; do not introduce it as James or address the owner as `詹老师`.
- Local DingTalk transport is exactly `wukong-polling`; do not run the open DWS event consumer as an automatic fallback.
- Wukong commands must not receive unsupported `--profile`, `--direction`, or `--ai-tag=false` flags.
- Advance the polling timestamp only after every `list-all` page in the window succeeds.
- Preserve SQLite message-ID deduplication, outbound echo protection, bounded retries, and explicit send receipts.
- Do not replay pre-migration dead letters automatically.

---

### Task 1: Transport-aware DWS contracts

**Files:**
- Modify: `src/im-channels.test.mjs`
- Modify: `src/im-channels.mjs`

**Interfaces:**
- Produces: `buildDingTalkListAllPollingArgs(start, end, cursor)` returning exact Wukong CLI arguments.
- Produces: `normalizeDingTalkListAllPage(result, options)` returning `{ payloads, hasMore, nextCursor }`.
- Changes: `buildDingTalkSendArgs(target, text, uuid, options)` accepts `transport` and omits unsupported Wukong flags.

- [ ] **Step 1: Write failing helper tests**

Add literal assertions that Wukong polling emits `chat message list-all --start ... --end ... --limit 50 --cursor ... --format json`, that Wukong send omits `--ai-tag=false`, and that the normalizer accepts direct messages, accepts only `@阿充` group messages, marks owner self-chat, ignores outbound group messages, and preserves `openMessageId`.

- [ ] **Step 2: Run the helper test and verify RED**

Run: `node src/im-channels.test.mjs`

Expected: fail because `buildDingTalkListAllPollingArgs` and `normalizeDingTalkListAllPage` are not exported.

- [ ] **Step 3: Implement the pure helpers**

Implement literal argument construction and normalization without I/O. Use `conversationMessagesList`, `singleChat`, `openConversationId`, `senderOpenDingTalkId`, `content`, `createTime`, and `openMessageId`. Attach `metadata.selfChat=true` only for the owner's own single-chat conversation; group messages require `@阿充` or `@阿充James` and a non-owner sender.

- [ ] **Step 4: Run the helper test and verify GREEN**

Run: `node src/im-channels.test.mjs`

Expected: `IM_CHANNELS_TEST_OK`.

- [ ] **Step 5: Commit the transport contracts**

```bash
git add src/im-channels.mjs src/im-channels.test.mjs
git commit -m "feat: add Wukong DingTalk polling contracts"
```

### Task 2: Wukong polling runtime

**Files:**
- Modify: `src/runtime-mode.test.mjs`
- Modify: `src/runtime-mode.mjs`
- Modify: `src/config.mjs`
- Modify: `src/im-channel-runtime.test.mjs`
- Modify: `src/im-channel-runtime.mjs`
- Modify: `src/index.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `src/dashboard-model.mjs`

**Interfaces:**
- Configures: `config.dingtalkTransport` with allowed values `event-stream` and `wukong-polling`.
- Changes: `DingTalkChannel` accepts `transport`; `send()` uses transport-aware arguments.
- Adds: a Wukong polling initializer, one-window fetch with complete pagination, and a supervised polling loop.

- [ ] **Step 1: Write failing transport-selection tests**

Assert validation accepts `wukong-polling`, rejects an unknown value, and `DingTalkChannel` Wukong sends contain neither `--profile` nor `--ai-tag=false`. Assert dashboard state treats a successful Wukong poll timestamp as connected and labels the transport `Wukong DWS polling`.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node src/runtime-mode.test.mjs && node src/im-channel-runtime.test.mjs && node src/dashboard-model.test.mjs`

Expected: fail because the transport option is not implemented.

- [ ] **Step 3: Implement transport selection and polling**

Parse and validate `dingtalkTransport`. In Wukong mode, create the channel but do not start `superviseDingTalkEvents`; initialize a new SQLite cursor namespace, fetch every `list-all` page, enqueue normalized messages, then record `last_dingtalk_wukong_poll_success_at`. Set channel state to authenticated and connected after a complete successful window, and use the existing bounded polling delay on errors.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `node src/runtime-mode.test.mjs && node src/im-channel-runtime.test.mjs && node src/dashboard-model.test.mjs`

Expected: every command exits 0.

- [ ] **Step 5: Commit the runtime**

```bash
git add src/runtime-mode.mjs src/runtime-mode.test.mjs src/config.mjs src/im-channel-runtime.mjs src/im-channel-runtime.test.mjs src/index.mjs src/dashboard-model.mjs src/dashboard-model.test.mjs
git commit -m "feat: run DingTalk through Wukong polling"
```

### Task 3: Achong external identity

**Files:**
- Modify: `src/conversation-etiquette.test.mjs`
- Modify: `src/conversation-etiquette.mjs`
- Modify: `src/privacy-boundary.test.mjs`
- Modify: `src/privacy-boundary.mjs`
- Modify: `PERSONA.md`
- Modify: `src/index.mjs`

**Interfaces:**
- Changes: `buildFirstTakeoverGreeting()` returns the approved Achong introduction.
- Changes: `buildPrivacyBoundary()` and `ownerHandoffReply()` refer to Achong.
- Changes: the runtime prompt calls itself Achong's digital human while retaining James only as a product name outside the persona.

- [ ] **Step 1: Write failing identity behavior tests**

Assert the first greeting contains `我是阿充的数字人` and `阿充现在不在`, and contains neither `詹老师` nor `AI 助理 James`. Assert privacy and handoff responses name Achong and do not name `詹老师`.

- [ ] **Step 2: Run identity tests and verify RED**

Run: `node src/conversation-etiquette.test.mjs && node src/privacy-boundary.test.mjs`

Expected: fail against the old external identity.

- [ ] **Step 3: Implement the approved identity copy**

Replace owner/persona wording in the greeting, Persona, privacy rules, handoff response, and AI runtime behavior prompt. Keep James product and licensing code unchanged.

- [ ] **Step 4: Run identity tests and verify GREEN**

Run: `node src/conversation-etiquette.test.mjs && node src/privacy-boundary.test.mjs`

Expected: both commands exit 0.

- [ ] **Step 5: Commit the identity change**

```bash
git add PERSONA.md src/index.mjs src/conversation-etiquette.mjs src/conversation-etiquette.test.mjs src/privacy-boundary.mjs src/privacy-boundary.test.mjs
git commit -m "feat: identify as Achong digital human"
```

### Task 4: Local migration and live acceptance

**Files:**
- Modify: `config.example.json`
- Modify locally (ignored): `config.local.json`
- Modify: `dashboard/i18n.js`
- Modify: `dashboard/i18n.test.mjs`
- Modify: `dashboard/index.html`
- Modify: `dashboard/visual-contract.test.mjs`

**Interfaces:**
- Configures the executable `/Users/fengzhouchong.fzc/.real/.bin/dws/bin/dws`.
- Configures owner open ID `DpdiSgDXUjiPooA5aPhiibmiSG7nkiS5ENiizHW`.
- Configures `dingtalkTransport: "wukong-polling"`.

- [ ] **Step 1: Add configuration expectations and verify RED**

Extend the configuration/runtime test to require the new transport default and valid enum. Run `node src/runtime-mode.test.mjs` and confirm the old example/config behavior fails the new expectation.

- [ ] **Step 2: Update example and local configuration**

Set the example transport explicitly and update the ignored local configuration with the authenticated Wukong path, owner open ID, and Wukong transport. Do not change licensing product ID.

- [ ] **Step 3: Run the full automated suite**

Run: `npm run check && npm test && npm run test:install-service`

Expected: all commands exit 0 and mechanism acceptance reports all cases passing.

- [ ] **Step 4: Restart and verify the LaunchAgents**

Run the repository service installer, wait for the old process to stop and the new process to become stable, then run `node scripts/health-check.mjs`. Confirm DingTalk reports connected with `Wukong DWS polling` and the logs do not start an event consumer.

- [ ] **Step 5: Execute real end-to-end DingTalk acceptance**

Send a unique self-chat prompt through the authenticated Wukong CLI, wait for the running service to consume it, and read the conversation back. Then send the corrected identity message and read it back. Require `success=true`, a send `openTaskId`, and a conversation `openMessageId` for the exact corrected text.

- [ ] **Step 6: Commit tracked migration files**

```bash
git add config.example.json dashboard src
git commit -m "chore: configure Wukong DingTalk transport"
```
