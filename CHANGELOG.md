# Changelog

All notable changes to Baton. Versions follow [semver](https://semver.org); the control protocol
(`baton protocol`) and the event log format (BEP) carry their own version numbers.

## Unreleased

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
