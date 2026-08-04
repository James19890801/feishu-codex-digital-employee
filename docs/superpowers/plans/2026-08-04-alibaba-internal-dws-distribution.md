# Alibaba Internal DWS Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a privacy-clean Alibaba-internal macOS package with 阿充 as the sole developer and DWS event-stream as the only DingTalk transport.

**Architecture:** Keep publisher metadata separate from each installation's operator profile. Add a small DWS deployment-policy module used by the installer to accept standalone DWS binaries and reject Wukong paths, while runtime validation rejects every non-event-stream DingTalk transport before service startup.

**Tech Stack:** Node.js ESM, Node test scripts with `node:assert/strict`, zsh LaunchAgent installers, JSON distribution configuration, ZIP/checksum packaging.

## Global Constraints

- The only developer and maintainer is `阿充`.
- Every installer configures their own operator identity, DWS Profile, DWS Channel, and credentials.
- DingTalk uses DWS `event-stream` only; `wukong-polling` and automatic fallback are forbidden.
- The package contains no account, token, OpenDingTalkId, employee ID, local Profile, local Channel, chat, memory, knowledge, or blacklist data.
- Existing user configuration and data remain preserved during upgrades.

---

### Task 1: Publisher metadata and safe Alibaba defaults

**Files:**
- Modify: `package.json`
- Modify: `config.distribution.json`
- Modify: `scripts/distribution-package.mjs`
- Modify: `scripts/distribution-defaults.test.mjs`
- Modify: `scripts/distribution-package.test.mjs`

**Interfaces:**
- Consumes: `buildDistribution({ root, outputDir, version })`.
- Produces: release manifest property `developers: ["阿充"]` and new-install DingTalk defaults.

- [ ] **Step 1: Write failing assertions**

Add assertions that `package.json.author` is `阿充`, the distribution defaults enable DingTalk with `event-stream`, keep Profile/Channel/bin empty, and the generated `release-manifest.json` contains exactly `developers: ['阿充']`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node scripts/distribution-defaults.test.mjs && node scripts/distribution-package.test.mjs`

Expected: FAIL because the author/developers metadata is absent and DingTalk is disabled.

- [ ] **Step 3: Implement the minimum metadata/default changes**

Set `package.json.author` to `阿充`, set `config.distribution.json.dingtalkEnabled` to `true`, preserve empty per-user DWS values, and add `developers: ['阿充']` to the release manifest.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node scripts/distribution-defaults.test.mjs && node scripts/distribution-package.test.mjs`

Expected: both tests print their `*_TEST_OK` marker.

### Task 2: Event-stream-only runtime policy

**Files:**
- Modify: `src/runtime-mode.mjs`
- Modify: `src/runtime-mode.test.mjs`

**Interfaces:**
- Consumes: `validateDingTalkConfiguration(configuration)`.
- Produces: deterministic rejection of any transport other than `event-stream`.

- [ ] **Step 1: Write a failing transport-policy test**

Assert that `validateDingTalkConfiguration({ dingtalkEnabled: true, dingtalkTransport: 'wukong-polling' })` throws an error containing `event-stream` and `Wukong`.

- [ ] **Step 2: Run test and verify RED**

Run: `node src/runtime-mode.test.mjs`

Expected: FAIL because the current validator accepts `wukong-polling`.

- [ ] **Step 3: Implement the minimum rejection**

Change `validateDingTalkConfiguration` so only `event-stream` is valid and the error explicitly states that Wukong is disabled by deployment policy.

- [ ] **Step 4: Run test and verify GREEN**

Run: `node src/runtime-mode.test.mjs`

Expected: `RUNTIME_MODE_TEST_OK`.

### Task 3: Standalone DWS installer detection

**Files:**
- Create: `scripts/dws-deployment-policy.mjs`
- Create: `scripts/dws-deployment-policy.test.mjs`
- Modify: `scripts/install-aicoding.mjs`
- Modify: `scripts/install-aicoding.test.mjs`
- Modify: `scripts/distribution-package.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `resolveStandaloneDws({ explicitPath, home, candidates, isExecutable }) -> string`.
- Consumes: `AIPRO_DWS_BIN`, installer HOME, executable-path checks.

- [ ] **Step 1: Write failing policy tests**

Cover an explicit executable, the standard `~/.npm-global/bin/dws` candidate, a missing binary, `.real/.bin/dws/bin/dws`, and paths/names containing `wukong`. Assert accepted paths are absolute and forbidden paths throw an error containing `Wukong is not allowed`.

- [ ] **Step 2: Run policy test and verify RED**

Run: `node scripts/dws-deployment-policy.test.mjs`

Expected: module-not-found failure.

- [ ] **Step 3: Implement the policy module**

Normalize paths with `resolve`, inspect explicit path before candidates, require an executable regular file, reject case-insensitive Wukong names and the `.real/.bin/dws` directory, and throw a concise DWS installation error when no allowed binary exists.

- [ ] **Step 4: Integrate installer configuration**

For a new install, resolve DWS and write its absolute path to `config.local.json.dingtalkBin`. Preserve an existing user's local config unchanged during upgrades. Include the new production script in the package allowlist.

- [ ] **Step 5: Run installer tests and verify GREEN**

Run: `node scripts/dws-deployment-policy.test.mjs && node scripts/install-aicoding.test.mjs && node scripts/distribution-package.test.mjs`

Expected: all three tests print their `*_TEST_OK` marker, including explicit proof that a Wukong path is rejected and standalone DWS is written for a new install.

### Task 4: Deployment guide, package build, and acceptance

**Files:**
- Modify: `AI_CODING_INSTALL.md`
- Modify: `docs/testing/2026-08-03-aicoding-package-regression.md`

**Interfaces:**
- Consumes: final ZIP, release manifest, checksum list, health scripts.
- Produces: deployable artifact and evidence-backed deployment instructions.

- [ ] **Step 1: Update deployment instructions**

Document Alibaba-internal scope, sole developer 阿充, per-user identity isolation, standalone DWS prerequisite, DWS login/Profile/Channel setup, `event-stream` verification, and the explicit Wukong prohibition.

- [ ] **Step 2: Run focused and full verification**

Run: `npm run check`, `npm test`, `npm run test:distribution-package`, and `npm run test:install-aicoding`.

Expected: exit 0, mechanism acceptance reports zero failures.

- [ ] **Step 3: Build and inspect the ZIP**

Run: `npm run package:aicoding`, verify `SHA256SUMS`, parse `release-manifest.json`, and scan the extracted package for local forbidden values and Wukong configuration.

Expected: one developer (`阿充`), DingTalk event-stream defaults, zero privacy violations, and all payload checksums valid.

- [ ] **Step 4: Update the regression report and commit**

Record the new hash/file count/bytes and exact passed checks. Stage only files from this plan, leaving unrelated user changes untouched, and commit with `feat: package Alibaba internal DWS distribution`.
