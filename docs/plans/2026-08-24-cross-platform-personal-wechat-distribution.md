# AIPRO Cross-Platform Personal WeChat Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Produce one shareable ZIP containing double-click Windows and macOS installers, a single user guide, and a privacy-safe local AIPRO build that connects to a user-supplied GeWe account and a user-selected AI runtime.

**Architecture:** Keep the existing Node message core and Dashboard, separate immutable application resources from mutable user state, and add thin per-platform installers around an allowlisted production payload. Bundle platform Node and Cloudflared binaries; let the user choose a verified headless AI runtime and let AI Coding handle exceptional local troubleshooting from the included guide.

**Tech Stack:** Node.js ESM, Node test runner/assert scripts, Swift/AppKit/WebKit, PowerShell, Windows Task Scheduler, macOS LaunchAgents, Cloudflared, `ditto`/`hdiutil`, SHA-256 manifests.

---

### Task 1: Make the runtime resource root and user state portable

**Files:**
- Create: `src/config-paths.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/dashboard-server.mjs`

**Step 1: Write the failing path test**

Spawn a fresh Node process with `AIPRO_RESOURCE_ROOT`, `AIPRO_HOME`, and `DIGITAL_EMPLOYEE_CONFIG` pointing at temporary directories. Assert `config.resourceRoot` equals the immutable resource directory, `config.workdir` equals the mutable directory, and bundled dashboard/scripts are resolved from `resourceRoot`.

**Step 2: Run the test and verify RED**

Run: `node src/config-paths.test.mjs`

Expected: failure because `config.resourceRoot` is not exported and `workdir` is tied to the source checkout.

**Step 3: Implement resource/state separation**

Derive paths in `src/config.mjs`:

```js
const resourceRoot = resolve(process.env.AIPRO_RESOURCE_ROOT || resolve(srcDir, '..'));
const workdir = resolve(process.env.AIPRO_HOME || resourceRoot);
const configPath = process.env.DIGITAL_EMPLOYEE_CONFIG || join(workdir, 'config.local.json');
```

Use `resourceRoot` for bundled scripts, dashboard assets, templates, Python extractor, and native helpers. Continue using `workdir` for config, data, knowledge, logs, artifacts, and process working directories.

**Step 4: Run focused regressions**

Run: `node src/config-paths.test.mjs && node src/config.test.mjs && node src/dashboard-api-security.test.mjs`

Expected: all pass.

**Step 5: Commit clean files only**

```bash
git add src/config-paths.test.mjs src/config.mjs src/dashboard-server.mjs
git commit -m "refactor: separate packaged resources from user state"
```

### Task 2: Remove personal defaults from the public build

**Files:**
- Create: `scripts/distribution-default-safety.test.mjs`
- Modify: `config.distribution.json`
- Modify: `src/config.mjs`
- Modify: `scripts/distribution-package.mjs`

**Step 1: Write a failing safety test**

Assert the distribution config and effective defaults contain no non-empty owner WeChat IDs, publisher IDs, real group names, tokens, App IDs, callback URLs, or local absolute paths. Assert risky proactive WeChat features are disabled.

**Step 2: Run the test and verify RED**

Run: `node scripts/distribution-default-safety.test.mjs`

Expected: failure on existing owner/publisher identifiers.

**Step 3: Sanitize defaults and strengthen the scanner**

Make owner and publisher ID defaults empty, disable owner consultation unless IDs are explicitly supplied, and extend the distribution scanner with a denylist for known credential/config field values. Use a fixed public developer label in the release manifest instead of requiring `package.json` to carry personal build metadata.

**Step 4: Run packaging safety tests**

Run: `node scripts/distribution-default-safety.test.mjs && node scripts/distribution-package.test.mjs && node src/config.test.mjs`

Expected: all pass.

**Step 5: Commit**

```bash
git add scripts/distribution-default-safety.test.mjs config.distribution.json src/config.mjs scripts/distribution-package.mjs
git commit -m "fix: sanitize personal WeChat distribution defaults"
```

### Task 3: Add Windows secure credential storage and runtime discovery

**Files:**
- Modify: `src/channel-credentials.test.mjs`
- Modify: `src/channel-credentials.mjs`
- Modify: `src/ai-runtime.test.mjs`
- Modify: `src/ai-runtime.mjs`

**Step 1: Add failing platform tests**

Inject `platform` and command runners. Verify Darwin uses `/usr/bin/security`, Windows uses a PowerShell Credential Locker script without putting the secret in command-line arguments, and unsupported platforms fail closed. Add Windows path candidates for `.exe`, WorkBuddy's bundled `codebuddy` CLI, and user-configured custom CLI.

**Step 2: Run tests and verify RED**

Run: `node src/channel-credentials.test.mjs && node src/ai-runtime.test.mjs`

Expected: Windows credential/runtime assertions fail.

**Step 3: Implement minimal adapters**

Keep existing exported function names. Route credential read/write/delete by platform and pass credential bytes through stdin. Add `workbuddy` as a detected label that is available only when a known headless CodeBuddy-compatible executable exists; desktop-only detection reports installed but unavailable.

**Step 4: Run tests**

Run: `node src/channel-credentials.test.mjs && node src/ai-runtime.test.mjs && node src/config-assistant.test.mjs`

Expected: all pass.

**Step 5: Commit**

```bash
git add src/channel-credentials.test.mjs src/channel-credentials.mjs src/ai-runtime.test.mjs src/ai-runtime.mjs
git commit -m "feat: support Windows credentials and WorkBuddy runtime detection"
```

### Task 4: Add platform service templates and launchers

**Files:**
- Create: `scripts/platform-service.mjs`
- Create: `scripts/platform-service.test.mjs`
- Create: `windows/Install-AIPRO.ps1`
- Create: `windows/Start-AIPRO.cmd`
- Create: `windows/Uninstall-AIPRO.ps1`
- Create: `macos/AIPRO/bootstrap.sh`

**Step 1: Write failing service-template tests**

Assert Windows commands use `%LOCALAPPDATA%`, Task Scheduler under the current user, quoted absolute paths, and environment variables for resource/state separation. Assert macOS uses `~/Library/Application Support/AIPRO`, user LaunchAgents, bundled Node, and no source-checkout paths.

**Step 2: Run tests and verify RED**

Run: `node scripts/platform-service.test.mjs`

Expected: module/templates missing.

**Step 3: Implement idempotent per-user installation**

The Windows script copies the allowlisted payload, preserves mutable state, installs production dependencies if not already bundled, registers dashboard/core/tunnel tasks, and opens the local Dashboard. The macOS bootstrap does the same with LaunchAgents. Both provide rollback on failed upgrade and never require administrator rights.

**Step 4: Run contract tests and shell syntax checks**

Run: `node scripts/platform-service.test.mjs && zsh -n macos/AIPRO/bootstrap.sh`

Expected: pass.

**Step 5: Commit**

```bash
git add scripts/platform-service.mjs scripts/platform-service.test.mjs windows macos/AIPRO/bootstrap.sh
git commit -m "feat: add Windows and macOS local service bootstrap"
```

### Task 5: Build deterministic platform packages

**Files:**
- Create: `scripts/cross-platform-package.mjs`
- Create: `scripts/cross-platform-package.test.mjs`
- Create: `scripts/build-cross-platform-package.mjs`
- Create: `macos/AIPRO/config.first-run.json`

**Step 1: Write the failing package contract**

Assert the builder creates three platform payloads, includes platform Node/Cloudflared acquisition with SHA-256 verification, copies only the production allowlist, preserves executable bits, emits per-package manifests, and refuses local secrets or personal IDs.

**Step 2: Run and verify RED**

Run: `node scripts/cross-platform-package.test.mjs`

Expected: module missing.

**Step 3: Implement the staging builder**

Build immutable payloads under a temporary directory. Reuse `distributionFileList` and `scanDistribution`, run `pnpm deploy --prod` or an equivalent clean production install, add platform launchers and bundled binaries, and create:

- a Windows x64 install directory with a double-click `安装 AIPRO.cmd` entry;
- a signed ad-hoc Apple Silicon app/DMG;
- a signed ad-hoc Intel app/DMG.

If the build host cannot produce a trusted Windows PE wrapper, retain the double-click CMD/PowerShell installer inside the Windows ZIP and record that exact limitation in the guide rather than emitting a fake EXE.

**Step 4: Run package tests**

Run: `node scripts/cross-platform-package.test.mjs && node scripts/distribution-package.test.mjs`

Expected: pass.

**Step 5: Commit**

```bash
git add scripts/cross-platform-package.mjs scripts/cross-platform-package.test.mjs scripts/build-cross-platform-package.mjs macos/AIPRO/config.first-run.json
git commit -m "feat: stage cross-platform AIPRO installers"
```

### Task 6: Add the single non-technical installation guide

**Files:**
- Create: `distribution/开始使用.html`
- Create: `distribution/guide.test.mjs`

**Step 1: Write a failing guide contract**

Require Windows and macOS installation, system security prompts, AI runtime selection, user-owned GeWe acquisition, Token/App ID entry, Cloudflare callback, QR login, safe test contact, pause/recovery, and “copy this diagnostic prompt into AI Coding” instructions.

**Step 2: Run and verify RED**

Run: `node distribution/guide.test.mjs`

Expected: guide missing.

**Step 3: Write the guide**

Produce one self-contained, mobile-friendly HTML file with no external assets. Keep the main path under ten steps. Include a copyable AI Coding troubleshooting prompt that asks the runtime to inspect the local AIPRO health endpoint, logs, runtime smoke, GeWe connection, and tunnel status without exposing credentials.

**Step 4: Run the guide test**

Run: `node distribution/guide.test.mjs`

Expected: pass.

**Step 5: Commit**

```bash
git add distribution/开始使用.html distribution/guide.test.mjs
git commit -m "docs: add one-page AIPRO installation guide"
```

### Task 7: Build the final aggregate ZIP and verify it

**Files:**
- Create: `scripts/final-distribution.test.mjs`
- Modify: `scripts/build-cross-platform-package.mjs`

**Step 1: Add a failing final-artifact test**

Require the aggregate ZIP to contain Windows, Apple Silicon, Intel, the single guide, `release-manifest.json`, and `SHA256SUMS.txt`. Inspect archive names and extracted file contents for secrets, personal IDs, local paths, logs, databases, and user configuration.

**Step 2: Run and verify RED**

Run: `node scripts/final-distribution.test.mjs`

Expected: final artifact absent.

**Step 3: Run focused and project verification**

Run all new tests, then `pnpm test` and `pnpm run check`. Record any pre-existing unrelated failure separately; do not weaken the new packaging checks.

**Step 4: Build**

Run: `node scripts/build-cross-platform-package.mjs --version 1.0.0 --output dist`

Expected: `dist/AIPRO-个人微信数字人-1.0.0.zip` exists.

**Step 5: Inspect and hash**

Run: `node scripts/final-distribution.test.mjs dist/AIPRO-个人微信数字人-1.0.0.zip && shasum -a 256 dist/AIPRO-个人微信数字人-1.0.0.zip`

Expected: test passes and one SHA-256 is printed.

**Step 6: Commit only source/test changes**

Do not commit generated installers, downloaded runtimes, user configuration, logs, or the final ZIP. Keep the deliverable under `dist/` for handoff.
