/**
 * Recipes: proven multi-agent workflows the user picks by name (`/recipe best-of-3 <task>`).
 * A recipe is a prompt template for the orchestrator — {task} is replaced by the user's task.
 * Custom recipes: Markdown files in .baton/recipes/ or ~/.config/baton/recipes/ with a
 * front-matter block (name, description).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { configDir } from "@batonsh/kernel"

export interface Recipe {
  name: string
  title: string
  description: string
  /** Rough agent count, shown in the gallery. */
  agents: string
  template: string
  source: "builtin" | "global" | "project"
}

const BUILTIN: Recipe[] = [
  {
    name: "best-of-3",
    title: "Best of 3",
    description: "Three agents from different vendors solve the same task independently; checks run on each; the best one lands.",
    agents: "3 workers + judge",
    source: "builtin",
    template: `Recipe: BEST-OF-3.
Task: {task}

1. plan_tasks with one task per candidate (same objective, same acceptance check).
2. spawn_agent three workers from DIFFERENT vendors (e.g. claude, codex, opencode — whichever are available), each with
   the full task and acceptance check, label "candidate A/B/C". They work independently in their own worktrees.
3. wait_for_results. For each candidate: get_diff, run/inspect the acceptance check.
4. Pick the best (correctness first, then simplicity and diff size). Explain the choice in 3 bullets.
5. merge only the winner; kill the others.`,
  },
  {
    name: "plan-execute",
    title: "Plan → execute",
    description: "Write a concrete plan (tasks, files, checks), get your approval, then dispatch it in parallel where safe.",
    agents: "2-4 workers",
    source: "builtin",
    template: `Recipe: PLAN THEN EXECUTE.
Task: {task}

1. Investigate first (read the relevant code yourself). Then plan_tasks: small tasks, each with the files it owns, an
   acceptance check, and dependencies. Parallelize only tasks with disjoint files.
2. Wait for the user's approval of the plan (plan_tasks blocks when approval is on; otherwise summarize it first).
3. spawn_agent per task with task_id. As results arrive: get_diff, review, merge in dependency order.
4. Finish with what landed and how it was verified.`,
  },
  {
    name: "research-implement",
    title: "Research → implement",
    description: "One agent investigates and writes findings; a second implements from them; a third reviews.",
    agents: "3 workers",
    source: "builtin",
    template: `Recipe: RESEARCH THEN IMPLEMENT.
Task: {task}

1. spawn_agent a researcher (label "research", isolation shared, read-only instructions): map the relevant code, constraints and
   options; report findings as a concise brief with file references. wait_for_results.
2. spawn_agent an implementer from a different vendor with the brief + task (label "implement"). wait_for_results.
3. request_review on the implementer; if changes are requested, forward them and repeat once. Then merge.`,
  },
  {
    name: "implement-review",
    title: "Implement → review → fix",
    description: "One agent implements; an agent from another vendor reviews; fixes loop until approved, then merge.",
    agents: "2 workers",
    source: "builtin",
    template: `Recipe: IMPLEMENT, CROSS-VENDOR REVIEW, FIX.
Task: {task}

1. spawn_agent one implementer (label "implement") with the task and a concrete acceptance check. wait_for_results.
2. request_review (a different vendor reviews). If changes_requested: the notes go to the implementer automatically;
   wait_for_results and review again (max 2 rounds).
3. When approved: merge. Report the review findings and what changed.`,
  },
  {
    name: "debug-hypotheses",
    title: "Debug: competing hypotheses",
    description: "Several agents each test a different theory of the bug; evidence decides; one fix lands.",
    agents: "3 workers",
    source: "builtin",
    template: `Recipe: COMPETING HYPOTHESES DEBUGGING.
Problem: {task}

1. Reproduce or locate the failure yourself first if possible. Write 2-3 distinct hypotheses.
2. spawn_agent one investigator per hypothesis (different vendors when possible), label "hypothesis N": confirm or refute
   with evidence (logs, a failing test). Tell them to report evidence, not opinions; no fixes yet.
3. wait_for_results. Pick the hypothesis with the strongest evidence; ask that agent (send_message) to implement the
   minimal fix plus a regression test. Review (get_diff / request_review) and merge.`,
  },
  {
    name: "test-first",
    title: "Test first",
    description: "One agent writes failing tests that pin the behavior; another makes them pass without touching the tests.",
    agents: "2 workers",
    source: "builtin",
    template: `Recipe: TEST FIRST.
Task: {task}

1. spawn_agent a test writer (label "tests"): write tests that specify the behavior and FAIL now. It must not change
   source files. wait_for_results; merge the tests.
2. spawn_agent an implementer from another vendor (label "implement"): make the tests pass WITHOUT modifying them.
3. get_diff to confirm the tests were untouched, then merge.`,
  },
  {
    name: "shard",
    title: "Shard a big change",
    description: "Split a mechanical change (migration, rename, lint fixes) by directory across parallel agents.",
    agents: "2-6 workers",
    source: "builtin",
    template: `Recipe: SHARDED MECHANICAL CHANGE.
Task: {task}

1. Find all affected files; group them into 2-6 shards by directory so shards never share files. plan_tasks with one task
   per shard listing its files explicitly.
2. spawn_agent one worker per shard (cheap/fast models are fine), each told to touch ONLY its files.
3. As results arrive, merge shard by shard (merges are serialized); run the project's checks at the end.`,
  },
]

function parseRecipe(path: string, source: Recipe["source"]): Recipe | undefined {
  try {
    const text = readFileSync(path, "utf8")
    const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
    const meta: Record<string, string> = {}
    if (m)
      for (const line of (m[1] ?? "").split("\n")) {
        const kv = /^(\w+):\s*(.*)$/.exec(line)
        if (kv) meta[kv[1] as string] = (kv[2] as string).replace(/^["']|["']$/g, "")
      }
    const name = meta.name ?? basename(path, ".md")
    const template = (m ? m[2] : text)?.trim() ?? ""
    if (!template) return undefined
    return {
      name,
      title: meta.title ?? name,
      description: meta.description ?? "",
      agents: meta.agents ?? "",
      template: template.includes("{task}") ? template : `${template}\n\nTask: {task}`,
      source,
    }
  } catch {
    return undefined
  }
}

export function listRecipes(projectRoot: string): Recipe[] {
  const map = new Map<string, Recipe>()
  for (const r of BUILTIN) map.set(r.name, r)
  for (const [dir, source] of [
    [join(configDir(), "recipes"), "global"],
    [join(projectRoot, ".baton", "recipes"), "project"],
  ] as const) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md")) continue
      const r = parseRecipe(join(dir, f), source)
      if (r) map.set(r.name, r)
    }
  }
  return [...map.values()]
}

export function renderRecipe(r: Recipe, task: string): string {
  return r.template.replaceAll("{task}", task.trim())
}
