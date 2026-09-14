# Baton

**One terminal for all of your coding agents.** Baton runs Claude Code, Codex, OpenCode, Gemini, Cursor,
Copilot, Goose, Kiro, Qwen and any [ACP](https://agentclientprotocol.com) agent side by side. An
**orchestrator** agent plans the work and talks to the other agents directly, and the agents can message
each other over a live message bus while you watch every tool call, diff and token in a terminal UI you can theme.

```
╭─ ✱ orchestrator ──────────────────────────────────────────── ✓ 2/2 · codex ─╮
│ • I'll delegate the README typo and the add() test to two OpenCode agents.  │
│ • Task spawn opencode                                                       │
│   → opencode-1 fix typo                                                     │
│ ⇄ opencode-1 → lead  result ok (+1 −1)                                      │
│ ❯ message the orchestrator · @agent · /command                              │
╰─────────────────────────────────────────────────────────────────────────────╯
╭─ ⌬ opencode-1 ───────── fix typo ─╮╭─ ⌬ opencode-2 ──────── add tests ─╮╭─ ⇄ bus ──────── a2a ─╮
│ ● Update(README.md)               ││ ● Write(math.test.js)             ││ 03.451 o1→lead result │
│   3 - This is teh fastest way…    ││   1 + import { test } from 'no…   ││ 21.198 o2→lead 100% d │
│   3 + This is the fastest way…    ││ ● Bash(node --test math.test.js)  ││ 26.407 o2→lead result │
│ ◌ idle · ready · ↓ 21k            ││ ✶ Wrangling… (41s · ↓ 22k)        ││ ● 2 msgs · 3 peers    │
╰───────────────────────────────────╯╰───────────────────────────────────╯╰───────────────────────╯
 ● 1/2 opencode running · 10 calls · 2 msgs                          +24 -1  portfolio@main
```

## Quick start

```sh
bun install                    # Bun ≥ 1.3
bun run demo                   # simulated agents, no tokens: see what it does
bun packages/cli/src/main.ts   # start Baton in the current project
bun run build                  # standalone binary → dist/baton
```

Run `baton` in any folder. On the first run it sets the folder up:

- runs `git init` if the folder isn't a repository yet,
- detects which agent CLIs you have installed and whether they're logged in,
- detects your toolchain (package manager, test, lint and build commands),
- creates `AGENTS.md` and a `CLAUDE.md` that imports it (existing files are never overwritten),
- writes `.baton/config.toml`, picking the best logged-in agent as orchestrator and another one for workers.

Then type what you want. The orchestrator decides how many agents to use, which ones, and what each should do.

## How you talk to it

| You type | What happens |
|---|---|
| `fix the flaky login test` | goes to the orchestrator, which plans and delegates |
| `@codex-2 verify codex-1's fix` | goes straight to one agent (it's injected into the current turn if the agent supports that) |
| `@all stop and commit` · `@role:reviewer …` | broadcasts to every agent, or to every agent with that role |
| `!codex-3` · `!all` | interrupts an agent (or everyone) |
| `/spawn codex 3 typo hunt` | starts three Codex agents labelled "typo hunt" |
| `/kill`, `/interrupt`, `/model`, `/label`, `/rename`, `/mode`, `/agents`, `/approve`, `/deny` | daemon commands; Tab completes names and arguments |
| `/theme`, `/layout`, `/icons`, `/border`, `/look`, `/bus`, `/thoughts`, `/zoom` | UI commands |

Keys: `ctrl+p` command palette · `ctrl+t` theme picker with live preview · `ctrl+a` approvals inbox ·
`ctrl+y` approve the oldest request · `tab` focus the agent grid (then `hjkl`/arrows, `z` zoom, `m` message,
`x` interrupt) · `ctrl+l` cycle layouts · `?` all shortcuts. Every binding can be changed
([docs/keybindings.md](docs/keybindings.md)).

## What's inside

- **Real adapters, not screen scraping.** Each agent is driven through its own structured interface:
  - Codex through `codex app-server` (JSON-RPC, with types generated from the installed version)
  - Claude Code through the Agent SDK
  - OpenCode through `opencode serve` (HTTP + server-sent events)
  - Gemini, Cursor, Copilot, Goose, Kiro, Qwen, Cline, Droid and the rest through ACP
  - Amp and the plain Claude CLI through stream-json
- **An event model built on ACP.** Every adapter emits the same Baton Event Protocol: tool calls with diffs, terminal output, plans, usage and cost, permission requests and bus messages. The UI, the SDK and stored history all use it.
- **A message bus between agents.** Every agent gets a `baton` MCP server (`send_message`, `read_inbox`, `list_agents`, `report_progress`; the orchestrator additionally gets `spawn_agent`, `wait_for_results`, `interrupt_agent`, `kill_agent`).
  - Messages are pushed into each agent through its native steering call: Codex `turn/steer`, Claude streaming input, Amp steer messages. Agents that can't steer get them queued for their next turn.
  - A worker's result automatically flows back to whoever dispatched the task.
- **One approval inbox.** Permission requests from every protocol go through a policy engine (`strict` / `balanced` / `yolo` plus your own rules). Whatever the policy doesn't decide lands in one inbox. An agent can never pass your approval on to another agent.
- **Budgets** per agent and per run (warn at 80%, interrupt at 100%), plus limits on agent count and spawn depth.
- **A daemon you can detach from.** `batond` runs per project and the TUI is just a client: quit with `ctrl+c` and your agents keep working; run `baton` again to re-attach. Every event is stored in SQLite, so runs survive crashes and can be replayed.
- **Customizable throughout.**
  - About 30 themes, OpenCode theme import, base16/base24 import, and a `system` theme built from your terminal's own palette
  - 4 layouts, 6 border styles, and icons as real logos (Kitty graphics or Sixel), Nerd Font, Unicode or ASCII
  - spinner styles and spinner words, status-bar format strings, card fields, and a "native" look per agent vs one unified look
  - every key binding, and runtime preferences that are remembered but never written into your config files
- **An SDK and plugins.** The TUI is built only on `@batonsh/sdk`. Add agents with a few lines of config (any ACP command) or with a TypeScript plugin (`defineAdapter`).

## Documentation

- [Configuration](docs/configuration.md): every setting, the order config layers are applied, env vars, `baton config explain`
- [Agents, providers & plugins](docs/agents.md): supported agents, custom agents, model providers, writing adapters
- [Themes & appearance](docs/themes.md): the theme format, every token, importing, logos, layouts
- [Keybindings](docs/keybindings.md)
- [SDK & protocol](docs/sdk.md): scripting Baton, the event and control protocols
- [Plan](PLAN.md) and [research notes](docs/research.md)

## Commands

```
baton [task]            start or attach in this project (sets the project up on the first run)
baton demo [task]       simulated agents, no tokens         --workers 8 --speed 2
baton run "<task>"      headless; streams progress          --json  --approve all|none  --timeout 600
baton init | doctor | agents | ps | stop | trust
baton config get|explain|path|schema|defaults
baton theme list|set <name>
flags: --theme <name> --layout <grid|focus|swarm|wide> --orchestrator <adapter> -y
```

## Development

```sh
bun test                        # ~200 tests: protocol, kernel, daemon, adapters (replayed fixtures), TUI frames
BATON_LIVE=1 bun test packages/adapters/codex    # contract tests against the real CLI (uses your account)
bunx tsc -p tsconfig.json --noEmit && bunx biome check .
```

The monorepo's packages:

- `protocol`: events, the adapter contract and the control protocol
- `kernel`: config, the event store, state projections
- `daemon`: runtime, bus, policy, MCP server, plugins
- `sdk`: the client library
- `tui`: the terminal UI (OpenTUI + Solid)
- `themes`, `icons`
- `adapters/*`
- `cli`

MIT licensed. Agent logos come from [LobeHub Icons](https://github.com/lobehub/lobe-icons) (MIT) and are trademarks of their
owners. They are used only to identify which agent is running (see `packages/icons/NOTICE.md`).
