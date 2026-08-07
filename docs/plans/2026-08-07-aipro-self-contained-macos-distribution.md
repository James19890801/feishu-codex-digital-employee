# AIPRO Self-Contained macOS Distribution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build shareable Apple Silicon and Intel DMGs that run AIPRO without a source checkout or system Node installation and open directly into a local identity/IM configuration experience.

**Architecture:** Keep application resources immutable inside `AIPRO.app`, run the existing Node services with the bundled Node binary, and move configuration/data/logs to `~/Library/Application Support/AIPRO`. The native Swift launcher performs idempotent bootstrap and LaunchAgent repair, while the existing dashboard and core message pipeline remain intact.

**Tech Stack:** Swift/AppKit/WebKit, Node.js ESM, pnpm, launchd, zsh, hdiutil, Node test runner style assertion scripts.

---

### Task 1: Separate immutable application resources from mutable user state

**Files:**
- Modify: `src/config.mjs`
- Modify: `src/dashboard-server.mjs`
- Modify: `src/index.mjs`
- Modify: `src/wechat-poc/worker.mjs`
- Test: `src/config-paths.test.mjs`
- Modify: `package.json`

**Step 1: Write the failing test**

Create `src/config-paths.test.mjs`. Spawn Node with a temporary `AIPRO_HOME`, `AIPRO_RESOURCE_ROOT`, and `DIGITAL_EMPLOYEE_CONFIG`, then assert exported `config.workdir` points to mutable state and `config.resourceRoot` points to immutable resources.

**Step 2: Run test to verify it fails**

Run: `node src/config-paths.test.mjs`
Expected: FAIL because `config.resourceRoot` does not exist and `workdir` still resolves from `src/`.

**Step 3: Write minimal implementation**

In `src/config.mjs`, derive paths as follows:

```js
const resourceRoot = resolve(process.env.AIPRO_RESOURCE_ROOT || resolve(srcDir, '..'));
const workdir = resolve(process.env.AIPRO_HOME || resourceRoot);
const configPath = process.env.DIGITAL_EMPLOYEE_CONFIG || join(workdir, 'config.local.json');
```

Export both on `config`. Use `config.resourceRoot` for bundled scripts, dashboard assets, Python extractor, and JXA resources. Continue using `config.workdir` for configuration, Persona, Bible, catalog, data, logs, artifacts, and process cwd.

**Step 4: Run focused and existing tests**

Run: `node src/config-paths.test.mjs && node src/config-store.test.mjs && node src/runtime-mode.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add src/config.mjs src/dashboard-server.mjs src/index.mjs src/wechat-poc/worker.mjs src/config-paths.test.mjs package.json
git commit -m "refactor: separate AIPRO resources from user state"
```

### Task 2: Add idempotent macOS bootstrap and service installation

**Files:**
- Create: `macos/AIPRO/AIPROBootstrap.swift`
- Modify: `macos/AIPRO/AIPRO.swift`
- Modify: `macos/AIPRO/app-bundle.test.mjs`
- Modify: `scripts/install-aipro-macos-app.sh`

**Step 1: Extend the failing app-bundle test**

Assert that the Swift launcher references `Application Support/AIPRO`, embedded `Resources/runtime/bin/node`, embedded `Resources/app`, both LaunchAgent labels, and environment variables `AIPRO_HOME`, `AIPRO_RESOURCE_ROOT`, and `DIGITAL_EMPLOYEE_CONFIG`. Assert the old browser auto-exit path is absent.

**Step 2: Run test to verify it fails**

Run: `node macos/AIPRO/app-bundle.test.mjs`
Expected: FAIL on missing bootstrap behavior.

**Step 3: Implement bootstrap**

`AIPROBootstrap` must:

- resolve bundle resources and `~/Library/Application Support/AIPRO`;
- create the support directory with user-only permissions;
- copy only missing defaults for `config.local.json`, `PERSONA.md`, `BIBLE.md`, and `knowledge-catalog.json`;
- generate dashboard and core LaunchAgent plists atomically;
- point both agents at bundled Node and bundled JS entry points;
- write logs to the support directory;
- bootout stale agents, bootstrap new plists, and kickstart the dashboard;
- defer the core service until at least one usable runtime and one configured channel are available;
- return stage-specific errors for the launcher UI.

Update `AIPRO.swift` to run bootstrap before probing, keep the dashboard inside WKWebView, and retain a manual “Open in Browser” menu item.

**Step 4: Compile and test**

Run:

```bash
node macos/AIPRO/app-bundle.test.mjs
xcrun swiftc -parse-as-library -typecheck macos/AIPRO/AIPROBootstrap.swift macos/AIPRO/AIPRO.swift
```

Expected: PASS.

**Step 5: Commit**

```bash
git add macos/AIPRO/AIPROBootstrap.swift macos/AIPRO/AIPRO.swift macos/AIPRO/app-bundle.test.mjs scripts/install-aipro-macos-app.sh
git commit -m "feat: bootstrap self-contained AIPRO services"
```

### Task 3: Add first-run identity selection without changing channel semantics

**Files:**
- Modify: `dashboard/index.html`
- Modify: `dashboard/app.js`
- Modify: `dashboard/styles.css`
- Modify: `dashboard/i18n.js`
- Create: `dashboard/identity-focus.js`
- Create: `dashboard/identity-focus.test.mjs`
- Modify: `dashboard/visual-contract.test.mjs`

**Step 1: Write failing identity-focus tests**

Test a pure `normalizeIdentityFocus` function and channel visibility mapping:

```js
assert.equal(normalizeIdentityFocus('human'), 'human');
assert.deepEqual(visibleChannels('bot'), ['wecom']);
assert.ok(visibleChannels('both').includes('feishu'));
assert.ok(visibleChannels('both').includes('wecom'));
```

**Step 2: Run test to verify it fails**

Run: `node dashboard/identity-focus.test.mjs`
Expected: FAIL because module does not exist.

**Step 3: Implement the presentation layer**

Add a compact first-run chooser for “真人身份”, “机器人身份”, and “两者都用”. Store only this presentation preference in local storage; do not rewrite channel credentials or identity claims. Filter/highlight channel cards using explicit channel metadata and allow switching at any time.

**Step 4: Run dashboard tests**

Run: `node dashboard/identity-focus.test.mjs && node dashboard/i18n.test.mjs && node dashboard/visual-contract.test.mjs`
Expected: PASS.

**Step 5: Commit**

```bash
git add dashboard/index.html dashboard/app.js dashboard/styles.css dashboard/i18n.js dashboard/identity-focus.js dashboard/identity-focus.test.mjs dashboard/visual-contract.test.mjs
git commit -m "feat: add human and bot identity setup focus"
```

### Task 4: Build a deterministic self-contained app bundle

**Files:**
- Create: `scripts/build-macos-distribution.sh`
- Create: `scripts/macos-distribution.test.mjs`
- Create: `macos/AIPRO/config.first-run.json`
- Modify: `package.json`
- Modify: `.gitignore`

**Step 1: Write the failing packaging contract test**

The test reads the build script and asserts:

- explicit `arm64` and `x64` targets;
- Node archive checksum verification;
- an allowlist payload copy;
- production-only dependency deployment;
- exclusion of `config.local.json`, `data`, logs, outputs, and private files;
- ad-hoc deep signing and `hdiutil` DMG creation;
- architecture verification with `lipo` or `file`.

**Step 2: Run test to verify it fails**

Run: `node scripts/macos-distribution.test.mjs`
Expected: FAIL because the build script does not exist.

**Step 3: Implement build script**

The script accepts `--arch arm64|x64|all`, `--node-version`, and `--output`. For each architecture it downloads the official Node macOS tarball (or uses a supplied cache), verifies it against the official `SHASUMS256.txt`, stages an allowlisted production payload, compiles Swift for the target architecture, embeds runtime and defaults, signs nested executables and the app ad hoc, validates the bundle, and creates `AIPRO-mac-<arch>.dmg`.

`config.first-run.json` disables all channels, keeps `allowAllChats` true, selects runtime `auto`, and contains no credential placeholders that make startup fail.

**Step 4: Run contract test and build the native artifact**

Run:

```bash
node scripts/macos-distribution.test.mjs
./scripts/build-macos-distribution.sh --arch arm64 --output dist
```

Expected: test PASS and `dist/AIPRO-mac-arm64.dmg` exists.

**Step 5: Inspect package contents**

Mount the DMG read-only, confirm the embedded Node and launcher are arm64, confirm required resources exist, and confirm forbidden files are absent.

**Step 6: Commit**

```bash
git add scripts/build-macos-distribution.sh scripts/macos-distribution.test.mjs macos/AIPRO/config.first-run.json package.json .gitignore
git commit -m "feat: build self-contained AIPRO macOS DMGs"
```

### Task 5: Validate clean-install startup and recovery behavior

**Files:**
- Create: `scripts/macos-clean-install-smoke.sh`
- Modify: `macos/AIPRO/app-bundle.test.mjs`
- Modify: `README`

**Step 1: Add failing smoke-test contract**

Require a temporary support directory override so the built app can be tested without touching the developer's live AIPRO data or LaunchAgents. Assert first run creates only the four defaults plus data/log state and a second run preserves modified Persona and config content.

**Step 2: Run to verify failure**

Run: `AIPRO_APP_BUNDLE=<staged-app> ./scripts/macos-clean-install-smoke.sh`
Expected: FAIL until the override and bootstrap inspection mode exist.

**Step 3: Implement safe smoke mode**

Add environment-driven support-root and LaunchAgent-directory overrides accepted only when an explicit test flag is set. The smoke script uses `mktemp -d`, never unloads or overwrites the developer's live service labels, and cleans up only its validated temporary directory.

**Step 4: Run clean-install smoke and regression tests**

Run:

```bash
AIPRO_APP_BUNDLE=<staged-app> ./scripts/macos-clean-install-smoke.sh
pnpm test
pnpm run check
```

Expected: PASS.

**Step 5: Update documentation**

Document free DMG installation, the one-time Privacy & Security “Open Anyway” step, Apple Silicon/Intel package choice, data location, runtime auto-detection, log access, and future Developer ID notarization.

**Step 6: Commit**

```bash
git add scripts/macos-clean-install-smoke.sh macos/AIPRO/app-bundle.test.mjs README
git commit -m "test: verify clean AIPRO macOS installation"
```

### Task 6: Final distribution verification

**Files:**
- Verify only; no expected source changes

**Step 1: Run targeted tests**

Run all new path, launcher, identity, and packaging tests.
Expected: PASS.

**Step 2: Run project verification**

Run: `pnpm test && pnpm run check`
Expected: PASS.

**Step 3: Build both distributions**

Run: `./scripts/build-macos-distribution.sh --arch all --output dist`
Expected: both architecture-specific DMGs are created and verified.

**Step 4: Record hashes**

Run: `shasum -a 256 dist/AIPRO-mac-arm64.dmg dist/AIPRO-mac-x64.dmg`
Expected: two SHA-256 lines suitable for the download page.

**Step 5: Review repository state**

Confirm no secrets, generated app bundles, DMGs, local data, or unrelated user changes were committed.

