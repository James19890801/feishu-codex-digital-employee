# Provider-neutral runtime implementation plan

**Goal:** Remove Codex-first behavior and make installation approachable from
the AI Coding tool a beginner already has.

## 1. Lock behavior with tests

- Update `src/ai-runtime.test.mjs` to require distinct WorkBuddy, Qoder Work,
  Qoder, CodeBuddy, Codex and TRAE entries.
- Require `auto` to follow registry readiness rather than a Codex-only priority
  list.
- Verify that Qoder Work uses the safe Qoder print-mode adapter.
- Extend configuration tests to accept the two new runtime IDs.
- Run the focused tests and confirm they fail before implementation.

## 2. Implement runtime discovery and selection

- Extend `src/ai-runtime.mjs` with separate runtime definitions and candidate
  paths.
- Keep desktop-only WorkBuddy/TRAE detection distinct from headless readiness.
- Reuse the Qoder adapter for Qoder Work.
- Remove the hard-coded Codex-first selection list.
- Update configuration validation and Dashboard selection APIs.

## 3. Make the UI provider-neutral

- Add runtime descriptions for WorkBuddy and Qoder Work.
- Replace every “Codex first” string with readiness-based automatic selection.
- Ensure unavailable desktop apps explain why they cannot be selected yet.

## 4. Lower the installation threshold

- Put one natural-language installation request in `README.md` and
  `AI_CODING_INSTALL.md`; the AI Coding tool remains the complete installation
  interface, so beginners do not copy shell commands or use a separate terminal.
- Present WorkBuddy, Qoder Work, Qoder, CodeBuddy and Codex equally.
- Keep `node ./install.mjs` as the shared macOS, Windows and Linux entry point.
- Update setup diagnostics so no provider is described as required or
  recommended.

## 5. Verify and publish

- Run focused runtime, configuration, i18n and public-neutrality tests.
- Run `npm run check`, `npm test` and `git diff --check`.
- Scan tracked files for Codex-first language.
- Commit with the public GitHub identity and push directly to `origin/main` as
  requested.
