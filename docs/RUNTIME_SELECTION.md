# Provider-neutral AI runtime selection

## Goal

James must be installable and usable without Codex. WorkBuddy, Qoder Work,
Qoder, CodeBuddy, Codex and TRAE are shown as separate choices. No provider is
a prerequisite for installation.

The primary onboarding path is one short request entered in the AI Coding tool
the user already uses. That tool inspects the repository, runs the
cross-platform installer and opens the local Dashboard; users do not need to
copy shell commands, open a separate terminal, or understand package managers
and runtime flags.

## Runtime rules

1. An explicit user selection always wins.
2. `auto` selects the first usable headless runtime from the provider-neutral
   registry; it does not special-case Codex.
3. WorkBuddy and TRAE may be detected as desktop applications even when no
   readable headless interface is present. Detection is shown honestly and is
   not treated as runtime readiness.
4. Qoder Work is displayed separately from standalone Qoder CLI, while both
   safely reuse Qoder's documented non-interactive invocation contract.
5. A runtime is usable only when its executable is present. Authentication and
   a real call remain separate health checks in the Dashboard.
6. Prompt content is passed through standard input and is never embedded in a
   shell command.

## Beginner installation flow

The README provides one copyable natural-language installation request for
WorkBuddy, Qoder Work, Qoder, CodeBuddy, Codex or another capable AI Coding
tool. The tool then completes the flow directly from the opened repository and
uses the same installer on macOS, Windows and Linux:

```sh
node ./install.mjs
```

The command above is implementation detail for AI tools and maintainers, not a
manual step for beginner users. The installer remains the source of truth for
checks, rollback, service registration and Dashboard startup.

## Safety and compatibility

- Enterprise connectors and external writes remain disabled by default.
- A desktop application is not advertised as headless-ready without an
  executable adapter.
- Existing `aiRuntime` values remain valid.
- Windows, macOS and Linux use the same Node.js installer entry point.
- Provider-specific model settings are applied only by their matching adapter.
