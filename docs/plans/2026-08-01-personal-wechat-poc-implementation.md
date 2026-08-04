# James Personal WeChat POC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a fail-closed, separately supervised macOS personal-WeChat text auto-reply POC with a dashboard master switch, while leaving the existing Feishu and DingTalk execution paths unchanged.

**Architecture:** A new james-wechat-poc process uses an abstract UI adapter, a channel-local SQLite state store, and a dedicated AI runtime session. The dashboard controls a versioned atomic local contract; worker startup always disables auto-reply. The live adapter uses the official logged-in WeChat macOS UI through Accessibility/JXA and refuses to send if any target invariant is ambiguous.

**Tech Stack:** Node.js 22 ESM, node:sqlite, macOS JXA through /usr/bin/osascript, existing AiRuntimeClient, local HTML/CSS/JavaScript dashboard, LaunchAgent, Node assert tests.

---

Implementation rules:

- Use @test-driven-development for every behavior change.
- Use @computer-use only for final controlled UI permission and live-chat validation.
- Use @verification-before-completion before reporting success.
- Never start, stop, reconfigure, or reuse the Feishu or DingTalk service from a WeChat POC test.
- Do not touch the existing wechat-acp daemon or its stored token.
- Do not implement private-protocol login, database scraping, client injection, or blind coordinate clicking.

### Task 1: Versioned fail-closed control contract

**Files:**
- Create: src/wechat-poc/control-store.mjs
- Create: src/wechat-poc/control-store.test.mjs
- Modify: package.json

**Step 1: Write the failing test**

Create a temporary directory. Assert missing or malformed state reads as:

    {
      version: 1,
      enabled: false,
      generation: 0,
      boundaryAt: "",
      updatedAt: "",
      reason: "not_initialized"
    }

Assert enabling advances generation and sets boundaryAt to now. Assert failClosed("worker_start") disables and advances generation again. Assert atomic writes use a temporary file and final mode 0600.

**Step 2: Run test to verify it fails**

Run: node src/wechat-poc/control-store.test.mjs

Expected: FAIL with ERR_MODULE_NOT_FOUND.

**Step 3: Write minimal implementation**

Implement WeChatPocControlStore with read(), setEnabled(), and failClosed(). Accept only version 1, a boolean enabled field, and a non-negative integer generation. Invalid input returns a disabled state.

**Step 4: Run tests and commit**

Run:

    node src/wechat-poc/control-store.test.mjs
    npm test

Expected: WECHAT_POC_CONTROL_STORE_TEST_OK and the existing suite remains green.

Commit:

    git add package.json src/wechat-poc/control-store.mjs src/wechat-poc/control-store.test.mjs
    git commit -m "feat(wechat-poc): add fail-closed control store"

### Task 2: Message policy and isolated state

**Files:**
- Create: src/wechat-poc/message-policy.mjs
- Create: src/wechat-poc/message-policy.test.mjs
- Create: src/wechat-poc/state.mjs
- Create: src/wechat-poc/state.test.mjs
- Modify: package.json

**Step 1: Write failing policy tests**

Assert:

- Incoming direct text is accepted.
- Incoming group text is accepted only when mentionedSelf is true.
- Outgoing/self messages are rejected.
- Blank text, system notices, recalls, red packets, transfers, and non-text content are rejected.
- Deterministic IDs do not contain raw contact names or message text.

Example:

    const result = normalizeObservedMessage({
      conversationTitle: "受控测试联系人",
      conversationKind: "direct",
      senderName: "受控测试联系人",
      direction: "incoming",
      contentType: "text",
      text: "在吗？",
      observedAt: "2026-08-01T03:00:00.000Z"
    });
    assert.equal(result.accepted, true);

**Step 2: Run test and observe failure**

Run: node src/wechat-poc/message-policy.test.mjs

Expected: missing module/export failure.

**Step 3: Implement policy**

Export normalizeObservedMessage(), messageFingerprint(), and wechatChatId(). Use SHA-256 for local identity and idempotency keys. Keep raw names and text out of IDs.

**Step 4: Write failing state tests**

Verify a separate SQLite database supports:

- recordObservation() with insert-or-ignore deduplication
- wasObserved()
- bounded remember() and history()
- audit()
- queue states pending, processing, completed, cancelled, failed, uncertain
- cancelBeforeGeneration()
- statusCounts()

**Step 5: Implement state, run tests, and commit**

Run:

    node src/wechat-poc/message-policy.test.mjs
    node src/wechat-poc/state.test.mjs
    npm test

Commit:

    git add package.json src/wechat-poc/message-policy.mjs src/wechat-poc/message-policy.test.mjs src/wechat-poc/state.mjs src/wechat-poc/state.test.mjs
    git commit -m "feat(wechat-poc): add message policy and isolated state"

### Task 3: Guarded bridge core with switch epochs

**Files:**
- Create: src/wechat-poc/bridge-core.mjs
- Create: src/wechat-poc/bridge-core.test.mjs
- Modify: package.json

**Step 1: Write failing tests with fake UI and responder**

Cover:

- Disabled switch means zero replies.
- Direct text replies exactly once.
- Group without mention is ignored.
- Group mention replies exactly once.
- Duplicate scan is ignored.
- Per-conversation work is serialized.
- Generation change before sending cancels the reply.
- Target mismatch aborts.
- Uncertain send is never automatically retried.
- Worker startup calls failClosed("worker_start").
- Locked screen, missing permission, and logout disable the POC.
- Queue cap prevents unbounded work.

Core test shape:

    const bridge = new WeChatPocBridge({ controlStore, state, ui, responder });
    await bridge.initialize();
    await controlStore.setEnabled(true);
    ui.observations.push(directMessage);
    await bridge.tick();
    assert.equal(ui.sent.length, 1);

**Step 2: Run test and verify failure**

Run: node src/wechat-poc/bridge-core.test.mjs

Expected: missing bridge module.

**Step 3: Implement minimal bridge**

Implement initialize(), tick(), process(), assertSendAllowed(), and stop(). Re-check generation and target before focus, before insertion, and immediately before send.

**Step 4: Run and commit**

Run:

    node src/wechat-poc/bridge-core.test.mjs
    npm test

Commit:

    git add package.json src/wechat-poc/bridge-core.mjs src/wechat-poc/bridge-core.test.mjs
    git commit -m "feat(wechat-poc): add guarded bridge core"

### Task 4: Dedicated AI responder and memory

**Files:**
- Create: src/wechat-poc/responder.mjs
- Create: src/wechat-poc/responder.test.mjs
- Modify: package.json

**Step 1: Write failing responder tests**

Inject a fake AiRuntimeClient. Assert the prompt includes PERSONA.md, BIBLE.md, WeChat-local conversation history, direct/group context, and the current text. Assert output is capped at 3,800 characters. Assert no Feishu or DingTalk sender is imported or called.

**Step 2: Run test and observe failure**

Run: node src/wechat-poc/responder.test.mjs

Expected: missing responder.

**Step 3: Implement responder**

Reuse discoverAiRuntimes(), selectAiRuntime(), and AiRuntimeClient. Use data/wechat-poc/codex-runtime and the POC state database. Do not enable files, images, mutations, broadcasts, or business-system writes in phase one.

**Step 4: Run and commit**

Run:

    node src/wechat-poc/responder.test.mjs
    npm test

Commit:

    git add package.json src/wechat-poc/responder.mjs src/wechat-poc/responder.test.mjs
    git commit -m "feat(wechat-poc): add dedicated AI responder"

### Task 5: macOS Accessibility adapter

**Files:**
- Create: src/wechat-poc/macos-ui-adapter.mjs
- Create: src/wechat-poc/macos-ui-adapter.test.mjs
- Create: scripts/wechat-poc-ui.jxa
- Modify: package.json

**Step 1: Write failing adapter tests**

Use a fake process runner. Verify calls use:

    /usr/bin/osascript -l JavaScript scripts/wechat-poc-ui.jxa ACTION BASE64_JSON

Test structured failures for invalid JSON, permission missing, locked screen, client not running, selector changed, duplicate conversation titles, missing input, and target mismatch. Assert send requires a fresh target proof and never accepts screen coordinates.

**Step 2: Run test and observe failure**

Run: node src/wechat-poc/macos-ui-adapter.test.mjs

Expected: missing adapter.

**Step 3: Implement Node wrapper**

Expose probe(), scan(), resolveTarget(), insertText(), send(), and verifySent(). Bound subprocess duration and output. Validate every returned JSON object.

**Step 4: Implement fail-closed JXA probe and selector shell**

The script locates official WeChat.app, checks Accessibility, reports window diagnostics, and traverses roles/subroles/descriptions only. It returns errors: permission_missing, screen_locked, client_not_running, selector_changed, and target_mismatch.

At this task scan may report selector_profile_required. Sending stays unavailable unless all invariants pass.

**Step 5: Run and commit**

Run:

    node src/wechat-poc/macos-ui-adapter.test.mjs
    node --check scripts/wechat-poc-ui.jxa
    npm test

Commit:

    git add package.json scripts/wechat-poc-ui.jxa src/wechat-poc/macos-ui-adapter.mjs src/wechat-poc/macos-ui-adapter.test.mjs
    git commit -m "feat(wechat-poc): add guarded macOS UI adapter"

### Task 6: Separate worker and LaunchAgent

**Files:**
- Create: src/wechat-poc/worker.mjs
- Create: src/wechat-poc/worker.test.mjs
- Create: scripts/install-wechat-poc-service.sh
- Create: scripts/wechat-poc-health.mjs
- Modify: package.json
- Modify: scripts/verify.sh

**Step 1: Write failing lifecycle tests**

Assert startup writes disabled status before probe; ticks never overlap; active polling is one second; SIGTERM disables and closes only POC resources; status is atomically written without raw message content; errors degrade/disable the POC and never signal the main service.

**Step 2: Run failure**

Run: node src/wechat-poc/worker.test.mjs

Expected: missing worker.

**Step 3: Implement composition**

Compose control store, isolated state, responder, adapter, and bridge. Import config.mjs only for read-only runtime paths/model selection. Never import src/index.mjs.

**Step 4: Add LaunchAgent installer**

Use label com.local.james-wechat-poc, RunAtLoad true, KeepAlive true, and POC-only logs. The installer may bootout/bootstrap only this label.

**Step 5: Run and commit**

Run:

    node src/wechat-poc/worker.test.mjs
    node scripts/wechat-poc-health.mjs --json
    npm test
    npm run check

Commit:

    git add package.json scripts/install-wechat-poc-service.sh scripts/verify.sh scripts/wechat-poc-health.mjs src/wechat-poc/worker.mjs src/wechat-poc/worker.test.mjs
    git commit -m "feat(wechat-poc): add isolated worker service"

### Task 7: Dashboard control API and audit

**Files:**
- Create: src/wechat-poc/dashboard-control.mjs
- Create: src/wechat-poc/dashboard-control.test.mjs
- Modify: src/dashboard-server.mjs
- Modify: src/dashboard-api-security.test.mjs
- Modify: src/dashboard-model.test.mjs
- Modify: package.json

**Step 1: Write failing controller/API tests**

Add behavior for:

- GET /api/wechat-poc/status
- POST /api/wechat-poc/control
- POST /api/wechat-poc/emergency-stop

Enabling requires confirmed true. Disabling immediately advances generation. Mutations require existing host checks, dashboard session token, and action-specific CSRF header. Missing authorization returns 403. Audit includes state change and cancelled count, never message text.

**Step 2: Run and observe failure**

Run:

    node src/wechat-poc/dashboard-control.test.mjs
    node src/dashboard-api-security.test.mjs

**Step 3: Implement controller and routes**

Read control/status atomically. Expose POC status as optional in /api/status. Failure to read POC files must not change primary-channel health. Never restart or signal the main LaunchAgent.

**Step 4: Run and commit**

Run:

    node src/wechat-poc/dashboard-control.test.mjs
    node src/dashboard-api-security.test.mjs
    node src/dashboard-model.test.mjs
    npm test

Commit:

    git add package.json src/dashboard-server.mjs src/dashboard-api-security.test.mjs src/dashboard-model.test.mjs src/wechat-poc/dashboard-control.mjs src/wechat-poc/dashboard-control.test.mjs
    git commit -m "feat(dashboard): add personal WeChat POC controls"

### Task 8: Dashboard master switch and diagnostics

**Files:**
- Modify: dashboard/index.html
- Modify: dashboard/app.js
- Modify: dashboard/styles.css
- Modify: dashboard/config-ui.test.mjs

**Step 1: Write failing static UI tests**

Require a distinct Personal WeChat POC card separate from legacy GeWe configuration, switch label 个人微信自动回复, confirmation text for direct/group-mention/text-only scope, emergency stop, and status fields for process, permission, last receive, last reply, pending, last error, and last action.

Assert the UI never claims this is an official personal-WeChat API.

**Step 2: Run and observe failure**

Run: node dashboard/config-ui.test.mjs

**Step 3: Implement UI**

Enabling shows confirmation, then posts enabled true and confirmed true. Disabling posts enabled false. Emergency stop uses its endpoint. Disable both controls while a mutation is pending. Poll with the existing refresh cycle.

Visible states: 已关闭, 等待权限, 微信未运行, 可启用, 运行中, 降级, 发送不确定.

**Step 4: Run and commit**

Run:

    node dashboard/config-ui.test.mjs
    npm test
    npm run check

Commit:

    git add dashboard/index.html dashboard/app.js dashboard/styles.css dashboard/config-ui.test.mjs
    git commit -m "feat(dashboard): add personal WeChat safety switch"

### Task 9: Isolation regression and simulator

**Files:**
- Create: src/wechat-poc/isolation.test.mjs
- Create: scripts/wechat-poc-simulate.mjs
- Create: scripts/wechat-poc-regression.mjs
- Modify: package.json
- Modify: README

**Step 1: Write failing isolation test**

Simulate direct, group mention, group non-mention, duplicate scan, flood, UI hang, process error, epoch change, and uncertain send. At the same time run fake Feishu and DingTalk heartbeat/send loops and assert their event counts and latency bounds are unchanged.

**Step 2: Add simulator and regression runner**

The simulator uses the real bridge core with deterministic fake UI/responder. The regression runner executes the full suite, simulator, health command, and confirms POC scripts contain no mutation command referencing either primary LaunchAgent label.

**Step 3: Update README**

Document architecture, switch semantics, restart-default-off, Accessibility requirements, text-only scope, health/log/stop commands, POC warning, and POC-only rollback.

**Step 4: Verify and commit**

Run:

    npm test
    npm run check
    node scripts/wechat-poc-regression.mjs
    git diff --check

Commit:

    git add package.json README scripts/wechat-poc-simulate.mjs scripts/wechat-poc-regression.mjs src/wechat-poc/isolation.test.mjs
    git commit -m "test(wechat-poc): add isolated acceptance regression"

### Task 10: Controlled real UI mapping and acceptance

**Files:**
- Modify: scripts/wechat-poc-ui.jxa
- Create: src/wechat-poc/fixtures/
- Modify: src/wechat-poc/macos-ui-adapter.test.mjs
- Create: docs/个人微信POC验收记录.md

**Step 1: Run read-only diagnostics**

Run:

    node scripts/wechat-poc-health.mjs --json
    /usr/bin/osascript -l JavaScript scripts/wechat-poc-ui.jxa probe e30=

Expected: structured client, desktop, and permission state. No message read or send.

**Step 2: Open official WeChat and obtain permission**

Use @computer-use. The operator completes normal login if needed and grants Accessibility permission. Never request or record the password.

**Step 3: Capture a redacted Accessibility profile**

Inspect one controlled direct conversation and one controlled group. Record only roles/subroles/descriptions. Redact names, content, and identifiers.

**Step 4: Add failing fixture tests, then selectors**

Prove the profile identifies exactly one conversation list, message list, title, and input. Ambiguous fixtures must fail closed. Implement the minimum selectors and run:

    node src/wechat-poc/macos-ui-adapter.test.mjs
    npm test
    npm run check

**Step 5: Install only the POC service**

Run: ./scripts/install-wechat-poc-service.sh

Expected: com.local.james-wechat-poc is running and disabled. No primary service restart.

**Step 6: Record primary baseline**

Run read-only health checks for main service, dashboard, Feishu, and DingTalk. Any failure stops live POC testing.

**Step 7: Controlled direct acceptance**

Enable from dashboard. Send one harmless text from a controlled secondary account. Verify exactly one reply from the personal account and record discovery/end-to-end latency.

**Step 8: Controlled group acceptance**

Send one group message without mention and verify no reply. Send one explicit mention and verify exactly one reply.

**Step 9: Emergency stop and restart**

Queue a reply, press emergency stop before send, verify cancellation, restart only the POC worker, and verify the switch remains disabled.

**Step 10: Re-run primary health checks**

Verify Feishu and DingTalk match baseline. Disable POC after evidence collection.

**Step 11: Final verification and commit**

Use @verification-before-completion and run:

    npm test
    npm run check
    node scripts/wechat-poc-regression.mjs
    git diff --check
    git status --short

Write redacted evidence to docs/个人微信POC验收记录.md and commit fixtures/selectors/evidence.

### Task 11: Complete the isolated branch

**Files:**
- No expected source changes

**Step 1: Review**

Run:

    git log --oneline main..HEAD
    git diff --stat main...HEAD
    git diff --check main...HEAD

Expected: only POC, dashboard, tests, docs, and dedicated service changes. No Feishu or DingTalk listener/sender behavior changes.

**Step 2: Verify running-service isolation**

Confirm the live main LaunchAgent PID/start time did not change and the POC uses a separate label and logs.

**Step 3: Finish**

Use @finishing-a-development-branch. Do not merge, push, or restart primary services without explicit authorization already present in the operator request.

