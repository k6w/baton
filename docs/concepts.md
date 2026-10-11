# How Baton works

A tour of the ideas behind Baton, in plain words. No prior knowledge of "multi-agent" anything
needed. If you'd rather just try it, run `baton demo` and come back later.

## The short version

1. You type a task.
2. The **orchestrator**, one of your coding agents, plans it and starts **workers**.
3. Each worker edits its **own copy** of your project.
4. The workers can message each other while they work.
5. When a worker is done, an agent from a **different vendor** reviews its changes.
6. Your tests run, and the changes are **merged** into your project.
7. You watch all of it, and step in whenever you want.

## The screen

```
╭─ ✱ orchestrator ────────────────────────────── ✓ 2/4 · $0.23 ─╮   ← the lead's conversation with you
│ > fix the typo in the README and add a test                     │
│ • On it, splitting this up across the team.                     │
│ ❯ message the orchestrator · @agent · /command                  │   ← where you type
╰─────────────────────────────────────────────────────────────────╯
╭─ ✱ claude-1 ── find typo ─╮╭─ >_ codex-1 ── ? needs you ─╮╭─ ⇄ bus ─╮   ← one card per agent
│ ● Update(README.md)        ││ ? Run bun test, allow?       ││ c1→lead │      and the message bus
╰────────────────────────────╯╰──────────────────────────────╯╰─────────╯
 ⚑ 1 needs you   enter send  @ talk to an agent  / commands  tab agents  ← hints for what you can press
 ● 3/4 agents running · 15 calls · 4 msgs                 $0.23  +7 -7   ← status: activity, cost, lines changed
```

- **Orchestrator pane (top).** Your conversation with the lead agent. Type here.
- **Agent cards.** One per worker, showing what it's doing right now: commands, edits as diffs,
  test results. Its label (top right) says what it was asked to do.
- **Bus.** Messages between agents, as they happen.
- **Status bar.** How many agents are busy, what it has cost so far, and lines added/removed. A
  **⚑** means something needs you.

## The agents

**The orchestrator** (the "lead") is the agent you talk to. Pick which one in `/settings` or
`.baton/config.toml`; Baton picks your best signed-in agent on the first run. The lead:

- decides how many workers a task needs (often just one, sometimes several in parallel);
- chooses agents and models, using what has worked before in this project (`/scores`);
- splits the work so workers don't edit the same files;
- reviews, merges and reports back to you.

**Workers** are regular coding agents (Claude Code, Codex, OpenCode, Gemini, …) that Baton
starts for you. They're named after their agent, like `claude-1` and `codex-2`. You can talk to
any of them directly: `@codex-2 use the existing helper instead`.

You can also start agents yourself: `/spawn codex 2 write tests` starts two Codex workers with
that label.

## Worktrees: every worker gets its own copy

The biggest worry with several agents is them stepping on each other, or on your work in
progress. Baton avoids this with **git worktrees**:

- Each worker gets a separate folder with a full copy of your project, including your
  uncommitted changes.
- Workers can only edit their own copy, so nothing they do touches your files directly.
- Baton watches all the copies and warns early when two workers change the same lines
  ("conflict ahead"), so the lead can coordinate them.

Your project needs to be a git repository. Baton offers to set one up if it isn't.

## Reviews and merging

When a worker finishes, its changes are still only in its own copy. Getting them into your
project takes three steps:

1. **Review.** The lead asks an agent from a different vendor to review the diff (Codex reviews
   Claude's work, Claude reviews Codex's, …). The reviewer approves or asks for changes, and
   requested changes go back to the author automatically. A merge waits while a review is still
   open.
2. **Checks.** Your verify command runs (`workspace.verify`, for example `bun test`). If it
   fails, nothing is merged.
3. **Merge.** A 3-way merge applies the changes to your working folder, on top of anything you
   changed meanwhile. Your branch, commits and staged files are never touched, so committing is
   up to you.

Changed your mind? `/undo` reverts the last merge. <kbd>ctrl</kbd>+<kbd>d</kbd> shows every
agent's changes, where you can read diffs, comment on lines, merge or ask for a review yourself.

How strict reviews are is up to you: `workspace.review = "off" | "suggested" | "required"`.

## Roles, skills and what the team remembers

The lead can give a worker:
- a **role**: tester, reviewer, debugger, security, … or your own, with instructions and an
  access level (reviewers can't edit files);
- **skills** to look up when it needs them;
- the **files** it owns;
- an **acceptance** command. Baton runs it, and the work counts only when the check passes.

If you turn on **team notes**, facts agents learn go into `.baton/notes.md` and every new worker
starts with them. Each of these has its own on/off switch (`baton features`). Details:
[roles, skills and notes](roles.md).

## Agents talking to each other

Each agent gets a few extra tools from Baton:
- **messaging:** `send_message`, `read_inbox`;
- **coordination:** `list_agents`, `claim_files`, `report_progress`.

So a worker can say "I've changed the API, you'll need the new field" to another. The lead gets
more tools: starting agents, waiting for results, merging, reviewing.

Some things happen automatically:

- When a worker finishes, its result goes back to whoever gave it the task.
- Messages reach a busy agent without interrupting it (in agents that support that); otherwise
  they wait for its next turn.
- Thank-you and "got it" messages don't wake anyone up. Two agents chatting in circles get
  stopped, and the lead is told.

## You stay in charge

**The inbox** (<kbd>ctrl</kbd>+<kbd>a</kbd>) collects everything that needs you:
- approvals ("codex-1: Bash(rm -rf dist)");
- plans waiting for your OK;
- agents that got stuck, loop, or ran out of quota;
- conflicts and finished work.

<kbd>ctrl</kbd>+<kbd>n</kbd> jumps to the next item, and <kbd>ctrl</kbd>+<kbd>y</kbd> approves the
oldest request. When Baton isn't the focused window, you get a desktop notification.

**The autonomy dial** (<kbd>shift</kbd>+<kbd>tab</kbd>) sets how freely *all* agents act:

| Mode | Meaning |
|---|---|
| **normal** | each agent's own defaults: edits are fine, risky commands ask |
| **auto** | they act on their own inside your project; destructive commands still ask |
| **yolo** | no prompts and no sandbox, for every agent |
| **ask** | every edit and command waits for you |

**Your rules** always hold, even in yolo:

```toml
[[policy.rules]]
match = "Bash(git push*)"
action = "deny"
```

**Budgets** stop spending at a limit (`budget.run_usd`, `budget.per_agent_usd`), and a
**watchdog** flags agents that go quiet or repeat themselves.

**Trust:** a repository you cloned can't run commands or loosen safety settings through its
`.baton/config.toml` until you approve that with `baton trust`.

## Behind the scenes

- **The daemon.** Baton runs a small background process per project (`batond`). The screen you
  see is just a window onto it. Quit with <kbd>ctrl</kbd>+<kbd>c</kbd> and your agents keep
  working; run `baton` again to come back. `baton stop` ends everything.
- **History.** Every event is saved, so you can resume, replay or export any run
  (<kbd>ctrl</kbd>+<kbd>r</kbd>, `baton replay`, `baton export`).
- **Adapters.** Baton talks to each agent through its real programming interface (Codex's app
  server, the Claude Agent SDK, OpenCode's server, the Agent Client Protocol), not by reading its
  screen. That's how it gets exact diffs, costs and approvals from all of them.
- **Your credentials** stay with your agents. Baton runs the official tools with your own logins
  and never reads, stores or forwards their tokens.

## Where to next

- [Quickstart](quickstart.md): install and the first run, step by step.
- [Workspaces, reviews & merging](workspaces.md): every option for worktrees and merges.
- [Configuration](configuration.md): every setting.
- [Troubleshooting & FAQ](troubleshooting.md): when something's off.
