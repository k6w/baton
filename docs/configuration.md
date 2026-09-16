# Configuration

Baton reads TOML config in layers. Later layers win; tables are deep-merged, arrays are replaced.

| # | Layer | Where |
|---|---|---|
| 1 | built-in defaults | `baton config defaults` prints them |
| 2 | global | `~/.config/baton/config.toml` (`$XDG_CONFIG_HOME`, or `BATON_CONFIG_DIR`) |
| 3 | project | `<project>/.baton/config.toml` (commit this) |
| 4 | project-local | `<project>/.baton/config.local.toml` (git-ignored, for your personal overrides) |
| 5 | environment | `BATON_<SECTION>__<KEY>=value`, e.g. `BATON_UI__THEME=nord`, `BATON_BUDGET__RUN_USD=5` (values are parsed as JSON when possible), plus the shortcuts `BATON_THEME`, `BATON_LAYOUT`, `BATON_ICONS`; `NO_COLOR` selects the `mono` theme |
| 6 | CLI flags | `--theme`, `--layout`, `--orchestrator` |
| 7 | runtime prefs | choices you make inside the TUI (theme, layout, icons, …) are stored in `~/.local/state/baton/ui.json`. They are **never** written back into your config files |

`baton config explain ui.theme` tells you which layer set a value. An invalid value is reported and ignored
on its own: every other setting still applies. `baton config schema` prints a JSON Schema you can use for
editor autocompletion.

## Full reference

```toml
plugins = []                      # adapter plugins, see agents.md (project plugins need `baton trust`)

[project]
name = "portfolio"                # shown in the status bar (default: folder name)

[orchestrator]
enabled = true
agent = "claude"                  # adapter id or a profile from [agents.*]
model = "sonnet"                  # optional; passed to the adapter
approval = "auto-edit"            # ask | auto-edit | auto | yolo — how freely the agent itself acts
mode = "orchestrator"             # playbook: .baton/playbooks/<mode>.md overrides the built-in one
instructions = "Prefer Codex for reviews."   # appended to the playbook
plan_approval = false             # true: the orchestrator's plan_tasks waits for /plan approve|reject

[defaults]
worker = "codex"                  # default adapter for /spawn suggestions
approval = "ask"                  # approval mode for workers without a profile

[agents.reviewer]                 # a *profile*: /spawn reviewer, or spawn_agent(adapter: "reviewer")
adapter = "codex"
model = "gpt-5-codex"
provider = "openrouter"           # a [providers.*] entry
approval = "auto-edit"
role = "reviewer"                 # picks up [roles.reviewer].prompt; addressable as @role:reviewer
label = "review"                  # card label
autostart = 1                     # start this many when the daemon starts
command = "/opt/bin/codex"        # override the binary
args = []                         # extra args (generic ACP agents: the full command line)
env = { CODEX_HOME = "/tmp/x" }
options = { shellDiffs = true }   # adapter-specific options

[providers.openrouter]
kind = "openai-compatible"        # anthropic | openai | openai-compatible | bedrock | vertex | azure | ollama | lmstudio
base_url = "https://openrouter.ai/api/v1"
api_key = "env:OPENROUTER_API_KEY"   # env:VAR · cmd:<shell command> · keychain:<service> · or a literal
headers = {}
models = { kimi = "moonshotai/kimi-k2" }   # aliases: model = "kimi"

[roles.reviewer]
prompt = "Review diffs from other agents. Be specific; run the tests before approving."

[budget]
run_usd = 10                      # interrupt everything at $10 (warn at warn_at × limit)
per_agent_usd = 3
max_agents = 16
max_depth = 2                     # how deep agents may spawn agents
warn_at = 0.8

[policy]
preset = "balanced"               # strict | balanced | yolo
timeout_s = 0                     # auto-deny unanswered requests after N seconds (0 = never)
[[policy.rules]]                  # checked first, top to bottom; first match wins
kinds = ["execute"]               # read edit delete move search execute think fetch other …
match = "^Bash\\((bun|npm) test"  # regex against the request title + detail
agents = ["codex-1", "codex"]     # agent names or adapter ids (optional)
action = "allow"                  # allow | deny | ask

[workspace]
isolation = "worktree"            # worktree: each worker gets its own git worktree · shared: everyone edits the project
# dir = "~/worktrees"             # default ~/.local/state/baton/worktrees/<project> (outside the repo, so test runners never see it)
link = ["node_modules", ".venv", "vendor"]   # symlinked into each worktree when present
copy = [".env", ".env.local"]     # copied into each worktree when present
setup = "bun install"             # run once in each new worktree (optional)
verify = "bun test"               # must pass in the worktree before a merge lands (optional)
review = "suggested"              # off | suggested | required (merge refuses without an approving review)
reviewer = "codex"                # adapter for reviews (default: a different vendor than the author)
cleanup = "merged"                # merged (keep worktrees with unmerged work) | always | never
conflict_check = true             # predict conflicts between workers while they edit

[bus]
heartbeat_s = 15                  # worker → lead heartbeats/progress in the bus log (0 = off)
contact = "open"                  # open | tree (only parent/children/siblings may message each other)
max_body = 8000

[ui]
theme = "baton"                   # see themes.md; "system" = your terminal's palette
appearance = "auto"               # auto | dark | light — picks a theme's light/dark counterpart
layout = "grid"                   # grid | focus | swarm | wide
icons = "auto"                    # auto (logos if the terminal supports images) | unicode | nerd | ascii
border = "rounded"                # rounded | single | heavy | double | ascii | none
density = "comfy"                 # comfy | compact
render_style = "native"           # native (each agent looks like its own CLI) | unified
spinner = "star"                  # star dots circle moon arc pulse bounce line diamond
verbs = ["Spelunking", "Wrangling", "Schlepping"]   # spinner words
animations = true
fps = 30
mouse = true
min_card_width = 44
min_card_height = 9
max_columns = 4
show_bus = true
show_thoughts = false
card_fields = ["adapter", "version", "model", "dir", "approval"]   # idle identity card (+ role, session)
status_left = "{dot} {running}/{total} {noun} running · {calls} calls · {msgs} msgs"
status_right = "{unmerged}  {cost}  {added} {removed}  {repo}@{branch}"
timestamp_format = "ss.mmm"       # ss.mmm | hh:mm:ss | relative

[agent_style.claude]              # per adapter (or per agent name)
icon = "✻"
color = "#d97757"
name_pattern = "claude-{n}"       # how new agents of this adapter are named

[keys]                            # see keybindings.md
"pane.zoom" = ["z", "enter"]

[daemon]
persist = true
mcp_port = 0                      # 0 = random free port on 127.0.0.1
```

### Status bar variables

`{dot} {running} {total} {noun} {calls} {msgs} {cost} {tokens} {added} {removed} {unmerged} {repo} {branch}
{mode} {approvals} {spark} {theme} {layout}`. Variables with no value are dropped, along with any separator left
dangling.

### Playbooks

The orchestrator's system prompt is a Markdown playbook. To change how it plans, delegates and verifies,
drop `orchestrator.md` (or any `<mode>.md`, selected with `/mode <name>`) into `.baton/playbooks/` or
`~/.config/baton/playbooks/`. Workers use `worker.md`.
