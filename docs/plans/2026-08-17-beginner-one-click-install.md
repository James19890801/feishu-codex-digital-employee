# Beginner One-Click Installation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a repository-URL-only installation reliable on a learner machine with no preinstalled developer environment for users of WorkBuddy, Qoder Work, and compatible AI coding tools on macOS and Windows, with automated Linux compatibility.

**Architecture:** A source checkout and a packaged release both call one installer core. DingTalk is the primary learner channel and uses a pinned standalone DWS event-stream client installed in the user's application directory; all other channels stay disabled. Platform-specific credential and service operations sit behind explicit adapters, while installation success is proven through instance attestation rather than port availability.

**Tech Stack:** Node.js ESM, `node:test`, `node:sqlite`, shell/PowerShell service helpers, macOS Keychain, Windows credential fallback, pnpm, GitHub Actions.

---

### Task 1: Make the repository-root installer source-aware

**Files:**
- Modify: `install.mjs`
- Modify: `package.json`
- Modify: `install.command`
- Create: `install.ps1`
- Create: `scripts/bootstrap-node.mjs`
- Create: `scripts/bootstrap-node.test.mjs`
- Create: `scripts/source-install-entrypoint.test.mjs`

**Steps:**

1. Write a failing test that copies only the source entrypoint and installer layout into a temporary directory and asserts that `node install.mjs --help` resolves `scripts/install-aicoding.mjs` when `payload/` is absent.
2. Run `node scripts/source-install-entrypoint.test.mjs`; verify the current `MODULE_NOT_FOUND` failure.
3. Implement deterministic layout selection: packaged `payload/scripts/install-aicoding.mjs` when present, otherwise source `scripts/install-aicoding.mjs`; reject incomplete layouts with one actionable error.
4. Raise the engine floor to Node 22.13 and add an installer capability probe for `node:sqlite`.
5. Write failing tests for a host with no Node in `PATH`: bootstrap must prefer a compatible AI-tool-bundled Node, otherwise download the official per-platform archive, verify the official SHA-256 manifest, extract it under a user-owned runtime directory, and continue without administrator access.
6. Add POSIX and PowerShell bootstrap entrypoints. Never execute an unverified downloaded binary.
7. Run the focused tests and syntax checks.
8. Commit as `fix: bootstrap source installation without developer tools`.

### Task 2: Establish one executable release-verification contract

**Files:**
- Modify: `package.json`
- Modify: `scripts/distribution-package.mjs`
- Modify: `scripts/install-aicoding.mjs`
- Create: `scripts/verify-install.mjs`
- Create: `scripts/verify-install.test.mjs`
- Modify: `scripts/distribution-package.test.mjs`

**Steps:**

1. Write failing tests asserting that the distribution contains every file referenced by `verify:install`, and that the command runs from an extracted package without source-only tests.
2. Run the focused tests and capture the missing-file failures.
3. Add a self-contained `verify:install` script that checks configuration, SQLite/database access, service metadata, Dashboard attestation, and runtime readiness without referencing excluded source tests. Initial verification must not require Python.
4. Make the distribution builder derive its required script list from the verification contract instead of an unrelated hand-maintained subset.
5. Keep `check` and `test` as developer commands; update the AI installation contract to use `verify:install` after package installation.
6. Build a package into a temporary directory, extract it, install frozen dependencies, and run `npm run verify:install` in offline/service-test mode.
7. Commit as `fix: ship self-contained install verification`.

### Task 3: Make first-run defaults fail closed

**Files:**
- Modify: `config.distribution.json`
- Modify: `config.example.json`
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `scripts/distribution-defaults.test.mjs`
- Modify: `scripts/setup.sh`

**Steps:**

1. Write failing assertions that every connector, external write, semantic group engagement, relationship memory, and daily learning feature is explicitly disabled in distribution and example configs.
2. Run both focused tests and verify failures against the current defaults.
3. Remove real identifiers and unsafe placeholder values from public defaults; use obvious neutral placeholders only where a value is structurally required.
4. Change runtime fallbacks for optional outward/learning features to `false`, and make setup generate the safe distribution baseline.
5. Align proactive limits and all config assertions with the single canonical baseline.
6. Run config, distribution-default, and public-neutrality tests.
7. Commit as `fix: make beginner defaults fail closed`.

### Task 4: Provision and validate DingTalk as the primary channel

**Files:**
- Modify: `scripts/install-aicoding.mjs`
- Modify: `scripts/install-aicoding.test.mjs`
- Modify: `scripts/connector-deployment-policy.mjs`
- Modify: `src/im-channels.mjs`
- Modify: `src/im-channel-runtime.mjs`
- Modify: `src/dashboard-server.mjs`
- Modify: `dashboard/index.html`
- Modify: `dashboard/app.js`
- Modify: `dashboard/i18n.js`
- Create: `scripts/dingtalk-readiness.mjs`
- Create: `scripts/dingtalk-readiness.test.mjs`

**Steps:**

1. Write failing tests proving a clean installation provisions pinned `dingtalk-workspace-cli@1.0.58` into a user-owned application tools directory without global npm or administrator access.
2. Write failing readiness tests separating DWS installed, DingTalk account authenticated, Profile/Channel configured, event-stream connected, and controlled self-chat verified.
3. Rebrand the public onboarding surface from generic `EnterpriseChat` to DingTalk while retaining backward-compatible internal config migration.
4. Keep DingTalk disabled until the learner completes their own login and authorization; open the Dashboard on the DingTalk setup action and request only one interactive login action at a time.
5. Reject Wukong/legacy bridge paths and accept only the standalone DWS client.
6. Add a controlled self-chat acceptance that requires explicit learner authorization and a delivery receipt; never message another person for installation testing.
7. Run DingTalk unit, runtime, Dashboard, installer, and mechanism tests.
8. Commit as `feat: make DingTalk the beginner primary channel`.

### Task 5: Enforce the communication blocklist at all message boundaries

**Files:**
- Modify: `src/communication-blocklist.mjs`
- Modify: `src/communication-blocklist.test.mjs`
- Modify: `src/im-channel-runtime.mjs`
- Modify: `src/event-consumer.mjs`
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`

**Steps:**

1. Write failing normalization tests for every canonical channel, including case variants of `enterpriseChat`.
2. Write failing integration tests proving a blocked sender is rejected before enqueue, before consume, and before outbound send.
3. Run the focused tests and confirm the current module is not wired into production paths.
4. Introduce one canonical channel normalizer and one side-effect-free block decision API.
5. Inject the decision into the three production boundaries; log a redacted reason without storing blocked message content.
6. Run the focused tests and mechanism acceptance.
7. Commit as `fix: enforce communication blocklist end to end`.

### Task 6: Add cross-platform credential storage

**Files:**
- Modify: `src/channel-credentials.mjs`
- Modify: `src/channel-credentials.test.mjs`
- Modify: `src/licensing/keychain.mjs`
- Modify: `src/licensing/keychain.test.mjs`
- Modify: `src/index.mjs`
- Create: `src/platform-credentials.mjs`
- Create: `src/platform-credentials.test.mjs`

**Steps:**

1. Write failing adapter tests for macOS Keychain, Windows Credential Manager/PowerShell, and a user-restricted file fallback with atomic writes and `0600`-equivalent permissions.
2. Run the focused test and verify direct `/usr/bin/security` coupling causes failure outside macOS.
3. Implement a platform adapter with dependency-injected command execution and filesystem operations.
4. Migrate channel credentials, licensing credentials, and startup credential reads to the adapter.
5. Ensure errors never include credential values and public configuration never persists secrets.
6. Run credential, licensing, config, and public-neutrality tests.
7. Commit as `fix: support credentials on macOS and Windows`.

### Task 7: Unify platform service control and transactional rollback

**Files:**
- Modify: `scripts/install-aicoding.mjs`
- Modify: `scripts/install-aicoding.test.mjs`
- Modify: `scripts/install-service.test.mjs`
- Modify: `scripts/install-service.sh`
- Modify: `scripts/install-dashboard-service.sh`
- Modify: `src/dashboard-server.mjs`
- Create: `src/platform-services.mjs`
- Create: `src/platform-services.test.mjs`

**Steps:**

1. Write failing tests for macOS LaunchAgents, Windows scheduled tasks, Linux systemd, Dashboard restart, and failure after only the first service registers.
2. Verify that current Dashboard restart is macOS-only and partial registration is not rolled back.
3. Implement a platform service-controller API used by both the installer and Dashboard.
4. Pass the exact validated Node and optional Python paths into generated service definitions.
5. Record every side effect as a compensation and run compensations in reverse order on failure.
6. Run service controller, installer, and partial-rollback tests for all simulated platforms.
7. Commit as `fix: make service installation transactional`.

### Task 8: Replace port-only success with installation attestation

**Files:**
- Modify: `scripts/install-aicoding.mjs`
- Modify: `scripts/install-aicoding.test.mjs`
- Modify: `src/dashboard-server.mjs`
- Modify: `src/dashboard-api-security.test.mjs`
- Modify: `scripts/health-check.mjs`
- Modify: `scripts/verify-install.mjs`

**Steps:**

1. Write a failing test where an unrelated healthy Dashboard occupies port 17655; assert installation verification rejects it.
2. Write failing tests for wrong installation ID, build SHA, install root, stale startup time, missing main service, and custom Dashboard ports.
3. Run the focused tests and confirm current false-positive behavior.
4. Generate an installation ID during staging and expose a redacted attestation from the local status endpoint.
5. Require exact attestation matches plus healthy main and Dashboard processes before printing `INSTALL_OK`.
6. Discover the configured port instead of hardcoding 17655.
7. Run focused tests and a real local stale-Dashboard reproduction.
8. Commit as `fix: attest the installed service instance`.

### Task 9: Make runtime auto-selection reflect real readiness

**Files:**
- Modify: `src/ai-runtime.mjs`
- Modify: `src/ai-runtime.test.mjs`
- Modify: `scripts/runtime-smoke.mjs`
- Modify: `scripts/verify-install.mjs`
- Modify: `src/index.mjs`

**Steps:**

1. Write failing tests separating executable discovery, authentication, real-call readiness, and connector readiness.
2. Write a failing fallback test where the first executable exists but is unauthenticated and the second runtime is usable.
3. Move Codex auth-link setup after runtime selection; add a Windows `EPERM` regression test and safe fallback.
4. Implement bounded readiness probes and select only a real-call-ready runtime in `auto` mode.
5. Ensure probes are side-effect-free and redact output that may contain user content or tokens.
6. Run runtime tests and simulated WorkBuddy/Qoder Work/Codex readiness matrices.
7. Commit as `fix: select only ready AI runtimes`.

### Task 10: Eliminate test-suite and policy drift

**Files:**
- Modify: `package.json`
- Modify: `scripts/connector-deployment-policy.mjs`
- Modify: `src/conversation-context-client.mjs`
- Modify: `src/pending-actions.mjs`
- Modify: `src/inbound-reply-gate.mjs`
- Modify: related `*.test.mjs` files
- Create: `scripts/test-all.mjs`
- Create: `scripts/test-coverage-contract.test.mjs`

**Steps:**

1. Write a failing contract test that detects any repository `*.test.mjs` file excluded from the canonical test runner.
2. Replace the hand-written command chain with deterministic test discovery and explicit environment-dependent exclusions.
3. Fix the lowercased `legacyBridge` policy comparison and its duplicate path check.
4. Resolve the `mail_write` pending-action contract, inbound-reply-gate export mismatch, and other non-environment orphan-test failures identified by the audit.
5. Run the canonical suite and require zero unclassified failures.
6. Commit as `test: enforce complete repository test discovery`.

### Task 11: Add release CI and beginner-facing instructions

**Files:**
- Create: `.github/workflows/release-gate.yml`
- Modify: `AGENTS.md`
- Modify: `AI_CODING_INSTALL.md`
- Modify: `README.md`
- Modify: `package.json`
- Create: `BEGINNER_INSTALL_PROMPT.md`

**Steps:**

1. Add package scripts for every command documented in README and test that documented npm commands exist.
2. Add CI jobs for supported Node versions on macOS, Windows, and Ubuntu; run clean install, canonical tests, distribution build, extracted-package verification, and simulated service tests.
3. Document macOS and Windows as the beginner release gate and Linux as automated compatibility.
4. Add a copy-ready WorkBuddy/Qoder Work prompt that asks the tool to clone, follow `AGENTS.md`, install, verify, open Dashboard, and report readiness states.
5. Document zero-environment bootstrapping: no Node, Python, pnpm, Homebrew, winget, or administrator rights are assumed.
6. Run a documentation-command contract test.
7. Commit as `docs: add beginner AI coding installation flow`.

### Task 12: Execute final black-box release verification

**Files:**
- Modify only if a newly reproduced defect requires a test-first fix.

**Steps:**

1. From a temporary clean source clone with a restricted `PATH` that exposes no developer Node/Python/package manager, run the OS bootstrap and prove it provisions a verified user-local Node runtime, dependencies, both services, and the Dashboard.
2. Build the distribution, extract it to another temporary directory, install frozen production dependencies, and run `npm run verify:install`.
3. Run macOS service installation in an isolated test namespace and verify exact attestation, runtime readiness reporting, Dashboard loading, and complete cleanup.
4. Run Windows black-box verification through the project CI workflow or an available Windows runner; do not claim Windows completion from mocks alone.
5. Run Ubuntu compatibility verification through CI.
6. Re-run production dependency audit and secret/identifier scans.
7. Review `git diff`, `git diff --check`, and the design acceptance checklist.
8. Commit any final test-only release metadata as `chore: record beginner installation verification`.

### Task 13: Integrate and publish

**Files:**
- No code changes expected.

**Steps:**

1. Fetch `origin/main` and rebase the implementation branch if the remote advanced.
2. Re-run the complete release gate after rebasing.
3. Push `codex/beginner-one-click-install` and fast-forward `main` only if all required gates pass.
4. Confirm the remote `main` SHA and verify the GitHub-rendered beginner instructions.
5. Report the exact commit SHA, verification results, and any external platform gate that could not be executed.
