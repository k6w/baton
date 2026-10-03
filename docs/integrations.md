# Teamwork & integrations

## Shared runs

Several people can watch and steer the same run: everyone who attaches with `baton` (TUI) or opens the web view
(`baton web`, see [remote.md](remote.md)) shows up in the status bar (`◎ dana, alex`) and gets a note when someone
joins or leaves. Messages show who wrote them (`dana: fix the header`), approvals show who answered ("allowed by
alex"), and you get a toast when someone else answers a question you might be looking at.

Names come from `BATON_USER`, else your git `user.name`, else your OS user; the web view asks once.

## GitHub

| | |
|---|---|
| `/issue 42` · `baton issue 42` | hands the issue (title, body, labels, recent comments) to the lead as a task; also `#42`, `owner/repo#42` or a URL |
| `/pr [title]` · `baton pr` | **preview**: the files this run merged that are still uncommitted, the branch, base and description |
| `/pr confirm [title]` · `baton pr -y` | pushes a `baton/<title>-<run>` branch and opens a pull request (draft by default) |

The pull request never touches your working tree, index or current branch: the commit is built through a
temporary index from `HEAD` plus exactly the files Baton merged in this run, as they are now, then pushed to a new
branch. Unrelated edits and staged files stay out of it. The description lists the lead's summary, which agent
changed which files, review verdicts, the verify command and `Closes #42` when the run started from an issue.

It needs a token with repo access: `GITHUB_TOKEN` / `GH_TOKEN`, `gh auth token`, or `github.token`
(`env:` / `cmd:` / `keychain:` reference). GitHub Enterprise: set `github.api_url`.

## Agents talking to agents

- **MCP:** `baton mcp` makes Baton a tool for other agents and apps (Claude Desktop, Cursor, Claude Code…): run a
  task, follow it, answer approvals, diff and merge. See [remote.md](remote.md#baton-as-an-mcp-server).
- **A2A:** `baton a2a` serves the whole team as one [A2A](https://a2a-protocol.org) agent, and the `a2a` adapter adds
  any A2A agent to your team. See [a2a.md](a2a.md).
- **Python:** `pip install ./sdk-python` (`import baton`) drives a run from scripts and notebooks. See
  [sdk.md](sdk.md#python).

## Track record

Baton keeps score per agent (adapter · model) and kind of task (tests, bugfix, refactor, feature, docs, ui, review,
research, perf): merged work and approving reviews count for it; failed merges, requested changes and failed turns
against it (smoothed, so one result isn't 100%). `/scores` shows the table. The lead's `pick_agent(task)` tool ranks
the installed agents with it — close calls go to the cheaper agent per success — and suggests a model tier.

## Replay

`baton replay [run|last]`, or `p` in the history screen (`ctrl+r`), plays a past run back in the full UI:
`space` pause, `, .` jump between moments (agents starting, merges, failures, approvals, reviews, plans), `[ ]` ±10
s, `- +` speed, `esc` back. Long pauses are shortened so a 40-minute run plays in a few minutes.

## Focus & sounds

`/focus [minutes]` (default 25) holds everything except approvals and errors — no toasts, notifications or
sounds — and tells you what came in when it ends. `notify.sound = "system"` plays a different sound for approvals,
finished work, errors and merges; `[notify.sounds]` takes your own files.

## Editing the plan

`ctrl+g` shows the task plan as a table you can edit: `J`/`K` reorder, `e` title, `d` details, `c` "done when",
`p` prerequisites, `g` preferred agent, `n` add a task, `x` remove. While a plan waits for approval, your edits go
to the lead with it; edits to a running plan are sent to the lead when you close the table.
