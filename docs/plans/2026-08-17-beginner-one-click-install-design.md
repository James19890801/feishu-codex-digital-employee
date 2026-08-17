# Beginner One-Click Installation Design

## Goal

A beginner can paste the GitHub repository URL into WorkBuddy, Qoder Work, or a compatible AI coding tool and receive a working local installation without manually translating project internals into terminal commands. The learner machine is assumed to have no developer environment: no Node.js, Python, pnpm, Homebrew, or administrator-level package manager.

The release gate requires complete black-box installation on macOS and Windows. Linux remains supported through automated compatibility tests.

The primary business channel is DingTalk. Feishu, WeCom, personal WeChat, and other connectors remain disabled and are not part of the beginner success path.

## Chosen Approach

Use one shared installer core with two supported entry paths:

1. A source checkout runs the repository-root `install.mjs` directly.
2. A packaged release runs its own root `install.mjs` and verifies packaged checksums.

The source path is the primary AI-coding workflow. A pinned, checksummed release asset is the fallback when a source installation cannot proceed.

## Installation Flow

1. Detect the operating system and architecture.
2. Discover a compatible Node.js 22.13+ runtime exposed by the AI coding tool or host and prove that `node:sqlite` can load. If none exists, download an official portable Node archive into a user-owned runtime directory and verify it against the official SHA-256 manifest. Do not require Homebrew, winget, or administrator access.
3. Do not require Python to start the core service and Dashboard. Detect Python for optional document-processing capabilities and install or request it only when that capability is enabled.
4. Discover compatible headless AI runtimes, including WorkBuddy, Qoder Work, Qoder, CodeBuddy, and Codex.
5. Provision the pinned standalone `dingtalk-workspace-cli` (DWS) into a user-owned application tools directory when it is absent. Never use the legacy Wukong bridge.
6. Separate DingTalk states into DWS installed, account authenticated, Profile/Channel configured, event-stream connected, and controlled-message verified. Pause for the learner's own DingTalk login when authentication requires interaction.
7. Separate runtime states into installed, authenticated, and real-call-ready. Automatic selection may choose only a runtime that passes readiness verification.
8. Build or copy an installation payload into a versioned target directory.
9. Create a fail-closed local configuration. DingTalk is presented as the primary setup action but is not enabled until the learner's own authentication and authorization are complete. All other connectors, external writes, semantic group engagement, relationship memory, and automatic learning start disabled.
10. Store credentials through a platform abstraction: macOS Keychain on macOS and Windows Credential Manager or a user-restricted fallback on Windows.
11. Register the main and Dashboard services through a platform service-controller abstraction.
12. Start both services and verify an installation attestation containing installation ID, build SHA, installation root, PID, startup time, and health state.
13. Run a self-contained `npm run verify:install` that is guaranteed to exist in both source and packaged layouts.
14. Open the local Dashboard directly on the DingTalk onboarding screen and report exact readiness states without claiming that executable discovery equals authentication or connectivity.

## Safety Boundaries

The communication blocklist is enforced at three independent boundaries: before inbound enqueue, again before queued work is consumed, and immediately before every outbound send. Channel identifiers are normalized through one canonical function.

The default configuration is fail-closed. Installing the application does not authorize any connector, recipient, group reply, learning job, relationship-memory job, or external mutation. Those capabilities require explicit Dashboard configuration and authorization.

Installation verification cannot trust an arbitrary `2xx` response from the default port. The installer generates an installation ID and accepts success only when the responding process attests to the expected ID, build SHA, installation directory, and healthy main/Dashboard services.

## Rollback and Recovery

Every installation side effect registers a compensating action. On failure, compensation runs in reverse order and removes newly registered services, temporary credentials, generated configuration, and the incomplete directory. An upgrade keeps the last known-good installation until the new version passes attestation, then switches atomically.

If an operating-system permission or runtime login needs human action, the AI coding tool asks for one concrete action and resumes from a recorded checkpoint.

## Verification Strategy

All behavior changes use test-first red-green-refactor cycles. Release gates include:

- source-root entrypoint regression test;
- packaged-entrypoint and checksum test;
- Node capability/version boundary tests;
- fail-closed default configuration tests;
- three-boundary communication-blocklist tests;
- installer attestation tests that reject stale or unrelated Dashboards;
- partial service-registration rollback tests;
- non-administrator Windows credential and service tests;
- macOS LaunchAgent and Keychain tests;
- runtime installed/authenticated/real-call-ready tests and fallback behavior;
- DingTalk DWS installation, authentication detection, Profile/Channel validation, event-stream readiness, and controlled self-chat receipt tests;
- distribution self-test proving `npm run verify:install` works after packaging;
- orphan-test detection so every `*.test.mjs` belongs to the standard suite;
- clean macOS and Windows black-box installation using only the repository URL;
- Linux automated install compatibility.

## Delivery

The repository will include a short beginner-facing prompt for WorkBuddy and Qoder Work. It instructs the tool to clone the repository, follow `AGENTS.md`, run the shared installer, guide the learner through their own DingTalk login when required, complete the self-verification command, open the DingTalk Dashboard onboarding screen, and report readiness states. No learner is asked to manually copy a series of shell commands.

The repository also provides an operating-system bootstrap entrypoint that can run before Node exists: POSIX shell on macOS/Linux and PowerShell on Windows. The AI coding instructions select the correct bootstrap automatically.
