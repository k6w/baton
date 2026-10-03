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
| `/merge <agent\|all>` · `/undo` · `/sync` · `/review <agent> [reviewer]` · `/diff` · `/plan approve\|reject` | land worker branches, undo a merge, resolve conflicts, cross-vendor review, approve plans |
| `/recipe <name> <task>` · `/settings` · `/guide` · `/history` · `/costs` | workflows, settings, lessons, past runs, spend |
| `/kill`, `/interrupt`, `/model`, `/label`, `/rename`, `/mode`, `/agents`, `/approve`, `/deny` | daemon commands; Tab completes names and arguments |
| `/autonomy <normal\|ask\|auto\|yolo>` · `/yolo` | how freely **every** agent acts — also `shift+tab` |
| `/style`, `/theme`, `/background`, `/frame`, `/layout`, `/icons`, `/border`, `/look`, `/bus`, `/thoughts`, `/zoom` | UI commands |

Keys: `ctrl+p` command palette · `ctrl+a` **inbox** of everything that needs you (`ctrl+n` jumps to the next) ·
`ctrl+s` settings · `ctrl+t` theme picker with live preview · `ctrl+d` changes and diffs · `ctrl+g` task plan ·
`ctrl+r` history · `ctrl+e` costs ·
`shift+tab` cycle autonomy (normal → auto → YOLO → ask) ·
`ctrl+y` approve the oldest request · `tab` focus the agent grid (then `hjkl`/arrows, `space` peek & reply, `z` zoom,
`m` message, `d` diff, `x` interrupt) · `ctrl+l` cycle layouts · `?` all shortcuts · `/guide` short lessons. Every binding can be changed
([docs/keybindings.md](docs/keybindings.md)).

## Built for running many agents

- **One place for everything that needs you.**
  - Approvals, proposed plans, failed or stuck agents (a watchdog flags silence and loops), conflicts, files edited outside a task's scope, budget stops, and finished work waiting to merge.
  - They show as ⚑ in the status bar and the terminal tab title.
  - `ctrl+n` takes you to the next one. `space` peeks at an agent and lets you answer it in place.
  - Desktop notifications and/or the terminal bell fire when Baton isn't focused.
- **From your phone.** `baton web --lan` shows a QR code; the page has your inbox (approve or deny with one tap), the lead's thread, every agent, the autonomy dial and a task input. ntfy notifications get Allow / Deny buttons.
- **Teams and integrations.** Shared runs show who's watching and who did what. `/issue 42` → `/pr` turns a GitHub issue into a draft PR without touching your working tree. A2A in both directions, a Python SDK, and a built-in agent (`baton`) that runs on any model provider, local models included.
- **It learns who's good at what.** Track record per agent and task kind (`/scores`); the lead picks agents with it, cheaper ones winning close calls. Replay any past run (`baton replay`), edit the plan as a table, focus mode and sounds.
- **Drive it from other agents.** `baton mcp` lets Claude Desktop, Cursor or any MCP client run a task on your Baton team, follow it, answer approvals, diff and merge.
- **One autonomy dial.** `shift+tab` switches every agent — lead and workers, even running ones — between normal, auto, YOLO (no prompts, no sandbox) and ask-first. Your deny rules always hold.
- **Looks, not just colors.** 11 styles (classic, modern, minimal, accent, tabs, neon, retro, zen, paper, glass, brutalist) change frames, status bar and background; ~50 themes (all meeting WCAG contrast) change colors; any mix works. `background = terminal` keeps your terminal's own (transparent) background.
- **Teaching built in.**
  - A four-step welcome tour: how it works, pick your look (live), pick your autonomy level, start with a task suggested from your repo.
  - A hint bar shows the keys that matter right now, `/guide` has illustrated lessons you can try on the spot, and `?` lists every key.
- **Recipes.** `/recipe best-of-3 <task>` and others:
  - `plan-execute`: plan, your approval, parallel execution.
  - `research-implement`, `implement-review`, `debug-hypotheses`, `test-first`, `shard`.
  - Add your own as Markdown in `.baton/recipes/`.
- **Settings screen** (`ctrl+s`) for every option, with search and live preview. Changes are written to the project or global config without losing its comments.
- **Visibility.**
  - Costs per agent and per vendor, plus budget gauges (`ctrl+e`).
  - Run history: resume a past run with the agents' own sessions, or export it as Markdown or JSONL (`ctrl+r`).
  - Search, copy (OSC 52 / native clipboard) and save transcripts from the zoom view.
- **Guard rails.**
  - Parallel spawns need a stated reason, and more agents than your soft limit need your OK.
  - The autonomy level is always visible; YOLO turns the lead's frame red.
  - Merges can be undone three-way (`/undo`), and each worker gets its own ports.
  - Colour-blind-safe themes are included.

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
- **Every worker gets its own git worktree.**
  - It starts from your current state, including uncommitted changes.
  - Baton predicts conflicts between workers *while* they edit.
  - Changes land through a 3-way merge queue into your working tree; your index and branch are never touched.
  - An optional verify command must pass first, and there's an optional cross-vendor review gate (Codex reviews Claude's work, and vice versa).
  - Plus file claims, task plans with optional approval, and a Changes view (`ctrl+d`) with a diff viewer. See [docs/workspaces.md](docs/workspaces.md).
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

- [Workspaces, merging & reviews](docs/workspaces.md): worktrees, the merge queue, conflicts, reviews, file claims, plans
- [Configuration](docs/configuration.md): every setting, the order config layers are applied, env vars, `baton config explain`
- [Agents, providers & plugins](docs/agents.md): supported agents, custom agents, model providers, writing adapters
- [Themes & appearance](docs/themes.md): the theme format, every token, importing, logos, layouts
- [Keybindings](docs/keybindings.md)
- [Remote access](docs/remote.md): the phone / web view, approving from notifications, `baton mcp`, HTML export
- [Teamwork & integrations](docs/integrations.md): shared runs, GitHub issues → PRs, A2A, Python, track record, replay, focus mode
- [The Baton agent](docs/native-agent.md): a built-in coding agent on any model provider · [A2A](docs/a2a.md)
- [SDK & protocol](docs/sdk.md): scripting Baton, the event and control protocols
- [Plan](PLAN.md) and [research notes](docs/research.md)

## Commands

```
baton [task]            start or attach in this project (sets the project up on the first run)
baton demo [task]       simulated agents, no tokens         --workers 8 --speed 2
baton run "<task>"      headless; streams progress          --json  --approve all|none  --timeout 600
baton web [--lan]       follow, approve and send tasks from your phone (QR code)
baton mcp               Baton as an MCP server for Claude Desktop, Cursor, other agents
baton a2a [--stop]      serve this team as an A2A agent
baton issue <n>         start with a GitHub issue · baton pr [-y]  PR from what the run merged
baton replay [run]      play a past run back
baton init | doctor | agents | ps | stop | trust | history | export <run> [--format md|html|jsonl]
baton config get|explain|path|schema|defaults
baton theme list|set <name>
flags: --theme <name> --layout <grid|focus|swarm|wide> --orchestrator <adapter> -y
```

## Development

```sh
bun test                        # ~240 tests: protocol, kernel, daemon, adapters (replayed fixtures), TUI frames
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
