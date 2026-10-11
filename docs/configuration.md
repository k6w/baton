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

Most of this is also in the **settings screen** (`ctrl+s`): search, change values with live preview, and choose
whether they're written to the project or global file (comments are preserved).

`baton config explain ui.theme` tells you which layer set a value. An invalid value is reported and ignored
on its own: every other setting still applies. `baton config schema` prints a JSON Schema you can use for
editor autocompletion.

## Autonomy (and YOLO)

`policy.autonomy` is one dial for **every** agent in a run — the lead and all workers, including agents that are
already running:

| Level | What happens |
|---|---|
| `normal` (default) | each agent uses its own `approval` setting and the `policy.preset` decides what they ask |
| `ask` | everyone asks before editing or running anything (strict policy) |
| `auto` | agents act on their own; destructive commands (rm -rf, git push, sudo…) still ask |
| `yolo` | no prompts and no sandbox for anyone. Your `deny` rules still apply |

Switch it for the current run with `shift+tab` in the input (normal → auto → YOLO → ask), `/autonomy <level>`,
`/yolo`, the command palette, or start with `baton --yolo` / `--autonomy auto`. Agents whose CLI can change modes
mid-session (Claude Code, Codex, ACP agents that expose modes, the mock agent) switch in place; the rest keep their
start-up sandbox until restarted while Baton's policy auto-decides what they ask. Requests already waiting in your
inbox are re-decided under the new level. The current level shows in the status bar and on the lead's pane (red in
YOLO).

## Trusting a project

Cloning a repository must never be enough to run its commands. Project config (`.baton/config.toml` and
`config.local.toml`) is applied normally, **except** for settings that execute code or widen what agents may do.
Those are held back until you run `baton trust` in the project:

| Held back until trusted | Why |
|---|---|
| `plugins` (pinned by file content) | runs code from the repo |
| `agents.<name>.command` / `args` / `env` / `options.command` … | chooses what binary runs |
| `workspace.setup`, `workspace.verify`, `workspace.dir` | shell commands, file locations |
| `notify.command`, `notify.webhook`, `telemetry.otlp_endpoint` / `headers` | runs commands / sends run data elsewhere |
| `remote.lan` / `autostart` / `public_url`, `a2a.host` / `autostart` / `public_url` / `token = false` | expose the run on the network |
| `github.api_url`, `github.token` | a repo-chosen endpoint would receive your GitHub token |
| `providers.<name>.base_url` / `api_key` / `headers` | `cmd:` secrets run commands; a repo endpoint could receive your key |
| `approval = "auto"` / `"yolo"`, `policy.preset = "yolo"`, `policy.autonomy = "auto"` / `"yolo"`, `[[policy.rules]]` with `action = "allow"` | widen permissions |

`baton trust` lists exactly what it would allow and asks first (`-y` to skip the question). Trust is pinned to the
values: when one of them changes (or a plugin file is edited), that entry is held back again. `baton doctor`
and the daemon log say what is held back; `baton config explain <key>` marks it; `baton trust --revoke` undoes
everything. Values you set yourself in the settings screen are trusted automatically. Your global config is
always trusted.

A config file that fails to parse while the daemon is running (a half-saved edit) doesn't reset anything: the
previous settings stay active until the file is valid again (`baton config reload` re-reads it).

## Full reference

```toml
plugins = []                      # adapter plugins, see agents.md (project plugins need `baton trust`, see above)

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

[roles.tester]                    # built-in roles, .baton/roles/*.md and these merge field by field (see roles.md)
description = "Writes and fixes tests"
prompt = "Use the fixtures in test/fixtures; never mock the database."
adapter = "codex"                 # who plays it (default: whoever the lead picks)
tier = "medium"                   # small | medium | large → [routing]
access = "write"                  # read-only: Baton refuses its edits, even in yolo
acceptance = "bun test"           # must pass before its result counts (2 retries)
skills = ["bun-testing"]          # skills it starts with

[skills]
dirs = []                         # extra folders of <name>/SKILL.md
claude = true                     # offer the project's .claude/skills to every agent
claude_user = false               # and your ~/.claude/skills

[notes]
enabled = true                    # agents record facts (note) in .baton/notes.md; new workers start with them
max = 30                          # notes given to each new worker (all stay searchable with recall)
reviews = true                    # save review findings (changes requested) as notes

[teams]                           # /team <name> [task] starts these
frontend = [{ role = "frontend", adapter = "claude" }, { role = "tester", adapter = "codex" }]

[budget]
run_usd = 10                      # interrupt everything at $10 (warn at warn_at × limit)
per_agent_usd = 3
max_agents = 16
soft_max_agents = 4               # above this, the orchestrator must get your OK to spawn more
max_depth = 2                     # how deep agents may spawn agents
warn_at = 0.8

[policy]
autonomy = "normal"               # normal | ask | auto | yolo — one dial for every agent (shift+tab switches it live)
preset = "balanced"               # strict | balanced | yolo (used at autonomy = normal)
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
ports = 2                         # BATON_PORT_0..1 and PORT per worktree (blocks of 10 from port_base)
port_base = 4100

[watchdog]
stall_s = 300                     # flag a busy agent with no activity for 5 minutes (0 = off)
loop_repeats = 4                  # flag the same tool call 4× in a row (0 = off)

[notify]
desktop = true                    # via the terminal (OSC 9/777); only when Baton isn't focused…
when_focused = false              # …unless this is on
bell = false
sound = "off"                     # off | system (a different system sound per kind; plays even while focused)
# sounds = { approval = "~/sounds/ding.wav" }   # your own files per kind
events = ["approval", "done", "error"]   # + "merge"
# webhook = "https://ntfy.sh/my-baton"     # reach you when no TUI is attached (phone push via ntfy)
# webhook_format = "ntfy"                 # json | ntfy | slack
# command = "say \"$BATON_TITLE\""         # any command; JSON on stdin

[remote]                          # the phone / web view (docs/remote.md)
autostart = false
lan = false                       # reachable from other devices on your network
port = 0                          # fixed port keeps bookmarks working
tls = "off"                       # off | self-signed (HTTPS with a certificate Baton creates)
tailscale = false                 # publish via `tailscale serve` (real certificate on your tailnet)
# public_url = "https://my-mac.tailnet.ts.net:4777"   # for one-tap approve buttons in notifications

[a2a]                             # serve the team as an A2A agent (docs/a2a.md)
autostart = false
host = "127.0.0.1"
port = 0
token = true                      # require the bearer token printed by `baton a2a`
idle_ms = 2000                    # quiet time before a task counts as done
questions_as_input = true         # a lead's closing question becomes input-required
allow_private_push = false        # allow push webhooks to private/loopback addresses (local setups only)

[github]                          # /issue and /pr (docs/integrations.md)
api_url = "https://api.github.com"   # GitHub Enterprise: https://ghe.example.com/api/v3
# token = "env:GITHUB_TOKEN"      # default: $GITHUB_TOKEN, $GH_TOKEN or `gh auth token`
remote = "origin"
draft = true

[telemetry]
# otlp_endpoint = "http://localhost:4318"   # OpenTelemetry traces: invoke_agent / execute_tool spans (no content)
# headers = { "x-honeycomb-team" = "…" }

[routing]                         # spawn_agent(tier: …) → model
claude = { small = "haiku", medium = "sonnet", large = "opus" }
# codex = { small = "…", large = "…" }

[bus]
heartbeat_s = 15                  # worker → lead heartbeats/progress in the bus log (0 = off)
contact = "open"                  # open | tree (only parent/children/siblings may message each other)
max_body = 8000

[ui]
theme = "baton"                   # see themes.md; "system" = your terminal's palette
style = "classic"                 # classic | modern | minimal | accent | tabs | neon | retro | zen (sets the next five)
frame = "line"                    # line | tab | bar | minimal | accent — how panes are framed
status_style = "plain"            # plain | blocks | powerline | minimal
background = "theme"              # theme | terminal (transparent: your terminal's own background)
brand_borders = false             # tint agent cards with their brand color
appearance = "auto"               # auto | dark | light — picks a theme's light/dark counterpart
layout = "grid"                   # grid | list | focus | swarm | wide
hints = true                      # key-hint bar
tab_title = true                  # "⚑2 baton · project" in the terminal tab
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
