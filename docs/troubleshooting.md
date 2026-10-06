# Troubleshooting & FAQ

Start with `baton doctor`: it checks your terminal, every agent (installed? signed in?), your
config and the daemon, and says what to do about each problem.

## Agents

**"claude is not signed in" (or codex, opencode…)**
Run `baton login claude`, which runs Claude Code's own sign-in. Using Claude Code in another
app (an IDE extension, the desktop app) doesn't sign in the `claude` command itself: check with
`claude auth status`. Setting `ANTHROPIC_API_KEY` works too. Baton refuses to start an agent
that isn't signed in, and the orchestrator is told which agents are ready instead.

**"out of quota" / "Free usage exceeded" / "usage limit"**
That agent's plan or credits ran out. Baton stops its turn, tells the orchestrator to use a
different agent, and keeps that agent out of new work for 30 minutes. Upgrade the plan, switch
models (`/model`), or let the others carry on.

**An agent "has shown no activity for 5 minutes"**
The watchdog noticed a busy agent going silent. The message includes its last status, which
usually explains it ("retrying…", a long build). Peek with `space`, nudge it with `@name …`,
interrupt it with `!name`, or let the orchestrator reassign the work. The threshold is
`watchdog.stall_s`.

**Agents keep asking for permission**
Raise the autonomy dial (`shift+tab`: normal → auto → yolo), or allow specific actions:

```toml
[[policy.rules]]
match = "Bash(bun test*)"
action = "allow"
```

**The orchestrator merged something unreviewed**
It can't do that by accident: `merge` refuses while a review is pending, failed or asked for
changes, unless the lead passes `force: true`. In that case it must tell you the work was
unreviewed. Set `workspace.review = "required"` to forbid unreviewed merges entirely.

**Two agents keep messaging each other**
Acknowledgments ("thanks", "got it") never start a new turn. After 6 messages between the same
two workers in 5 minutes, further chat waits in their inboxes and the orchestrator is told.

## Daemon

**"baton daemon exited" / it won't start**
Look at `.baton/run/batond.log` in the project: startup errors are written there. `baton stop`
then `baton` gives you a fresh daemon. `baton ps` shows what's running.

**After `baton update` something behaves like the old version**
Running daemons keep the version they started with. Run `baton stop` in each project.

**Where is everything stored?**
- `.baton/config.toml`: project settings (commit it).
- `.baton/state.db`: the event log of every run, used by history, replay and export (ignored by git).
- Worktrees: `~/.local/state/baton/worktrees/`.
- Global settings: `~/.config/baton/config.toml`.

## Terminal

**Icons show as boxes**
Install a [Nerd Font](https://www.nerdfonts.com) and select it in your terminal, or switch to
plain icons in `/settings` (`ui.icons = "ascii"`).

**Colors look wrong, or the background doesn't match my terminal**
`/background terminal` keeps your terminal's own (even transparent) background. `ctrl+t` picks a
theme. Every built-in theme meets WCAG contrast.

**tmux**
Add `set -g extended-keys on` and `set -as terminal-features 'xterm*:extkeys'` so that
`shift+tab` and `ctrl+` combinations reach Baton. `set -g allow-passthrough on` lets desktop
notifications through.

**Screen readers / plain output**
`baton watch` is a linear, screen-reader-friendly view with typed input.

**Windows**
Use WSL. A native Windows build exists (`baton-windows-x64.zip`), but agents and worktrees are
tested on macOS and Linux.

## FAQ

**Does Baton use my Claude/ChatGPT subscription directly?**
No. Baton runs the official agent CLIs, and they use their own logins. Baton never reads,
stores or forwards their credentials. Baton's built-in agent uses API keys you configure.

**Does my code leave my machine?**
Only the way it already does with the agents you run: each agent talks to its own provider.
Baton has no server. The phone view is served by the daemon on your machine, telemetry is off
unless you configure an OTLP endpoint, and nothing is sent to the Baton project.

**How much does it cost?**
Baton is free (MIT). Agents cost what they cost you anyway. `ctrl+e` shows spend per agent,
and `budget.run_usd` / `budget.per_agent_usd` stop work at a limit.

**Can I use it in CI?**
Yes: `baton run "<task>" --approve all --json` streams events as JSON lines and exits non-zero
on failure.
