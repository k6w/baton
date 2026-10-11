# Changelog

All notable changes to Baton. Versions follow [semver](https://semver.org); the control protocol
(`baton protocol`) and the event log format (BEP) carry their own version numbers.

## Unreleased

## 0.3.0 — 2026-10-11

**Roles, skills and team memory**
- Roles: tester, reviewer, debugger, refactorer, docs, security, researcher and frontend are built
  in, plus your own in `.baton/roles/*.md` (`baton role new`). A role brings instructions, an
  access level, a model size, an agent, an acceptance check and skills. `/spawn tester`, `/roles`.
- Worker specs: the lead's `spawn_agent` takes `instructions`, `skills`, `files` (claimed for the
  worker), `acceptance` and `access`. Its instructions now include a brief template with examples.
- Acceptance checks: Baton runs the command when the worker finishes. The work counts only when it
  passes, with two retries on failure, and the check goes through your approval rules.
- Read-only workers can't edit files, even in YOLO. Reviews now use the reviewer role.
- Skills (Agent Skills layout, from `.baton/skills` and `.claude/skills`) for every agent, not just
  Claude: a menu in their instructions and `load_skill` to read one. `baton skill new`, `/skills`.
- Team notes in `.baton/notes.md`: agents `note` and `recall` facts, new workers start with them,
  and review findings are kept. `/notes`, `baton notes`.
- Saved teams: `[teams]` plus `/team <name> [task]`.
- `pick_agent` suggests a role. Cards show the worker's role, and `r/o` for read-only workers.
- Reviews prefer agents confirmed to be signed in.

**Markdown everywhere**
- Agent messages render as Markdown in the TUI (bold, italics, code, lists, task lists, quotes,
  tables, code blocks, links) instead of showing `**` and backticks.
- The phone/web view and HTML exports render it too, with a renderer that escapes everything
  first, so agent text can't inject markup.

## 0.2.0 — 2026-10-11

**Windows**
- Baton runs natively on Windows 10 and 11: `irm https://k6w.github.io/baton/install.ps1 | iex`,
  or `npm i -g batonsh`. CI tests it on Windows alongside macOS and Linux.
- The daemon listens on a named pipe. Processes are cleaned up with taskkill. npm-installed agent
  CLIs (`codex.cmd`, …) are found and started. The Baton agent runs commands with Git Bash, or
  PowerShell without it.
- Worktrees are byte-exact copies even with `core.autocrlf` (no more CRLF churn on merges).
- `baton update` replaces a running `baton.exe` safely. `baton doctor` checks Git for Windows.

**Fixes**
- The lead's pane no longer shows "approval pending" after you've approved.
- In the agent grid, Tab moves to the next agent and Esc goes back to the input (the hint said so;
  the keys didn't).
- Plain text symbols instead of emoji everywhere in the app (↯ auto, ▲ YOLO, ‖ paused, …).
- Inbox entries read "codex-1: Bash(…)".
- Relative paths are shown with "/" on every platform.

**Docs**
- A new README and website with full docs, a plain-words guide to how Baton works, a command-line
  reference, and a re-recorded demo.

## 0.1.0 — first release

The first public version: one terminal for a team of coding agents.

**Team**
- An orchestrator (Claude Code, Codex, OpenCode or Baton's own agent) plans, spawns workers, routes
  messages and lands their work. Every agent gets its own git worktree and a 3-way merge queue that
  runs your checks first.
- Cross-vendor reviews (Codex reviews Claude and vice versa). Merges wait for an unresolved review
  unless forced, and a reviewer that fails is reported as "no review".
- Track record per agent and task kind (`pick_agent`, `/scores`), model routing tiers, best-of-N
  compare.
- Agents: Claude Code, Codex, OpenCode, every ACP agent (Gemini, Cursor, Copilot, Goose, Qwen,
  Kimi, Cline…), any prompt-taking CLI in a PTY, A2A agents, and Baton's own agent on any provider.

**Control**
- One autonomy dial for every agent (normal · ask · auto · yolo, shift+tab), deny rules that hold in
  yolo, project trust for anything executable in a repo's config.
- Plan approval and editing, diff review with inline comments, undo merge, budgets, a watchdog for
  stuck and looping agents. Acknowledgments and agent-to-agent ping-pong no longer burn turns.

**Everywhere**
- TUI with 5 layouts, 11 styles and 40+ themes, a guided welcome, lessons and recipes.
- Phone and web view with one-tap approvals (LAN, HTTPS, Tailscale), ntfy/Slack/webhook
  notifications, shared runs with presence.
- `baton run` for scripts and CI, `baton mcp` (Baton as an MCP server), `baton a2a`, GitHub issues
  → runs → pull requests, replay, HTML/Markdown export, OpenTelemetry, TypeScript and Python SDKs.

**Safety**
- Agents that aren't signed in, or whose plan ran out of quota, are refused up front with the reason,
  and the orchestrator is told which agents are ready.
- The Baton agent's commands run sandboxed: seatbelt on macOS; bubblewrap, firejail or Landlock on
  Linux; or a docker/podman container on any OS. It also has `web_search` and `web_fetch`.
- DNS-rebinding protection on every server Baton runs, and on outgoing fetches and webhooks.

**Install**
- One binary for macOS and Linux (x64 and arm64, plus musl), from `install.sh`, npm or Homebrew,
  verified against `SHA256SUMS`. `baton update` updates in place. A Python SDK is on PyPI.
