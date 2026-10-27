# Changelog

All notable changes to Baton. Versions follow [semver](https://semver.org); the control protocol
(`baton protocol`) and the event log format (BEP) carry their own version numbers.

## Unreleased

## 0.3.9 — 2026-10-27

**Fixes**
- The event log no longer grows with Baton's own agent or ACP agents (Gemini, Qwen, …) either: their
  running commands' output is shown live and stored once, like Claude's and Codex's. Logs are compacted
  once more, and a command whose result doesn't repeat its output keeps its last output.
- `baton -c "task"` (or `--resume` with a task) could start a second lead next to the resumed one; the
  task now goes to the resumed lead. Whatever asks for a lead at the same moment gets the same one.
- `--continue` resumes the last run that had agents (not the empty run `baton history` starts).
- Compacting the log waits for a daemon that is still shutting down (on macOS and Linux it could lose the
  run's last events).
- `ctrl+c` twice quits only right after its "press again" warning: a `ctrl+c` that closed a menu, cleared
  what you typed or left a text box no longer counts.
- Windows: a client that stops reading (a suspended laptop, a stalled phone) is disconnected instead of
  making the daemon hold everything for it, and lagging clients skip live output.
- HTML exports and replays show agents that stopped in full again.
- A long-running daemon checks for updates every day, not just when it starts.
- `/web` in the app: the other addresses it lists carry the access key.
- A worktree that can't be checked says why in one line.

## 0.3.8 — 2026-10-27

**A new web view** (`baton web`, `/web`)
- Redesigned from scratch: black, quiet, with a faint touch of depth (controls that look pressable, status
  lights, recessed code). A sidebar with the run, the autonomy switch and every agent on a desktop; tabs on
  a phone.
- Agents' work is readable: tool calls grouped and described in words (Run `npm test`, Edit `src/app.ts`)
  with their output and diffs a click away; thinking folded; Markdown with code blocks, tables and task lists;
  long messages shortened until you open them; worktree paths shortened to the part that matters.
- What agents send each other shows as cards: who to whom, done or failed, lines changed, acceptance checks,
  work waiting to be merged — without the instructions Baton adds for the agents.
- New views: Activity (the plan and the conversation between agents) and Changes (all unmerged work, with
  Merge). An inspector shows an agent's details, files and conflicts.
- The inbox lets you dismiss old problems; the tab title shows how many things need you.
- A command menu (Ctrl K), single-key navigation, `@` and `/` suggestions and message history in the input.
- Live updates no longer redraw the page: what you've opened, selected or scrolled to stays put, and only
  the agents whose work changed are sent again.
- Names in any script work (the page used to stay on "Connecting…" for a name like Łukasz or 山田).
- Agent text: a heading followed by many spaces no longer hangs the page or an HTML export, and file
  names and URLs keep their underscores (`__init__.py` isn't bold any more).

## 0.3.7 — 2026-10-27

**The event log stays small** (`.baton/state.db`)
- A running command's output was stored again with every new chunk, all of it each time: one
  long command could add hundreds of megabytes, and a busy project's log reached gigabytes.
  Output is now shown live (a few times a second) and stored once, with the command's result.
  Big raw tool results that repeat what the card shows aren't stored either.
- Logs from earlier versions are compacted once, the next time you start `baton` in the
  project (a 3.6 GB log became 170 MB). `baton compact` does it on demand.
- After updating, `baton` notices a daemon still running the older version and offers to
  restart it (`--yes` to just do it): the log gets compacted and the agents that were running
  come back.

**Knows when there's a new version**
- Once a day the daemon looks for a newer Baton release and says so in the orchestrator's feed,
  with the command that updates your install (`baton update`, npm or Homebrew). Leaving the
  app repeats it. Starting Baton never waits on this. `BATON_NO_UPDATE_CHECK=1` turns it off.

**Resume brings back what was running, quickly**
- Resuming a run starts only the agents that were still running when it ended. Agents you
  killed, or that failed or finished earlier, stay gone, and an agent restarted under the
  same name comes back once. (It used to bring back every agent the run ever had, including
  every agent an earlier resume had brought back.)
- The run list (`/resume`, `/history`, `baton history`) opens right away: it no longer
  reads every past run in full. Resuming reads only the agents' lifecycle and latest events.
- `baton --continue` (`-c`) resumes the last run, `baton --resume <run>` a given one, and
  `baton --resume` opens the list to pick from. `baton resume [run]` does the same.

**Several Baton windows at once**
- Starting Baton while another one was busy could crash it ("Failed to start HTTP Client
  thread") when the machine was short on memory. Baton now uses much less memory (bounded
  tool output and history per agent, nothing kept for agents that are gone, slow clients
  can't make the daemon queue without limit), checks agents a few at a time instead of all
  at once, and only contacts a local Ollama / LM Studio when something is listening there.

**Keys and copying**
- `ctrl+c` twice quits and stops all agents, from anywhere in the app. `/quit` still leaves
  them running in the background.
- Selecting text with the mouse copies it to the clipboard when you let go.
- `/web` shows the whole link (and the other addresses it's reachable at), and `c` copies it.
- Copying on Windows keeps non-English characters intact.

## 0.3.6 — 2026-10-11

**Resume brings the conversation back**
- Resuming a past run (`/history`, now also `/resume`) shows each agent's earlier conversation on
  its card, above an "earlier, from the resumed run" marker. Agents that support it (Claude,
  Codex, OpenCode, Gemini, …) also continue their own session, so they remember it too.
- The orchestrator is resumed as well: a lead that hasn't done anything yet makes way for the
  resumed one; a busy lead gets the earlier conversation shown above its own.

**Select the orchestrator like any agent**
- `tab` from the input (or ↑ from the top row of cards) selects the orchestrator: `z` zooms it,
  and the other card keys work on it too. `esc` goes back to typing.

**npm**
- Packages carry the repository link in the form npm expects (no more warnings on publish).

## 0.3.5 — 2026-10-11

**Pick models from a list**
- Worker model (`defaults.model`): the model for workers on your default worker agent, in
  `/settings` → Agents. ←→ cycles through the models that agent offers, enter types any name.
- Lead model works the same way, and both show what the agent offers.
- `/model <agent> ` suggests that agent's models as you type.
- The lists come from the agents themselves: Codex's model cache, `opencode models`, Claude's
  model names. An agent that can't say still takes any model you type.

## 0.3.4 — 2026-10-11

**Approvals with several Codex workers**
- Every Codex worker numbered its approval requests the same way, so when two of them were
  waiting, the newer request replaced the older one: the inbox showed only the last worker's
  request (or none, once that one was answered) while the other worker sat at "Waiting for
  approval". Requests are now unique across agents, so the inbox lists every one and approves
  the one you select.

## 0.3.3 — 2026-10-11

**Phone & web view**
- Closing the QR code screen and opening it again no longer fails with "port already in use".
  Reopening `/web` shows the running web view as it is (phone access stays on, same link), and
  esc says that it keeps running.
- When the web view does restart (switching phone access, HTTPS or Tailscale), it waits for the
  old port to free up, then picks a free one if it has to. A port you set yourself
  (`remote.port`) gets a clear message instead.

**Releases**
- npm publishing works without a token (trusted publishing), skips versions already up, and can
  be re-run for a released version (`only: npm`).

## 0.3.2 — 2026-10-11

**Windows: no more flashing console windows**
- Baton's background process has no console, so every command it started (git, agent CLIs,
  checks) used to pop up a console window that closed right away, sometimes dozens in a row.
  Every process Baton starts is now hidden, and a test keeps it that way.
- The verify command before a merge, `cmd:` secrets and notification commands now run in Git
  Bash or PowerShell on Windows instead of `sh`, which isn't there.

## 0.3.1 — 2026-10-11

**Every team feature has its own switch**
- `[features]` in the config: `roles`, `skills`, `acceptance` and `notes`. Switched off, the agents
  never hear of it: no tools, no text in their instructions, and the matching `spawn_agent` fields
  go away.
- Team notes are now opt-in (they write a file into your project). `baton init` asks.
- `baton features [name on|off]`, `/features [name on|off]` in the app, and a Team features page
  in `/settings`.
- `ui.markdown`: turn Markdown rendering off to see agents' raw text (`/settings` → Layout).
- Your own playbooks can follow the switches with `{{#notes}}…{{/notes}}` and `{{^notes}}…{{/notes}}`.
- `notes.enabled` is replaced by `features.notes`.

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
