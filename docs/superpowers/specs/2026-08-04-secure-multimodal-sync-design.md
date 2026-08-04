# Secure Multimodal Capability Sync Design

## Goal

Bring the secure multimodal capabilities from GitHub commit `cf66cfcccec45f00528df1fb9a567bddb21025de` into the current local James development line and publish the same production changes to the independent `codeup/master` release history without overwriting later local work or unrelated uncommitted files.

## Source and Targets

- Source repository: `James19890801/feishu-codex-digital-employee`
- Source commit: `cf66cfc` (`Add secure multimodal message understanding`)
- Local target: `agent/aipro-commercial-platform-upgrade`
- Internal release target: `codeup/master`
- Existing user-owned changes that must remain uncommitted and untouched by this work:
  - `src/human-takeover.mjs`
  - `src/human-takeover.test.mjs`
  - `docs/AIPRO产品与技术全景介绍.md`

The GitHub source commit and the local target share commit `b93a0e2`, after which the local target contains 33 additional commits. The Codeup repository uses an independent snapshot history even though its current tree matches the committed local tree. A direct pull, force-push, or history replacement is therefore not acceptable.

## Chosen Approach

Semantically port the complete source commit into the current James code structure. Preserve the source commit's behavior, security controls, configuration, status reporting, documentation, and tests while resolving AIPRO/James naming and later-commit differences deliberately.

After the local implementation passes verification, apply the same production patch to a temporary worktree based on `codeup/master`, rerun release verification there, create an ordinary descendant commit, and push it to Codeup. Do not force-push either remote.

## Capability Scope

### Image understanding

- Accept image messages discovered through Feishu polling and DingTalk event-stream payloads.
- Download images into a private workspace-local temporary directory.
- Validate that downloaded media is a regular, non-symlink file within the configured size limit.
- Pass verified image paths to the existing AI runtime attachment interface.
- Preserve existing recent-image context behavior and limits.

### Document parsing

- Accept file messages through supported Feishu and DingTalk paths.
- Preserve the existing local extractor for PDF, DOCX, plain text, Markdown, CSV, and JSON inputs.
- Add the source commit's secure download path and failure handling around the extractor.
- Limit extracted content before it enters the model context.
- Do not infer or expose document contents when download or parsing fails.

### Audio transcription

- Accept Feishu audio/file resources and DingTalk voice placeholders.
- Use the source commit's configurable executable-plus-arguments interface.
- Reject shell interpreters and shell command flags; require an explicit `{input}` placeholder.
- Include the upstream Apple on-device transcription helper and installer integration.
- Return a clear retry-or-text fallback when no compatible transcriber is available or transcription fails.

The current development machine runs macOS 15.5 with the macOS 15.5 SDK. The upstream Apple helper uses `SpeechTranscriber`, which requires macOS 26. The sync therefore delivers the upstream code and configuration contract but must not claim successful live local transcription on this machine unless a compatible external transcriber is configured and exercised. Image and document behavior remain independently testable.

### Video and public web content

Video key-frame extraction, optional audio transcription, and SSRF-resistant public web-page reading are part of the same atomic upstream change and share the same media pipeline. They will be ported with the requested capabilities rather than selectively omitted.

The web reader must accept only public HTTP(S) addresses, reject credentials and custom ports, validate DNS results, pin requests to validated addresses, reject private or special-purpose IP ranges, limit redirects and response size, and accept only supported textual content types. Retrieved page instructions are untrusted data, not executable instructions.

## Components

- `src/multimodal-content.mjs`: pure parsing, safe CLI argument construction, transcription invocation validation, and media extension selection.
- `src/web-reader.mjs`: public URL extraction, DNS/IP validation, bounded fetching, redirects, and readable text extraction.
- `src/polling.mjs`: selection and normalization of image, file, audio, and media messages.
- `src/im-channels.mjs`: preservation of channel metadata required to download DingTalk resources safely.
- `src/index.mjs`: orchestration of media download, file validation, document extraction, transcription, image attachments, video frames, web context, auditing, user-facing degradation, and cleanup.
- `src/config.mjs` and `config.example.json`: audio-transcriber and web-reader configuration.
- Dashboard model/server/UI: visible capability readiness and degraded status.
- macOS helper and installer: compilation and installation of the upstream Apple transcriber where the host SDK supports it.
- Tests and verification scripts: regression coverage for all new boundaries.

## Data Flow

1. A supported channel receives or polls an inbound message.
2. Channel-specific metadata is normalized into a common message plus media descriptor.
3. The handler creates a private temporary directory only when media must be downloaded.
4. A channel client or fixed executable downloads the media using structured arguments.
5. The handler verifies file type, symlink status, size, and safe output location.
6. Images become AI runtime attachments; documents become bounded extracted text; audio becomes bounded transcript text; video may contribute a thumbnail and transcript.
7. Public URLs in textual messages are optionally fetched through the constrained web reader and inserted as explicitly untrusted context.
8. The existing response runtime produces the answer.
9. The system records success or degraded audit events and deletes the temporary directory in all outcomes.

## Error Handling

- Unsupported or malformed media descriptors are rejected without command execution.
- Failed downloads, invalid files, oversized media, extraction failures, and empty transcripts do not produce guessed content.
- Audio-transcriber absence is a handled degraded state with a concise user-facing fallback.
- Video processing may proceed with either a valid frame or transcript; it fails if neither can be obtained.
- Web-reader failures are summarized without claiming the linked content was read.
- Temporary media is removed in a `finally` path.
- Existing authorization, owner, self-chat, communication blocklist, and human-takeover controls remain authoritative and are not relaxed by media handling.

## Test Strategy

Use red-green-refactor cycles while adapting the upstream tests:

1. Add the pure multimodal helper tests and observe expected failures before adding implementation.
2. Add polling and channel metadata cases for image, file, audio, media, malformed placeholders, and identity preservation.
3. Add web-reader tests for URL extraction, HTML text extraction, private-address rejection, DNS pinning, redirects, content type, and size limits.
4. Add orchestration/config/dashboard contract tests before wiring production behavior.
5. Run focused tests after each implementation unit.
6. Run the complete `npm test` suite, `npm run check`, installer/config tests, distribution tests, privacy scanning, and `git diff --check` before any completion claim.
7. Run the same release-relevant checks again in the Codeup worktree before pushing.

Live media acceptance is reported separately from automated tests. On macOS 15.5, Apple `SpeechTranscriber` acceptance is expected to remain unexecuted unless a compatible configured transcriber is available.

## Git and Release Procedure

1. Keep the current dirty files outside all staged file lists.
2. Commit the local semantic port in reviewable units after fresh verification.
3. Confirm the final local diff contains only approved multimodal changes and design/plan artifacts.
4. Create a temporary worktree from `codeup/master`.
5. Apply the verified production code, tests, release tooling, and public documentation required by the Codeup release; exclude local configuration, private data, generated media, and unrelated user files.
6. Verify the Codeup worktree with the repository's tests and privacy/release checks.
7. Commit and push an ordinary fast-forward update to `codeup/master`.
8. Fetch Codeup and verify the remote branch resolves to the pushed commit.

## Acceptance Criteria

- The local branch contains the complete secure multimodal behavior from `cf66cfc`, adapted to the current James architecture.
- Existing local post-`b93a0e2` features and user-owned dirty files are preserved.
- Automated image, document, audio-invocation, video, web-reader, polling, configuration, dashboard, and security tests pass.
- The complete repository verification suite passes or any pre-existing/unavoidable failure is reported explicitly with evidence.
- The Codeup release commit is a normal descendant of the prior `codeup/master` and contains the verified public production changes.
- Codeup remote readback confirms the pushed commit.
- No claim of working Apple on-device transcription is made on macOS 15.5 without a successful compatible live transcription run.
