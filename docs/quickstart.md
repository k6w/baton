# Quickstart

Five minutes from nothing to a team of agents working on your code.

## 1. Install Baton

```sh
curl -fsSL https://raw.githubusercontent.com/k6w/baton/main/install.sh | sh
```

Or `npm i -g batonsh`, or `brew install k6w/tap/baton`. The installer verifies the
download's checksum and puts a single `baton` binary in `~/.local/bin`. Nothing else is
installed or changed. `baton update` keeps it current.

## 2. Have at least one agent signed in

Baton doesn't replace your coding agents. It runs the ones you already use, each with its own
login and plan. One is enough to start; two different vendors make cross-reviews possible.

| Agent | Install | Sign in |
|---|---|---|
| Claude Code | [claude.com/claude-code](https://claude.com/claude-code) | `baton login claude` |
| Codex | `npm i -g @openai/codex` | `baton login codex` |
| OpenCode | `curl -fsSL https://opencode.ai/install \| bash` | `baton login opencode` |
| Gemini, Cursor, Copilot, Goose, Qwen… | their own installers | `baton login <agent>` |
| Baton's own agent | built in | an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …) or a local model |

`baton login <agent>` runs that agent's own sign-in. Baton never sees or stores your
credentials. Check what Baton found with:

```sh
baton doctor
```

## 3. Try it without spending tokens

```sh
baton demo
```

Simulated agents plan, write code, review each other and merge, so you can learn the screen.
`?` lists every key, and `/guide` has short lessons.

## 4. Start in your project

```sh
cd my-project
baton
```

The first run sets the folder up: it detects your agents and toolchain, writes
`.baton/config.toml`, and creates `AGENTS.md` (existing files are never overwritten). Then type
what you want:

```
add rate limiting to the /login endpoint, with tests
```

The orchestrator plans, picks agents, and gives each one its own git worktree. Workers'
changes are reviewed by an agent from a different vendor and merged into your project after
your checks pass.

What needs you shows up as ⚑ in the status bar. `ctrl+a` opens the inbox and `ctrl+y`
approves the oldest request.

## 5. Choose how much freedom they get

`shift+tab` cycles the autonomy dial for every agent at once:

| Mode | What agents may do without asking |
|---|---|
| **normal** | each agent's own defaults: reads and edits in its worktree; risky commands ask |
| **auto** | everything inside the workspace sandbox |
| **yolo** | everything, no sandbox. Your deny rules still hold |
| **ask** | nothing: every action waits for you |

## Next

- **Phone:** `baton web --lan` shows a QR code. Follow along and approve from your phone ([remote](remote.md)).
- **Scripts and CI:** `baton run "update the changelog" --approve all --json`.
- **Other tools driving Baton:** `baton mcp` for Claude Desktop, Cursor or any MCP client; `baton a2a` for A2A agents.
- **GitHub:** `baton issue 42`, then `/pr` once it's merged ([integrations](integrations.md)).
- **Make it yours:** `/style`, `ctrl+t` themes, `ctrl+s` settings ([themes](themes.md), [configuration](configuration.md)).
- **Something wrong?** See [troubleshooting](troubleshooting.md).
