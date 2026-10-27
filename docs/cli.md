# Command line

Every `baton` command, with its options. `baton --help` prints the short version, and a mistyped
command suggests the right one.

## Starting

| Command | What it does |
|---|---|
| `baton` | Open Baton in this project. The first time, it sets the folder up (finds your agents and test command, writes `.baton/config.toml`). If Baton is already running here, this re-attaches to it. |
| `baton "<task>"` | Open Baton and hand the task straight to the orchestrator. |
| `baton demo [task]` | Simulated agents, no tokens: learn the screen safely. `--workers 8` sets the team size, `--speed 2` slows it down, and `--no-task` waits for you to type one. |
| `baton init` | Run the project setup again. `-y` accepts the defaults. |

Options for `baton` and `baton demo`:

| Option | Meaning |
|---|---|
| `--orchestrator <agent>` | Which agent leads, for this session (`claude`, `codex`, `opencode`, …). |
| `--autonomy <normal\|auto\|yolo\|ask>` | Start with this autonomy level for every agent. `--yolo` is short for `--autonomy yolo`. |
| `--theme <name>` · `--layout <grid\|list\|focus\|swarm\|wide>` | Looks for this session (saved settings are untouched). |
| `-c`, `--continue` | Bring back the agents that were running when the last run ended. |
| `--resume [run]` | The same for a given run (an id, or its end, from `baton history`); alone, it opens the list to pick from. |
| `-y`, `--yes` | Accept setup defaults without asking. |

## Running without the screen

```sh
baton run "update the changelog for the last release" --approve all --json
```

| Option | Meaning |
|---|---|
| `--approve ask` (default) | Ask on the terminal when an agent needs permission. |
| `--approve all` / `--approve none` | Allow / deny everything your policy doesn't settle itself. Use one of these in CI. |
| `--json` | Print every event as one JSON line (for scripts). |
| `--timeout <seconds>` | Give up after this long (default 3600). |
| `--autonomy`, `--yolo`, `--orchestrator` | As above. |

The exit code is `0` when the run finished cleanly and `1` when it failed or timed out.

## Your agents

| Command | What it does |
|---|---|
| `baton doctor` | Check everything: your terminal, every agent (installed? signed in?), your config, the daemon. Start here when something's off. |
| `baton agents` | List the agent tools Baton found, with versions and sign-in status. |
| `baton login [agent]` | Run an agent's own sign-in (`baton login claude`, `baton login codex`, …). Without a name, it shows who needs one. Baton never sees your credentials. |

## Roles, skills and notes

| Command | What it does |
|---|---|
| `baton roles` | Every role workers can have (built-in and yours), with access, size and agent. |
| `baton role new <name>` | Scaffold `.baton/roles/<name>.md` to edit. |
| `baton skills` | Every skill workers can load, and where it comes from. |
| `baton skill new <name>` | Scaffold `.baton/skills/<name>/SKILL.md`. |
| `baton notes` · `baton notes add "<fact>"` | The team's notes about this project, or add one. |
| `baton features` · `baton features <name> on\|off` | Which team features are on (roles, skills, acceptance, notes), or switch one. |

In the app: `/features [name on|off]`, `/roles`, `/skills`, `/notes [add <text>]`, `/spawn <role> [agent] [count] [label]`,
`/team <name> [task]`. See [roles, skills and notes](roles.md).

## Runs and history

| Command | What it does |
|---|---|
| `baton history` | List past runs in this project (in the app: <kbd>ctrl</kbd>+<kbd>r</kbd> or `/resume` to resume one). |
| `baton resume [run]` | Resume a run: the agents that were still running when it ended come back with their conversations. The last run by default. |
| `baton compact` | Shrink this project's event log (`.baton/state.db`). Logs from before 0.3.7 are compacted once automatically. Stop the daemon first (`baton stop`). |
| `baton replay [run]` | Play a run back like a video: <kbd>space</kbd> pause, <kbd>,</kbd> <kbd>.</kbd> jump between moments, <kbd>-</kbd> <kbd>+</kbd> speed. |
| `baton export <run> [--format md\|html\|jsonl]` | Write a run out as Markdown (default), a standalone HTML page, or raw events. |
| `baton watch` | A plain, line-by-line view with typed input: screen-reader friendly, and good over slow connections. |

## From anywhere

| Command | What it does |
|---|---|
| `baton web` | Follow, approve and send tasks from a browser. `--lan` lets your phone on the same Wi-Fi connect (it prints a QR code), `--https` adds encryption with a certificate Baton makes for you, `--tailscale` publishes it on your tailnet, `--rotate` makes a new access link, `--stop` turns it off. |
| `baton mcp` | Run Baton as an MCP server, so Claude Desktop, Cursor or any MCP client can hand tasks to your team ([remote](remote.md)). |
| `baton a2a` | Serve your team as an A2A agent. `--port`, `--host`, `--public-url`, `--rotate`, `--stop` ([A2A](a2a.md)). |
| `baton issue <number\|url>` | Start with a GitHub issue as the task. |
| `baton pr [-y] [--title …]` | Open a draft pull request from what this run merged. Without `-y`, it shows the plan first ([integrations](integrations.md)). |

## Housekeeping

| Command | What it does |
|---|---|
| `baton ps` | Is Baton running in this project? Which agents? |
| `baton stop` | Stop Baton and every agent in this project. |
| `baton trust [--revoke]` | Allow (or take back) commands and safety changes that come from this project's `.baton/config.toml`. A cloned repo can't run anything until you do. |
| `baton config path` | Where the config files are. |
| `baton config get [key]` | The effective value of a setting (all of them without a key). |
| `baton config explain <key>` | Which file a value comes from, and what it means. |
| `baton config schema` · `defaults` | The JSON schema, or every default value. |
| `baton theme list` · `set <name>` | List themes, or pick one. |
| `baton update [--check] [version]` | Update to the latest release (checksum-verified). Installed through npm or Homebrew? It tells you the right command instead. |
| `baton protocol` | Protocol versions and handshake details (for SDK authors). |
| `baton --version` · `--help` | |

## Environment variables

| Variable | Effect |
|---|---|
| `BATON_THEME`, `BATON_LAYOUT`, `BATON_ICONS` | Override `ui.theme`, `ui.layout`, `ui.icons`. |
| `BATON_USER` | Your name in shared runs (default: your git `user.name`). |
| `BATON_NO_WELCOME=1` | Skip the first-run welcome. |
| `BATON_NO_IMAGES=1` | Never draw agent logos as images (glyphs instead). |
| `BATON_CONFIG_DIR` | Use a different global config folder (default `~/.config/baton`). |
| `BATON_REPO`, `BATON_DOWNLOAD_BASE` | Where `install.sh` and `baton update` download from (forks, mirrors). |

Every other setting has an entry in [configuration](configuration.md).
