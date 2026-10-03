/** Input completion: @mentions, /commands and their arguments. */
import type { BatonConfig, RunState } from "@batonsh/kernel"
import { FRAME_STYLES, listThemes, STYLES } from "@batonsh/themes"

export interface Completion {
  /** Full input value after accepting. */
  replace: string
  label: string
  detail: string
}

export const LOCAL_COMMANDS: Record<string, string> = {
  theme: "/theme <name> — switch theme (ctrl+t for the picker)",
  style: "/style <classic|modern|minimal|accent|tabs|neon|retro|zen|paper|glass|brutalist> — the look (shapes, not colors)",
  background: "/background <theme|terminal> — paint the theme background or keep your terminal's",
  frame: "/frame <line|tab|bar|minimal|accent> — how panes are framed",
  layout: "/layout <grid|list|focus|swarm|wide>",
  icons: "/icons <auto|unicode|nerd|ascii>",
  border: "/border <rounded|single|heavy|double|ascii|none>",
  look: "/look <native|unified>",
  bus: "/bus — toggle the bus pane",
  thoughts: "/thoughts — toggle agent reasoning",
  zoom: "/zoom <agent>",
  help: "/help — keyboard shortcuts",
  settings: "/settings — every setting, live",
  compare: "/compare — candidates side by side, pick a winner",
  history: "/history — past runs: resume, export",
  costs: "/costs — spend per agent and vendor",
  guide: "/guide — short lessons on how Baton works",
  recipes: "/recipes — browse workflows",
  welcome: "/welcome — the first-run screen",
  web: "/web — follow & approve from your phone (QR code)",
  scores: "/scores — each agent's track record in this project",
  a2a: "/a2a — serve this team as an A2A agent (shows its URL)",
  focus: "/focus [minutes] — do not disturb: only approvals and errors get through (default 25)",
  quit: "/quit — leave (agents keep running)",
  shutdown: "/shutdown — stop the daemon and all agents",
}

export const REMOTE_COMMANDS: Record<string, string> = {
  spawn: "/spawn <adapter|profile> [count] [label…]",
  kill: "/kill <name|all>",
  interrupt: "/interrupt <name|all>",
  mode: "/mode <orchestrator|…>",
  autonomy: "/autonomy <normal|ask|auto|yolo> — how freely every agent acts (shift+tab)",
  yolo: "/yolo — toggle YOLO: no prompts, no sandbox, every agent",
  model: "/model <agent> <model>",
  label: "/label <agent> <text>",
  rename: "/rename <agent> <new-name>",
  agents: "/agents — installed adapters + auth",
  merge: "/merge <agent|all> — land worktree changes",
  sync: "/sync <agent>",
  undo: "/undo [agent] — undo the last merge",
  review: "/review <agent> [reviewer]",
  diff: "/diff <agent>",
  plan: "/plan approve|reject [notes]",
  recipe: "/recipe <name> <task> — proven workflows",
  approve: "/approve [all]",
  issue: "/issue <n|url> — hand a GitHub issue to the lead",
  pr: "/pr [title] — preview a PR from merged work · /pr confirm to open it",
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
      case "undo":
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
        options = ["grid", "list", "focus", "swarm", "wide"].map((v) => ({ v, d: "" }))
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
      case "style":
        options = STYLES.map((s) => ({ v: s.name, d: s.description }))
        break
      case "background":
        options = [
          { v: "theme", d: "Baton paints the theme's background" },
          { v: "terminal", d: "your terminal's own background shows through" },
        ]
        break
      case "frame":
        options = FRAME_STYLES.map((v) => ({ v, d: "" }))
        break
      case "autonomy":
        options = [
          { v: "normal", d: "each agent uses its own setting" },
          { v: "ask", d: "everyone asks before acting" },
          { v: "auto", d: "agents act; destructive commands ask" },
          { v: "yolo", d: "no prompts, no sandbox" },
        ]
        break
      case "pr":
        options = [{ v: "confirm", d: "push a baton/… branch and open the pull request" }]
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
