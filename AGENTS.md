# AI Coding installation instructions

When a user asks to install, upgrade, repair or validate this project, complete
the workflow inside the current AI Coding session. Do not ask a beginner to
copy commands into a separate terminal.

1. Detect whether the host is macOS, Windows or Linux.
2. Check for Node.js 22.5.0 or newer and Python 3. If a required dependency is
   missing, explain the single system permission or installer action the user
   must approve, then continue automatically.
3. Run `node ./install.mjs` from the repository root. This is the shared
   cross-platform installer; do not substitute a macOS-only path.
4. Keep all enterprise connectors and external writes disabled unless the user
   explicitly configures and authorizes one.
5. Discover WorkBuddy, Qoder Work, Qoder, CodeBuddy, Codex and other compatible
   runtimes. Never require or prefer Codex. Respect an explicit selection;
   otherwise use the first usable headless runtime reported by the project.
6. Run `npm run check`, `npm test` and `npm run health` after installation.
7. Open `http://127.0.0.1:17655/` and verify the first Dashboard screen.
8. Report which runtime was selected and distinguish installed, authenticated,
   real-call-ready and connector-ready states. Never describe an app-only
   detection as a working headless runtime.

Pause only for a login, operating-system permission or user choice that cannot
be completed safely by the AI Coding tool. Keep each prompt to one concrete
action and resume the workflow after it is done.
