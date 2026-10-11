# Workspaces, merging & reviews

Parallel agents editing one working tree overwrite each other. Baton gives every **worker** its own git
worktree and lands their work through a merge queue. Only the orchestrator works in your project directly.

```
your project (working tree, your index untouched)
   ▲ merge = 3-way (git merge-tree) against the project *as it is now*, applied as a patch
   │
   ├── ~/.local/state/baton/worktrees/<project>/codex-1   branch baton/<run>/codex-1
   ├── …/claude-1                                         branch baton/<run>/claude-1
   └── …/opencode-1                                       branch baton/<run>/opencode-1
```

## Lifecycle

1. **Spawn.** The worker gets a worktree branched from a snapshot of the project *including your uncommitted
   changes*, so it starts from exactly what you see.
   - Dependency folders (`node_modules`, `.venv`, `vendor`) are symlinked in, and `.env` files are copied.
   - `workspace.setup` runs once in the new worktree, if set.
   - Worktrees live outside the repository, so test runners and file watchers in your project never see them.
2. **Work.** After each edit or command, Baton recomputes the worker's changes and shows them on its card (`⎇ 3 files +12 −4`).
   - If two workers' changes overlap, Baton checks them with `git merge-tree`.
   - When they truly conflict, both cards show `▲ conflicts with …` and the orchestrator is told **before** anyone tries to merge.
3. **Review** (optional or required). `request_review` (the orchestrator tool), `/review <agent>` or `r` in the Changes overlay starts the review.
   - Baton spawns a reviewer from a **different vendor** (Codex reviews Claude's work, Claude reviews Codex's, …) inside the author's worktree, with the full diff in its prompt.
   - The reviewer answers with `submit_review(approve | changes_requested, notes)`.
   - "Changes requested" goes back to the author as a task; the verdict goes to the orchestrator.
4. **Merge.** `merge` (the orchestrator tool), `/merge <agent|all>` or `m` in the Changes overlay or diff view:
   1. Runs `workspace.verify` in the worktree, if set. If it fails, nothing lands.
   2. Commits the worker's changes on its own branch.
   3. Three-way merges them against a **fresh snapshot of your project**, so your own edits made in the meantime are preserved.
   4. Applies the result to your working tree. Your index and your branch are never touched: you review and commit the result yourself.
5. **Conflicts.** If the merge conflicts, run `sync <agent>`. It brings the project's current state into the worker's
   worktree, with conflict markers, and asks the worker to resolve them. Then merge again.
6. **Cleanup.** When an agent is removed, its worktree and branch are deleted. Exception: if it still has unmerged work,
   it's kept and Baton tells you where it is (`workspace.cleanup = "merged"`).

## In the TUI

| | |
|---|---|
| card badge | `⎇ 2 files +9 −1 · review ✓`, `▲ conflicts with codex-2 a.ts`, `◐ verifying…`, `✓ merged`, `⚑ src/auth/**` (file claims) |
| status bar | `⎇ 7 unmerged` or `▲ 1 conflict` |
| `ctrl+d` Changes | every worker branch with its files, `+/−`, review and merge state · `enter` diff · `m` merge · `s` sync · `r` review |
| `d` on a focused card | that agent's diff (`m` merges from there) |
| `ctrl+g` Task plan | the orchestrator's plan with states, owners and dependencies · `a` approve / `x` reject when a plan is proposed |

## File claims

Workers can call `claim_files(["src/auth/**"])` before they start editing. Another worker that tries to claim an
overlapping path is told who holds it. If a worker edits a claimed file anyway, it gets an immediate message
asking it to coordinate. Claims expire (30 minutes by default) and are released when the agent is removed.

## Task plans

The orchestrator records its plan with `plan_tasks` (ids, titles, dependencies, owned files, acceptance checks)
and links workers to tasks with `spawn_agent(task_id: …)`. Task states update as results come back.

With `orchestrator.plan_approval = true`, `plan_tasks` waits for you:
- `ctrl+g` shows the plan.
- `/plan approve` lets the orchestrator dispatch.
- `/plan reject <why>` sends your notes back so it revises the plan.

## Opting out

`workspace.isolation = "shared"` makes every agent edit the project directly, the way most multi-agent tools
work. There's no merge step then, so keep the agents' files disjoint. Folders that aren't git repositories always
use shared mode.
