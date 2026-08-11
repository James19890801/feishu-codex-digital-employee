# Secure multimodal sync verification — 2026-08-04

## Scope

- Source capability commit: GitHub `James19890801/feishu-codex-digital-employee` at `cf66cfcccec45f00528df1fb9a567bddb21025de`.
- Integration branch: `codex/multimodal-sync`.
- Verified capabilities: Feishu and DingTalk media metadata, image/file/audio/video orchestration, bounded public web reading, capability readiness, and conditional Apple transcription helper installation.

## Automated verification

All commands below exited with status 0 in the isolated integration worktree.

| Command | Evidence |
|---|---|
| `npm run test:multimodal` | `MULTIMODAL_CONTENT_TEST_OK`, `WEB_READER_TEST_OK`, `MULTIMODAL_PIPELINE_TEST_OK` |
| `npm test` | Full suite passed; mechanism acceptance reported 87 total, 87 passed, 0 failed |
| `npm run check` | JavaScript syntax checks, James macOS bundle contract, Swift main-app typecheck, config check, and Python helper check passed |
| `npm run test:install-aicoding` | `INSTALL_AICODING_TEST_OK` |
| `npm run test:distribution-package` | `DISTRIBUTION_PACKAGE_TEST_OK` |
| `npm run test:dws-deployment-policy` | `DWS_DEPLOYMENT_POLICY_TEST_OK` |
| `git diff --check` | No whitespace errors |

The pipeline behavior tests exercise rejection of symlinks, non-files, empty files and oversized media; direct argv-based transcription invocation; bounded transcript output; successful and failed public URL handling; and the untrusted-web-content boundary.

## macOS application acceptance

- macOS product version: `15.5`.
- Active macOS SDK: `15.5`.
- A clean application bundle was built, ad-hoc signed, installed to a fresh temporary destination, and verified with `codesign --verify --deep --strict`.
- Installer output explicitly reported: `James audio transcription helper requires the macOS 26 SDK; skipping it.`
- Acceptance marker: `JAMES_MACOS_15_INSTALL_FALLBACK_OK`.
- `JamesTranscribe` was confirmed absent from the installed bundle, so Dashboard audio readiness remains false on this machine.

Live Apple speech transcription was not accepted on macOS 15.5 because `SpeechTranscriber` requires the macOS 26 SDK. The code path and degraded user response are covered by automated tests, but this record does not claim live speech recognition. Live Feishu/DingTalk image, document, audio, or video messages were not sent during this verification; channel downloads are validated through command construction, normalization, orchestration, and package tests.

## Workspace isolation

The pre-existing main-worktree changes in `src/human-takeover.mjs`, `src/human-takeover.test.mjs`, and the untracked `docs/AIPRO产品与技术全景介绍.md` remained unstaged and were not modified or included by this integration branch.
