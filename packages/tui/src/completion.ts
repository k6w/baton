/** Input completion: @mentions, /commands and their arguments. */
import type { BatonConfig, RunState } from "@batonsh/kernel"
import { listThemes } from "@batonsh/themes"

export interface Completion {
  /** Full input value after accepting. */
  replace: string
  label: string
  detail: string
}

export const LOCAL_COMMANDS: Record<string, string> = {
  theme: "/theme <name> — switch theme (ctrl+t for the picker)",
  layout: "/layout <grid|focus|swarm|wide>",
  icons: "/icons <auto|unicode|nerd|ascii>",
  border: "/border <rounded|single|heavy|double|ascii|none>",
  look: "/look <native|unified>",
  bus: "/bus — toggle the bus pane",
  thoughts: "/thoughts — toggle agent reasoning",
  zoom: "/zoom <agent>",
  help: "/help — keyboard shortcuts",
  settings: "/settings — every setting, live",
  history: "/history — past runs: resume, export",
  costs: "/costs — spend per agent and vendor",
  guide: "/guide — short lessons on how Baton works",
  recipes: "/recipes — browse workflows",
  welcome: "/welcome — the first-run screen",
  quit: "/quit — leave (agents keep running)",
  shutdown: "/shutdown — stop the daemon and all agents",
}

export const REMOTE_COMMANDS: Record<string, string> = {
  spawn: "/spawn <adapter|profile> [count] [label…]",
  kill: "/kill <name|all>",
  interrupt: "/interrupt <name|all>",
  mode: "/mode <orchestrator|…>",
  model: "/model <agent> <model>",
  label: "/label <agent> <text>",
  rename: "/rename <agent> <new-name>",
  agents: "/agents — installed adapters + auth",
  merge: "/merge <agent|all> — land worktree changes",
  sync: "/sync <agent>",
  review: "/review <agent> [reviewer]",
  diff: "/diff <agent>",
  plan: "/plan approve|reject [notes]",
  recipe: "/recipe <name> <task> — proven workflows",
  approve: "/approve [all]",
  deny: "/deny [all]",
}

const RECIPES: [string, string][] = [
  ["best-of-3", "3 vendors solve it independently; best lands"],
  ["plan-execute", "plan → your approval → parallel execution"],
  ["research-implement", "researcher → implementer → reviewer"],
  ["implement-review", "implement → cross-vendor review → fix"],
  ["debug-hypotheses", "competing theories, evidence decides"],
  ["test-first", "failing tests first, then make them pass"],
  ["shard", "split a mechanical change by directory"],
]

const KNOWN_ADAPTERS = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "cursor",
  "copilot",
  "goose",
  "qwen",
  "kiro",
  "droid",
  "cline",
  "claude-acp",
  "codex-acp",
  "opencode-acp",
  "acp",
  "mock",
]

let themeNames: string[] | undefined

export function completions(input: string, run: RunState, config: BatonConfig): Completion[] {
  if (!input) return []
  // /command
  const cmd = /^\/(\w*)$/.exec(input)
  if (cmd) {
    const q = (cmd[1] ?? "").toLowerCase()
    return Object.entries({ ...REMOTE_COMMANDS, ...LOCAL_COMMANDS })
      .filter(([k]) => k.startsWith(q))
      .map(([k, d]) => ({ replace: `/${k} `, label: `/${k}`, detail: d.replace(/^\/\S+\s*/, "") }))
  }
  const arg = /^\/(\w+)\s+(\S*)$/.exec(input)
  if (arg) {
    const [, c, q = ""] = arg
    let options: { v: string; d: string }[] = []
    const agents = () =>
      [...run.agents.values()].filter((a) => a.status !== "exited").map((a) => ({ v: a.name, d: `${a.adapter}${a.label ? ` · ${a.label}` : ""}` }))
    switch (c) {
      case "spawn":
        options = [
          ...Object.keys(config.agents).map((k) => ({ v: k, d: `profile → ${config.agents[k]?.adapter}` })),
          ...KNOWN_ADAPTERS.map((v) => ({ v, d: "adapter" })),
        ]
        break
      case "kill":
      case "interrupt":
        options = [{ v: "all", d: "every agent" }, ...agents()]
        break
      case "model":
      case "label":
      case "rename":
      case "zoom":
      case "sync":
      case "review":
      case "diff":
        options = agents()
        break
      case "merge":
        options = [{ v: "all", d: "every worktree" }, ...agents()]
        break
      case "recipe":
        options = RECIPES.map((r) => ({ v: r[0], d: r[1] }))
        break
      case "plan":
        options = [
          { v: "approve", d: "let the orchestrator dispatch" },
          { v: "reject", d: "send it back with notes" },
        ]
        break
      case "theme":
        themeNames ??= listThemes({ opencode: true }).map((t) => t.name)
        options = themeNames.map((v) => ({ v, d: "" }))
        break
      case "layout":
        options = ["grid", "focus", "swarm", "wide"].map((v) => ({ v, d: "" }))
        break
      case "icons":
        options = ["auto", "unicode", "nerd", "ascii"].map((v) => ({ v, d: "" }))
        break
      case "border":
        options = ["rounded", "single", "heavy", "double", "ascii", "none"].map((v) => ({ v, d: "" }))
        break
      case "look":
        options = ["native", "unified"].map((v) => ({ v, d: "" }))
        break
      case "approve":
      case "deny":
        options = [{ v: "all", d: "every pending request" }]
        break
    }
    return options
      .filter((o) => o.v.toLowerCase().startsWith(q.toLowerCase()) && o.v !== q)
      .slice(0, 12)
      .map((o) => ({ replace: `/${c} ${o.v} `, label: o.v, detail: o.d }))
  }
  // @mention as the last token
  const m = /(^|\s)@([\w.:-]*)$/.exec(input)
  if (m) {
    const q = (m[2] ?? "").toLowerCase()
    const prefix = input.slice(0, input.length - (m[2]?.length ?? 0) - 1)
    const names = [
      ...[...run.agents.values()]
        .filter((a) => a.status !== "exited")
        .map((a) => ({ v: a.name, d: `${a.adapter}${a.label ? ` · ${a.label}` : ""} · ${a.status}` })),
      { v: "all", d: "broadcast to every agent" },
      ...[...new Set([...run.agents.values()].map((a) => a.role).filter(Boolean))].map((r) => ({ v: `role:${r}`, d: "everyone with this role" })),
    ]
    return names
      .filter((n) => n.v.toLowerCase().startsWith(q))
      .slice(0, 12)
      .map((n) => ({ replace: `${prefix}@${n.v} `, label: `@${n.v}`, detail: n.d }))
  }
  return []
}
