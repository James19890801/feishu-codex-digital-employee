# Secure Multimodal Capability Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port GitHub commit `cf66cfc` into the current James code line, verify secure image, document, audio, video, and web understanding, and publish the verified change to `codeup/master` without including unrelated local edits.

**Architecture:** Add two isolated helper modules for media command construction and public web reading, extend channel normalization to retain downloadable media metadata, and orchestrate bounded downloads and content extraction in `src/index.mjs`. Capability readiness is computed in the dashboard from executable availability and configuration. The local branch and Codeup remain separate histories; Codeup receives the verified patch as a normal descendant commit.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`-style assertion scripts, `undici`, Python 3 file extraction, Swift/Speech/AVFoundation on macOS 26+, DWS and lark CLI media downloads, Git worktrees.

## Global Constraints

- Preserve `src/human-takeover.mjs`, `src/human-takeover.test.mjs`, and `docs/AIPRO产品与技术全景介绍.md` exactly as user-owned uncommitted work.
- Do not force-push GitHub or Codeup.
- Keep all media handling actor-bound to the existing sender, chat, owner, self-chat, blocklist, and human-takeover policies.
- Store downloaded media only in workspace-local private temporary directories and delete it in a `finally` path.
- Reject symlinks, non-regular files, empty files, and files larger than the existing `MAX_FILE_BYTES` limit.
- Never execute a shell to transcribe audio; only invoke a fixed executable with an explicit `{input}` argument placeholder.
- The current machine is macOS 15.5. Do not claim Apple on-device transcription works unless a compatible executable is installed and a live transcription succeeds.
- Codeup publication must be a fast-forward descendant of the existing `codeup/master` commit.

---

### Task 1: Pure multimodal command and parsing boundaries

**Files:**
- Create: `src/multimodal-content.test.mjs`
- Create: `src/multimodal-content.mjs`

**Interfaces:**
- Produces: `parseDingTalkMediaPlaceholder(content): {kind, resourceId, displayName} | null`
- Produces: `buildDingTalkMediaDownloadArgs(options): string[]`
- Produces: `buildFeishuMediaDownloadArgs(options): string[]`
- Produces: `buildTranscriptionInvocation(options): {command: string, args: string[]}`
- Produces: `mediaFileExtension(kind, sourceName): string`

- [ ] **Step 1: Add the upstream helper contract tests**

Port `src/multimodal-content.test.mjs` from `cf66cfc`, preserving assertions for DingTalk placeholders, DWS arguments, safe relative Feishu output paths, shell rejection, `{input}` replacement, and extensions.

```bash
git show cf66cfc:src/multimodal-content.test.mjs
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node src/multimodal-content.test.mjs`

Expected: failure with `ERR_MODULE_NOT_FOUND` for `src/multimodal-content.mjs`.

- [ ] **Step 3: Add the minimal pure helper implementation**

Implement the five interfaces with structured argument arrays. Reject `sh`, `bash`, `zsh`, `fish`, `cmd`, `powershell`, `pwsh`, `-c`, `/c`, and `--command`. Require Feishu output paths to be relative and contain no `..` component.

```js
const DINGTALK_MEDIA_KIND = new Map([
  ['图片', 'image'], ['语音', 'audio'], ['音频', 'audio'], ['视频', 'video'],
]);

export function buildTranscriptionInvocation({ command, args = [], inputPath } = {}) {
  const executable = String(command || '').trim();
  const input = String(inputPath || '').trim();
  if (!executable || !input) throw new Error('Transcription command and input are required');
  const commandName = basename(executable).toLowerCase();
  if (['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'].includes(commandName)
    || args.some(value => ['-c', '/c', '--command'].includes(String(value).toLowerCase()))) {
    throw new Error('Shell execution is not allowed for audio transcription');
  }
  const normalizedArgs = args.map(value => String(value).replaceAll('{input}', input));
  if (!normalizedArgs.some(value => value.includes(input))) {
    throw new Error('Transcription arguments must contain the {input} placeholder');
  }
  return { command: executable, args: normalizedArgs };
}
```

- [ ] **Step 4: Run the focused test**

Run: `node src/multimodal-content.test.mjs`

Expected: `MULTIMODAL_CONTENT_TEST_OK`.

- [ ] **Step 5: Commit the unit**

```bash
git add src/multimodal-content.mjs src/multimodal-content.test.mjs
git commit -m "feat: add secure multimodal command helpers"
```

### Task 2: SSRF-resistant public web reader

**Files:**
- Create: `src/web-reader.test.mjs`
- Create: `src/web-reader.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `isPublicAddress(address): boolean`
- Produces: `extractHttpUrls(text, limit): string[]`
- Produces: `extractReadableWebText(html, maxChars): string`
- Produces: `createPinnedLookup(records): Function`
- Produces: `readPublicWebPage(url, options): Promise<{url,title,contentType,text}>`

- [ ] **Step 1: Add web-reader contract tests**

Port the upstream test file and retain real assertions for public/private IPv4 and IPv6, URL deduplication, punctuation trimming, HTML cleanup, pinned DNS results, and a bounded fake fetch response.

```bash
git show cf66cfc:src/web-reader.test.mjs
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `node src/web-reader.test.mjs`

Expected: failure with `ERR_MODULE_NOT_FOUND` for `src/web-reader.mjs`.

- [ ] **Step 3: Implement the bounded reader**

Port `src/web-reader.mjs` from `cf66cfc`. Keep the allowed content types limited to HTML, XHTML, plain text, and JSON. Validate every DNS result, pin the socket lookup to validated addresses, cap redirects at 3, bytes at 2 MiB, readable text at 40,000 characters, and timeout at 12 seconds. The complete source file is the implementation reference:

```bash
git show cf66cfc:src/web-reader.mjs
```

- [ ] **Step 4: Register and run focused and combined tests**

Add `test:multimodal` to `package.json` as `node src/multimodal-content.test.mjs && node src/web-reader.test.mjs`.

Run: `node src/web-reader.test.mjs && npm run test:multimodal`

Expected: `WEB_READER_TEST_OK` and `MULTIMODAL_CONTENT_TEST_OK`.

- [ ] **Step 5: Commit the unit**

```bash
git add src/web-reader.mjs src/web-reader.test.mjs package.json
git commit -m "feat: add bounded public web reader"
```

### Task 3: Preserve media through Feishu and DingTalk normalization

**Files:**
- Modify: `src/polling.test.mjs`
- Modify: `src/polling.mjs`
- Modify: `src/im-channels.test.mjs`
- Modify: `src/im-channels.mjs`

**Interfaces:**
- Consumes: `parseDingTalkMediaPlaceholder(content)` from Task 1.
- Produces: normalized Feishu image/file/audio/media message content.
- Produces: `metadata.media = {kind, resourceId, messageId, conversationId}` for DingTalk.

- [ ] **Step 1: Add Feishu media polling tests**

Add the upstream `directImage` and `directFile` fixtures. Assert `selectInboundMessages` retains media types and `normalizeSearchMessage` produces `image_key`, `file_key`, and `file_name` JSON.

```js
assert.deepEqual(JSON.parse(normalizeSearchMessage(directImage).message.content), {
  image_key: 'img_v3_abc123',
});
assert.deepEqual(JSON.parse(normalizeSearchMessage(directFile).message.content), {
  file_key: 'file_v3_xyz', file_name: '产品说明.pdf',
});
```

- [ ] **Step 2: Run polling tests and confirm RED**

Run: `node src/polling.test.mjs`

Expected: media selection or normalized content assertions fail.

- [ ] **Step 3: Implement Feishu normalization**

Allow `text`, `post`, `image`, `file`, `audio`, and `media`. Parse `[Image: key]`, `<img key="...">`, and `<file|audio|media key="..." name="...">` into the channel-neutral payload while preserving actor and chat metadata.

- [ ] **Step 4: Run polling tests and confirm GREEN**

Run: `node src/polling.test.mjs`

Expected: `POLLING_TEST_OK`.

- [ ] **Step 5: Add DingTalk image and voice normalization tests**

Assert both event-stream and list-all polling inputs retain the resource ID and original conversation/message identifiers.

```js
assert.deepEqual(payload.metadata.media, {
  kind: 'audio', resourceId: '@voice_123',
  messageId: 'msg-voice', conversationId: 'cid-direct',
});
```

- [ ] **Step 6: Run channel tests and confirm RED**

Run: `node src/im-channels.test.mjs`

Expected: media messages are filtered or remain `message_type: 'text'`.

- [ ] **Step 7: Implement DingTalk media metadata preservation**

Import `parseDingTalkMediaPlaceholder`, normalize media content to `{text:'', resource_id, display_name}`, set the message type to the parsed kind, and attach `metadata.media` without changing sender, self-chat, or mention authorization.

- [ ] **Step 8: Run both suites and commit**

Run: `node src/polling.test.mjs && node src/im-channels.test.mjs`

Expected: both suites pass.

```bash
git add src/polling.mjs src/polling.test.mjs src/im-channels.mjs src/im-channels.test.mjs
git commit -m "feat: retain inbound media metadata"
```

### Task 4: Configuration, capability readiness, and macOS helper

**Files:**
- Modify: `config.example.json`
- Modify: `config.distribution.json`
- Modify: `src/config.mjs`
- Modify: `src/licensing/config.test.mjs`
- Modify: `src/dashboard-model.test.mjs`
- Modify: `src/dashboard-model.mjs`
- Modify: `src/dashboard-server.mjs`
- Modify: `dashboard/visual-contract.test.mjs`
- Modify: `dashboard/app.js`
- Create: `macos/James/JamesTranscribe.swift`
- Modify: `macos/James/app-bundle.test.mjs`
- Modify: `scripts/install-james-macos-app.sh`
- Modify: `scripts/verify.sh`

**Interfaces:**
- Produces config: `webReaderEnabled`, `webReaderMaxUrls`, `audioTranscriptionCommand`, `audioTranscriptionArgs`.
- Produces per-channel readiness: `{text,image,audio,link}`.
- Produces optional app executable: `~/Applications/James.app/Contents/MacOS/JamesTranscribe` on macOS 26+ SDKs.

- [ ] **Step 1: Add failing configuration and dashboard assertions**

Port the upstream config and dashboard tests, adapting `AIPRO` paths to `James`. Add distribution defaults for `webReaderEnabled: true`, `webReaderMaxUrls: 2`, empty `audioTranscriptionCommand`, and `['{input}','zh-CN']` arguments.

```js
assert.equal(view.channels.feishu.capabilities.audio, false);
assert.equal(view.channels.feishu.capabilities.link, true);
assert.equal(view.channels.dingtalk.capabilities.image, true);
```

- [ ] **Step 2: Run focused tests and confirm RED**

Run: `node src/licensing/config.test.mjs && node src/dashboard-model.test.mjs && node dashboard/visual-contract.test.mjs && node macos/James/app-bundle.test.mjs`

Expected: missing config fields, capability objects, and helper wiring.

- [ ] **Step 3: Implement config and readiness**

Bound `webReaderMaxUrls` to 1–3; cap transcription args at 20 strings. Default the helper path to `~/Applications/James.app/Contents/MacOS/JamesTranscribe`. Report audio readiness only when the fixed executable exists, and link readiness only when the reader is enabled.

- [ ] **Step 4: Add and safely install the Apple helper**

Adapt upstream `AIPROTranscribe.swift` to `JamesTranscribe.swift`. In `install-james-macos-app.sh`, compile it only when the active SDK major version is 26 or newer; otherwise install the James app without the helper and print a single explicit compatibility warning.

```zsh
SDK_MAJOR="$(/usr/bin/xcrun --show-sdk-version | /usr/bin/awk -F. '{print $1}')"
if [[ "$SDK_MAJOR" -ge 26 ]]; then
  /usr/bin/xcrun swiftc -parse-as-library -O \
    "$ROOT/macos/James/JamesTranscribe.swift" \
    -framework AVFoundation -framework Speech \
    -o "$BUNDLE/Contents/MacOS/JamesTranscribe"
  chmod 755 "$BUNDLE/Contents/MacOS/JamesTranscribe"
else
  echo "James audio transcription helper requires the macOS 26 SDK; skipping it." >&2
fi
```

Make bundle acceptance require `JamesTranscribe` only when `JAMES_EXPECT_TRANSCRIBER=1`.

- [ ] **Step 5: Implement dashboard display and conditional verification**

Render `文字/图片/语音/链接` readiness in each channel card. Typecheck `JamesTranscribe.swift` only on SDK 26+, while always checking its source and installer contract on older SDKs.

- [ ] **Step 6: Run focused tests and commit**

Run: `node src/licensing/config.test.mjs && node src/dashboard-model.test.mjs && node dashboard/visual-contract.test.mjs && node macos/James/app-bundle.test.mjs`

Expected: all pass, with audio readiness false on this machine.

```bash
git add config.example.json config.distribution.json src/config.mjs src/licensing/config.test.mjs src/dashboard-model.mjs src/dashboard-model.test.mjs src/dashboard-server.mjs dashboard/app.js dashboard/visual-contract.test.mjs macos/James/JamesTranscribe.swift macos/James/app-bundle.test.mjs scripts/install-james-macos-app.sh scripts/verify.sh
git commit -m "feat: expose multimodal capability readiness"
```

### Task 5: End-to-end media orchestration

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `README.md`

**Interfaces:**
- Consumes: all Task 1 and Task 2 helpers.
- Consumes: channel `metadata.media` from Task 3.
- Produces: bounded image attachments, document text, audio transcripts, video frame/transcript context, web-page context, audit events, and user-visible degraded responses.

- [ ] **Step 1: Add mechanism assertions before orchestration**

Extend mechanism acceptance to assert imports and call sites for `buildDingTalkMediaDownloadArgs`, `buildFeishuMediaDownloadArgs`, `buildTranscriptionInvocation`, `readPublicWebPage`, regular-file validation, and `finally` cleanup.

```js
assert.match(indexSource, /buildDingTalkMediaDownloadArgs/);
assert.match(indexSource, /buildTranscriptionInvocation/);
assert.match(indexSource, /readPublicWebPage/);
assert.match(indexSource, /lstat\(filePath\)/);
```

- [ ] **Step 2: Run mechanism acceptance and confirm RED**

Run: `node src/mechanism-acceptance.test.mjs`

Expected: missing multimodal orchestration assertions fail.

- [ ] **Step 3: Port imports, message parsing, and task selection**

Adapt the `src/index.mjs` diff from `cf66cfc^..cf66cfc` to the current 33-commit-newer file. Preserve all newer A1, Alibaba-language, conversation-context, blocklist, and human-takeover paths. Accept Feishu audio resources and DingTalk `metadata.media`; do not relax the supported actor/channel checks.

- [ ] **Step 4: Add secure download and transformation helpers**

Within the existing message handler, add `ensureTempDir`, `assertMediaFile`, and `transcribeAudio`. Use `runBufferedProcess` with fixed executables, bounded stdout/stderr, timeouts, and current channel environments. Feed only verified image paths and bounded extracted/transcribed text to the runtime.

- [ ] **Step 5: Add video, web, audit, and cleanup flows**

Use `/usr/bin/qlmanage` for a bounded video thumbnail attempt. Treat web content as untrusted context. Audit successful downloads and degraded transcription/thumbnail/web failures. Keep cleanup in the existing `finally` block.

- [ ] **Step 6: Update public behavior documentation**

Adapt the upstream README sections to James naming, explicitly documenting supported channels, file types, security limits, and the macOS 26 speech-helper requirement.

- [ ] **Step 7: Run focused suites and commit**

Run: `npm run test:multimodal && node src/polling.test.mjs && node src/im-channels.test.mjs && node src/mechanism-acceptance.test.mjs && node --check src/index.mjs`

Expected: all commands exit 0.

```bash
git add src/index.mjs src/mechanism-acceptance.test.mjs README.md
git commit -m "feat: understand secure multimodal messages"
```

### Task 6: Local full verification and acceptance record

**Files:**
- Create: `docs/testing/2026-08-04-secure-multimodal-sync.md`

**Interfaces:**
- Produces: an evidence record separating automated coverage from live media acceptance.

- [ ] **Step 1: Run complete automated verification**

Run:

```bash
npm run test:multimodal
npm test
npm run check
node scripts/install-aicoding.test.mjs
node scripts/distribution-package.test.mjs
node scripts/dws-deployment-policy.test.mjs
git diff --check HEAD~4..HEAD
```

Expected: every command exits 0. If an unrelated pre-existing failure occurs, preserve its exact output and do not claim the suite passed.

- [ ] **Step 2: Verify scope and user-owned changes**

Run:

```bash
git status --short
git diff -- src/human-takeover.mjs src/human-takeover.test.mjs docs/AIPRO产品与技术全景介绍.md
git diff --name-status b93a0e2..HEAD
```

Expected: the three user-owned files remain unstaged; the feature commits contain only approved design, plan, multimodal code, tests, tooling, and public docs.

- [ ] **Step 3: Record evidence and commit**

Write the exact command results, pass/fail counts, macOS/SDK versions, and the explicit statement that live Apple transcription was not accepted on macOS 15.5.

```bash
git add docs/testing/2026-08-04-secure-multimodal-sync.md
git commit -m "docs: record multimodal sync verification"
```

### Task 7: Publish the verified patch to Codeup

**Files:**
- Modify in temporary worktree: the verified files changed by Tasks 1–6 that are appropriate for the internal repository.

**Interfaces:**
- Consumes: local verified commit range beginning after `76c2ca6`.
- Produces: a normal descendant commit on `codeup/master` and remote readback evidence.

- [ ] **Step 1: Refresh and validate the release target**

Run:

```bash
git fetch --prune codeup
git rev-parse codeup/master
git diff --quiet 22197b3 codeup/master
```

Expected: Codeup still points at the inspected release base and its tree matches the prior local release snapshot. If it changed, stop publication and recompute the patch against the new remote head.

- [ ] **Step 2: Create an isolated Codeup worktree**

Use `superpowers:using-git-worktrees` and create a temporary branch based on the refreshed `codeup/master`.

```bash
MULTIMODAL_WORKTREE="$(mktemp -d /tmp/james-codeup-multimodal.XXXXXX)"
git worktree add "$MULTIMODAL_WORKTREE" -b codex/codeup-multimodal-sync codeup/master
git -C "$MULTIMODAL_WORKTREE" status --short --branch
```

- [ ] **Step 3: Apply only the verified committed range**

Cherry-pick the committed local sync range, including its design, plan, tests, production code, installer changes, README, and verification report. The three user-owned dirty files and local configuration/data are absent from this range.

```bash
git -C "$MULTIMODAL_WORKTREE" cherry-pick 76c2ca6^..agent/aipro-commercial-platform-upgrade
```

- [ ] **Step 4: Verify Codeup worktree from scratch**

Install exactly the lockfile dependency graph, then run the release checks:

```bash
cd "$MULTIMODAL_WORKTREE"
pnpm install --frozen-lockfile
npm run test:multimodal
npm test
npm run check
node scripts/distribution-package.test.mjs
node scripts/dws-deployment-policy.test.mjs
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Push the verified cherry-picked commits to Codeup**

```bash
git push codeup HEAD:master
```

Expected: a fast-forward push succeeds.

- [ ] **Step 6: Read back the remote and clean up**

Run:

```bash
git fetch codeup master
git rev-parse codeup/master
git show --stat --oneline codeup/master
```

Expected: `codeup/master` equals the pushed commit and its tree contains the verified multimodal files. Remove only the validated temporary worktree after confirming it has no uncommitted changes.
