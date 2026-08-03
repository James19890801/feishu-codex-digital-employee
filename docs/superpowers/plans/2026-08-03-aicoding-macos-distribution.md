# AI Coding macOS Distribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a privacy-clean macOS source ZIP that another user can install from an AI Coding tool by running `zsh ./install.command` once.

**Architecture:** First remove current-machine identity and executable-path assumptions from production runtime by routing them through validated local configuration. Then build an explicit-allowlist distribution staging tree, wrap it with a checksum-verifying installer, and validate the ZIP in an isolated fake HOME with stubbed service registration before delivery.

**Tech Stack:** Node.js 22 ESM, zsh, macOS LaunchAgent/launchctl, pnpm/Corepack, Python virtualenv, SHA-256, `ditto` ZIP archives.

## Global Constraints

- Target macOS only; Windows, Linux, signed PKG, DMG, notarization, and automatic updates are out of scope.
- The only user command is `zsh ./install.command`; OAuth and personal authorization remain explicit user steps.
- Never package local configuration, credentials, profile IDs, channel codes, blacklists, Persona/Bible, knowledge indexes, SQLite, logs, receipts, recovery kits, or personal documentation.
- New installations start with every IM channel, 1A, and external write integration disabled and cannot auto-reply before user setup.
- Existing installations preserve `config.local.json`, `PERSONA.md`, `BIBLE.md`, and `data/` across idempotent reruns.
- The current runtime remains Codex + original DWS event-stream; packaging must not introduce Wukong.
- All behavior changes follow strict red-green TDD.

---

### Task 1: Configurable Operator Identity

**Files:**
- Create: `src/operator-profile.mjs`
- Create: `src/operator-profile.test.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify locally, ignored: `config.local.json`
- Modify: `package.json`

**Interfaces:**
- Produces: `normalizeOperatorProfile({ displayName, role, aliases, brandName }) -> { displayName, role, aliases, brandName, ownerLabel }`.
- Produces config keys: `ownerDisplayName`, `ownerRole`, `ownerAliases`, `digitalHumanBrand`.
- Consumers in later tasks receive one normalized profile and never hardcode a person's name.

- [ ] **Step 1: Write the failing operator-profile test**

Add literal expectations for trimming/deduplication, safe generic defaults, maximum lengths, and current local values:

```js
assert.deepEqual(normalizeOperatorProfile({}), {
  displayName: '账号本人',
  role: '',
  aliases: [],
  brandName: 'Personal Digital Human',
  ownerLabel: '账号本人',
});
assert.deepEqual(normalizeOperatorProfile({
  displayName: ' 新用户 ', role: ' 产品经理 ', aliases: ['小新', '小新', ''], brandName: ' 新用户的数字人 ',
}), {
  displayName: '新用户', role: '产品经理', aliases: ['小新'], brandName: '新用户的数字人', ownerLabel: '新用户',
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node src/operator-profile.test.mjs`

Expected: FAIL because `src/operator-profile.mjs` does not exist.

- [ ] **Step 3: Implement the normalizer and load configuration**

Use bounded strings and deduplicated arrays. Add generic fields to `config.example.json`; set the ignored local config to the current operator values so this Mac retains its live identity after the refactor.

- [ ] **Step 4: Run focused tests and configuration validation**

Run: `node src/operator-profile.test.mjs && node scripts/check-config.mjs`

Expected: `OPERATOR_PROFILE_TEST_OK` and `CONFIG_OK`.

- [ ] **Step 5: Commit**

```bash
git add src/operator-profile.mjs src/operator-profile.test.mjs src/config.mjs config.example.json package.json
git commit -m "feat: configure digital human operator identity"
```

### Task 2: Remove Personal Identity from Production Prompts and UI

**Files:**
- Modify: `src/identity-policy.mjs`
- Modify: `src/identity-policy.test.mjs`
- Modify: `src/conversation-etiquette.mjs`
- Modify: `src/conversation-etiquette.test.mjs`
- Modify: `src/conversation-context.mjs`
- Modify: `src/conversation-context.test.mjs`
- Modify: `src/conversation-context-client.mjs`
- Modify: `src/reply-context.mjs`
- Modify: `src/reply-context.test.mjs`
- Modify: `src/privacy-boundary.mjs`
- Modify: `src/privacy-boundary.test.mjs`
- Modify: `src/bible.mjs`
- Modify: `src/bible.test.mjs`
- Modify: `src/index.mjs`
- Modify: `src/dashboard-server.mjs`
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `dashboard/index.html`
- Modify: `dashboard/i18n.js`
- Modify: `dashboard/i18n.test.mjs`
- Modify: `dashboard/app.js`
- Modify: `dashboard/visual-contract.test.mjs`
- Modify: `templates/PERSONA.example.md`
- Modify: `templates/BIBLE.example.md`

**Interfaces:**
- `buildIdentityInstruction(profile)` uses only the normalized profile plus generic safety rules.
- `buildFirstTakeoverGreeting({ ownerLabel })`, `buildPrivacyBoundary({ ownerLabel, ownerContactPhone })`, `formatConversationContext(context, { ownerLabel })`, and `new ReplyContextService({ contextClient, ownerLabel })` render the configured identity.
- Dashboard status returns `operator: { displayName, role, brandName }`; static HTML is generic before the first status response.

- [ ] **Step 1: Write failing consumer tests**

Add literal tests proving a fictional operator named `新用户` appears in greeting, privacy, identity, live-history style labels, reply instructions, and dashboard operator state while the old operator name does not.

```js
assert.match(buildFirstTakeoverGreeting({ ownerLabel: '新用户' }), /我是新用户的数字人/);
assert.doesNotMatch(buildFirstTakeoverGreeting({ ownerLabel: '新用户' }), /阿充/);
assert.match(buildPrivacyBoundary({ ownerLabel: '新用户' }), /不得代替新用户/);
assert.match(formatConversationContext(context, { ownerLabel: '新用户' }), /新用户在本会话中的表达风格/);
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node src/identity-policy.test.mjs && node src/conversation-etiquette.test.mjs && node src/conversation-context.test.mjs && node src/reply-context.test.mjs && node src/privacy-boundary.test.mjs && node src/dashboard-model.test.mjs && node dashboard/visual-contract.test.mjs`

Expected: FAIL on missing profile parameters or old hardcoded labels.

- [ ] **Step 3: Implement dynamic production consumers**

Replace production hardcodes with normalized profile fields. Keep identity tombstones as local Persona/config data rather than a baked-in personal identity. Make dashboard static copy generic and update it from status data after load. Preserve the current Mac appearance through ignored local config only.

- [ ] **Step 4: Verify focused behavior and production privacy scan**

Run focused tests, then:

```bash
git grep -n -E 'fengzhouchong|\u51af\u5468\u5145|\u963f\u5145James|/Users/fengzhouchong' -- 'src/**' 'dashboard/**' 'templates/**' ':!**/*.test.mjs'
```

Expected: focused tests PASS; production scan returns no matches.

- [ ] **Step 5: Commit**

```bash
git add src dashboard templates package.json
git commit -m "refactor: make distributed identity user-configurable"
```

### Task 3: Portable Original-DWS Runtime

**Files:**
- Modify: `src/conversation-context-client.mjs`
- Modify: `src/conversation-context-client.test.mjs`
- Modify: `src/config.mjs`
- Modify: `src/im-channels.mjs`
- Modify: `src/im-channels.test.mjs`

**Interfaces:**
- Produces: `isSupportedDwsExecutable(path) -> boolean` accepting standard absolute `dws` locations such as `/opt/homebrew/bin/dws` and the current npm-global path.
- Continues to reject Wukong/synthetic paths and any transport other than `event-stream` for live history.

- [ ] **Step 1: Add a failing portability test**

Instantiate `ConversationContextClient` with `/opt/homebrew/bin/dws`, a valid event-stream response, and assert the read succeeds. Keep explicit rejection fixtures for a Wukong path and `wukong-polling`.

- [ ] **Step 2: Run and verify RED**

Run: `node src/conversation-context-client.test.mjs`

Expected: FAIL with `DWS_PATH_REJECTED` for `/opt/homebrew/bin/dws`.

- [ ] **Step 3: Implement portable validation**

Require an absolute executable path whose basename is `dws`; reject paths containing Wukong-specific or synthetic `.real/.bin/dws/bin` segments. Continue injecting configured `DWS_CHANNEL` only into each DWS child process, never shell profiles.

- [ ] **Step 4: Run focused tests**

Run: `node src/conversation-context-client.test.mjs && node src/im-channels.test.mjs`

Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add src/conversation-context-client.mjs src/conversation-context-client.test.mjs src/config.mjs src/im-channels.mjs src/im-channels.test.mjs
git commit -m "fix: support portable original DWS installations"
```

### Task 4: Safe Distribution Defaults and AI Coding Guide

**Files:**
- Create: `config.distribution.json`
- Create: `AI_CODING_INSTALL.md`
- Modify: `scripts/setup.sh`
- Modify: `scripts/check-config.mjs`
- Create: `scripts/distribution-defaults.test.mjs`
- Modify: `package.json`

**Interfaces:**
- `config.distribution.json` is a complete valid fail-closed configuration.
- `scripts/setup.sh` accepts `AIPRO_CONFIG_TEMPLATE` and no longer requires Feishu tooling when Feishu is disabled.
- The guide exposes exactly one installation command and explicit OAuth/privacy boundaries.

- [ ] **Step 1: Write the failing safe-default test**

Load the distribution JSON and assert literal false values for all channels/external writes, `allowAllChats=false`, `authorizedChatIds=['__SETUP_REQUIRED__']`, empty identity IDs, and `aiRuntime='auto'`. Run setup in a temporary directory without `lark-cli` and expect success while Feishu is disabled.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/distribution-defaults.test.mjs`

Expected: FAIL because the distribution template is absent and setup requires `lark-cli` unconditionally.

- [ ] **Step 3: Implement safe defaults and guide**

Create the complete template and concise guide. Update setup to choose the distribution template when requested, create a local `.venv`, and avoid global dependency writes.

- [ ] **Step 4: Run focused validation**

Run: `node scripts/distribution-defaults.test.mjs && DIGITAL_EMPLOYEE_CONFIG=$PWD/config.distribution.json node scripts/check-config.mjs`

Expected: safe-default test and config validation PASS.

- [ ] **Step 5: Commit**

```bash
git add config.distribution.json AI_CODING_INSTALL.md scripts/setup.sh scripts/check-config.mjs scripts/distribution-defaults.test.mjs package.json
git commit -m "feat: add safe AI Coding installation defaults"
```

### Task 5: Explicit-Allowlist Package Builder and Privacy Scanner

**Files:**
- Create: `scripts/distribution-package.mjs`
- Create: `scripts/distribution-package.test.mjs`
- Create: `scripts/build-aicoding-package.mjs`
- Modify: `.gitignore`
- Modify: `package.json`

**Interfaces:**
- `distributionFileList(root) -> string[]` returns production files only and excludes tests/docs/local state.
- `scanDistribution(root, { forbiddenValues }) -> { ok, violations }` checks forbidden paths, suffixes, local config values, personal absolute paths, secrets, and private artifacts without printing secret values.
- `buildDistribution({ root, outputDir, version }) -> { directory, archive, sha256, fileCount, bytes }` stages payload, manifest, checksums, and ZIP.

- [ ] **Step 1: Write failing builder tests**

Use a real temporary fixture tree. Assert that allowed production files are copied, forbidden paths and a synthetic secret make the build fail, a clean tree produces deterministic manifest entries, and the final ZIP never includes `.git`, config local, Persona, knowledge catalogs, tests, docs, data, logs, or recovery files.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/distribution-package.test.mjs`

Expected: FAIL because package helpers do not exist.

- [ ] **Step 3: Implement allowlist, scanner, manifest, checksums, and ZIP**

Use Node built-ins for filesystem walking, copies, JSON, and SHA-256. Invoke `/usr/bin/ditto -c -k --sequesterRsrc --keepParent` only after scans pass. Add `dist/` to `.gitignore` and `npm run package:aicoding`.

- [ ] **Step 4: Run focused tests and build once**

Run: `node scripts/distribution-package.test.mjs && npm run package:aicoding`

Expected: tests PASS and the command prints a ZIP path, file count, byte count, and SHA-256 without exposing excluded values.

- [ ] **Step 5: Commit**

```bash
git add scripts/distribution-package.mjs scripts/distribution-package.test.mjs scripts/build-aicoding-package.mjs .gitignore package.json
git commit -m "feat: build privacy-clean AI Coding packages"
```

### Task 6: Idempotent One-Command Installer

**Files:**
- Create: `install.command`
- Create: `scripts/install-aicoding.mjs`
- Create: `scripts/install-aicoding.test.mjs`
- Modify: `scripts/install-service.sh`
- Modify: `scripts/install-dashboard-service.sh`
- Modify: `package.json`

**Interfaces:**
- `install.command` locates Node >=22.5 and invokes payload `scripts/install-aicoding.mjs`.
- Installer supports production defaults plus test-only environment overrides: `ACHONG_INSTALL_ROOT`, `ACHONG_INSTALL_HOME`, `ACHONG_LAUNCHCTL`, `ACHONG_SKIP_DEPENDENCIES=1`, and `ACHONG_SKIP_OPEN=1`.
- A successful install prints `INSTALL_OK`, installation root, dashboard URL, and next authorization step.

- [ ] **Step 1: Write failing installation tests**

Build a fixture package and run the real installer against a temporary HOME with a launchctl recorder. Verify first install, checksum rejection, safe config creation, idempotent rerun, preservation of local config/Persona/Bible/data, correct plist paths, and rollback when the launchctl stub fails.

- [ ] **Step 2: Run and verify RED**

Run: `node scripts/install-aicoding.test.mjs`

Expected: FAIL because installer files do not exist.

- [ ] **Step 3: Implement bootstrap and installer**

Stage upgrades next to the target directory, verify checksums before copying, preserve user-owned files, install dependencies before switching, register only the two expected LaunchAgents, validate dashboard loopback health, and restore the previous installation on post-switch failure.

- [ ] **Step 4: Run installer and existing service tests**

Run: `node scripts/install-aicoding.test.mjs && npm run test:install-service`

Expected: installer acceptance and existing LaunchAgent tests PASS.

- [ ] **Step 5: Commit**

```bash
git add install.command scripts/install-aicoding.mjs scripts/install-aicoding.test.mjs scripts/install-service.sh scripts/install-dashboard-service.sh package.json
git commit -m "feat: install digital human from one AI Coding command"
```

### Task 7: Isolated Package Acceptance and Final Artifact

**Files:**
- Create: `docs/testing/2026-08-03-aicoding-package-regression.md`
- Modify: `docs/superpowers/specs/2026-08-03-aicoding-macos-distribution-design.md`

**Interfaces:**
- Consumes the final ZIP from `npm run package:aicoding`.
- Produces delivery evidence: archive path, SHA-256, file count, byte count, privacy scan result, isolated installation result, and application health.

- [ ] **Step 1: Run the complete repository gates**

Run: `npm run check && npm test && npm run test:install-service`

Expected: all commands exit 0; mechanism acceptance has 0 failures.

- [ ] **Step 2: Build and inspect the final archive**

Run: `npm run package:aicoding`, extract the printed ZIP to a fresh temporary directory, run the privacy scanner again on extracted contents, and compare the archive SHA-256 with `SHA256SUMS`.

- [ ] **Step 3: Execute isolated install acceptance**

From the extracted root, run `zsh ./install.command` with a test-only HOME, destination, launchctl stub, dependency skip, and browser-open skip. Verify `INSTALL_OK`, safe default config, preserved upgrade files, and exactly two service registrations. No real IM message or 1A mutation is allowed.

- [ ] **Step 4: Verify the current live installation did not regress**

Run: `npm run health` in the original workspace and confirm `healthy=true`, `issues=[]`, DingTalk connected/authenticated, Feishu disabled, Codex selected, and 1A pending/dead counts zero.

- [ ] **Step 5: Write the regression report and commit**

Record passed, failed-then-fixed, and unexecuted cases without secrets.

```bash
git add docs/testing/2026-08-03-aicoding-package-regression.md docs/superpowers/specs/2026-08-03-aicoding-macos-distribution-design.md
git commit -m "docs: record AI Coding package acceptance"
```

- [ ] **Step 6: Final cleanliness**

Run: `git status --short && shasum -a 256 dist/*.zip`

Expected: tracked worktree clean; exactly one current distribution ZIP is reported with its checksum.
