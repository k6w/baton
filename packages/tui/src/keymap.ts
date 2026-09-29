/**
 * Keymap: every action is a command id; bindings are data. Users override any binding in
 * config (`[keys] "pane.zoom" = ["z", "enter"]`). The help overlay and the command palette
 * are generated from this registry.
 */

export type KeyContext = "global" | "input" | "grid" | "zoom" | "overlay"

export interface CommandDef {
  id: string
  title: string
  /** Where the binding is active. "global" fires everywhere (only modifier keys while typing). */
  context: KeyContext
  keys: string[]
  /** Hidden from the palette (navigation primitives). */
  hidden?: boolean
}

export const DEFAULT_COMMANDS: CommandDef[] = [
  { id: "app.palette", title: "Command palette", context: "global", keys: ["ctrl+p", "ctrl+k"] },
  { id: "app.help", title: "Keyboard shortcuts", context: "grid", keys: ["?"] },
  { id: "app.help", title: "Keyboard shortcuts", context: "global", keys: ["f1"], hidden: true },
  { id: "app.quit", title: "Quit (agents keep running in the daemon)", context: "global", keys: ["ctrl+c"] },
  { id: "app.shutdown", title: "Quit and stop all agents", context: "global", keys: ["ctrl+q"] },
  { id: "inbox.open", title: "Inbox: everything that needs you", context: "global", keys: ["ctrl+a"] },
  { id: "attention.next", title: "Jump to the next thing that needs you", context: "global", keys: ["ctrl+n"] },
  { id: "approvals.allow", title: "Approve oldest request", context: "global", keys: ["ctrl+y"] },
  { id: "settings.open", title: "Settings…", context: "global", keys: ["ctrl+s", "f2"] },
  { id: "compare.open", title: "Compare candidates (best-of-N) and pick a winner", context: "global", keys: [] },
  { id: "history.open", title: "History: past runs — resume or export", context: "global", keys: ["ctrl+r"] },
  { id: "costs.open", title: "Costs: spend per agent and vendor, budgets", context: "global", keys: ["ctrl+e"] },
  { id: "guide.open", title: "Guide: short lessons on how Baton works", context: "global", keys: [] },
  { id: "recipes.open", title: "Recipes: proven multi-agent workflows", context: "global", keys: [] },
  { id: "welcome.open", title: "Welcome screen", context: "global", keys: [] },
  { id: "theme.pick", title: "Choose theme…", context: "global", keys: ["ctrl+t"] },
  { id: "changes.open", title: "Changes: review, diff and merge worker branches", context: "global", keys: ["ctrl+d"] },
  { id: "tasks.open", title: "Task plan", context: "global", keys: ["ctrl+g"] },
  { id: "pane.diff", title: "Show focused agent's diff", context: "grid", keys: ["d"] },
  { id: "layout.cycle", title: "Cycle layout (grid / focus / swarm / wide)", context: "global", keys: ["ctrl+l"] },
  { id: "focus.next", title: "Focus next pane", context: "global", keys: ["tab"] },
  { id: "focus.prev", title: "Focus previous pane", context: "global", keys: ["shift+tab"] },
  { id: "focus.input", title: "Focus input", context: "grid", keys: ["i", "/", "@"] },
  { id: "grid.left", title: "Move left", context: "grid", keys: ["left", "h"], hidden: true },
  { id: "grid.right", title: "Move right", context: "grid", keys: ["right", "l"], hidden: true },
  { id: "grid.up", title: "Move up", context: "grid", keys: ["up", "k"], hidden: true },
  { id: "grid.down", title: "Move down", context: "grid", keys: ["down", "j"], hidden: true },
  { id: "grid.pageDown", title: "Next page of agents", context: "global", keys: ["pagedown"] },
  { id: "grid.pageUp", title: "Previous page of agents", context: "global", keys: ["pageup"] },
  { id: "pane.peek", title: "Peek at focused agent (and reply)", context: "grid", keys: ["space"] },
  { id: "pane.zoom", title: "Zoom focused agent", context: "grid", keys: ["z", "enter", "return"] },
  { id: "pane.message", title: "Message focused agent", context: "grid", keys: ["m"] },
  { id: "pane.copyPath", title: "Copy focused agent's worktree path", context: "grid", keys: ["o"] },
  { id: "pane.interrupt", title: "Interrupt focused agent", context: "grid", keys: ["x"] },
  { id: "pane.kill", title: "Kill focused agent", context: "grid", keys: ["shift+x"] },
  { id: "zoom.close", title: "Close zoom", context: "zoom", keys: ["escape", "q", "z"] },
  { id: "zoom.search", title: "Search this agent's history", context: "zoom", keys: ["/"] },
  { id: "zoom.next", title: "Next search match", context: "zoom", keys: ["n"], hidden: true },
  { id: "zoom.prev", title: "Previous search match", context: "zoom", keys: ["shift+n"], hidden: true },
  { id: "zoom.top", title: "Scroll to top", context: "zoom", keys: ["g", "home"], hidden: true },
  { id: "zoom.bottom", title: "Scroll to bottom", context: "zoom", keys: ["shift+g", "end"], hidden: true },
  { id: "zoom.copy", title: "Copy the agent's last message", context: "zoom", keys: ["y"] },
  { id: "zoom.copyAll", title: "Copy the whole transcript", context: "zoom", keys: ["shift+y"] },
  { id: "zoom.save", title: "Save the transcript to .baton/transcripts", context: "zoom", keys: ["w"] },
  { id: "orch.interrupt", title: "Interrupt orchestrator / everyone", context: "input", keys: ["escape"] },
  { id: "toggle.bus", title: "Toggle bus pane", context: "global", keys: ["ctrl+b"] },
  { id: "toggle.thoughts", title: "Toggle agent thoughts", context: "global", keys: ["ctrl+o"] },
  { id: "toggle.icons", title: "Cycle icon style (logo / nerd / unicode / ascii)", context: "global", keys: [] },
  { id: "toggle.border", title: "Cycle border style", context: "global", keys: [] },
  { id: "toggle.look", title: "Toggle native / unified look", context: "global", keys: [] },
  { id: "toggle.density", title: "Toggle compact density", context: "global", keys: [] },
  { id: "toggle.animations", title: "Toggle animations", context: "global", keys: [] },
]

export interface KeyLike {
  name: string
  ctrl?: boolean
  meta?: boolean
  shift?: boolean
  option?: boolean
  sequence?: string
}

/** Canonical key string: "ctrl+shift+p", "?", "escape", "shift+tab". */
export function keyString(k: KeyLike): string {
  let name = (k.name || k.sequence || "").toLowerCase()
  if (name === "return") name = "enter"
  if (name === "esc") name = "escape"
  // printable symbols arrive with their character in sequence
  if (!k.name && k.sequence) name = k.sequence
  const mods: string[] = []
  if (k.ctrl) mods.push("ctrl")
  if (k.meta || k.option) mods.push("alt")
  // shift is implied for symbols like "?" / "@"
  if (k.shift && /^[a-z0-9]$|^(tab|enter|left|right|up|down|pageup|pagedown|home|end|space|backspace|delete)$/.test(name)) mods.push("shift")
  return [...mods, name].join("+")
}

function normalizeBinding(b: string): string {
  return b
    .toLowerCase()
    .replace(/\bcmd\b|\bmeta\b|\boption\b/g, "alt")
    .replace(/\besc\b/g, "escape")
    .replace(/\breturn\b/g, "enter")
}

export class Keymap {
  private byContext = new Map<KeyContext, Map<string, string>>()
  readonly commands: CommandDef[]

  constructor(overrides: Record<string, string | string[]> = {}) {
    this.commands = DEFAULT_COMMANDS.map((c) => {
      const o = overrides[c.id]
      return o === undefined ? c : { ...c, keys: Array.isArray(o) ? o : [o] }
    })
    for (const c of this.commands) {
      let m = this.byContext.get(c.context)
      if (!m) {
        m = new Map()
        this.byContext.set(c.context, m)
      }
      for (const k of c.keys) m.set(normalizeBinding(k), c.id)
    }
  }

  /** Resolve a key in the given contexts (first match wins). */
  resolve(key: KeyLike, contexts: KeyContext[]): string | undefined {
    const ks = keyString(key)
    for (const ctx of contexts) {
      const id = this.byContext.get(ctx)?.get(ks)
      if (id) return id
    }
    return undefined
  }

  keysFor(id: string): string[] {
    return this.commands.find((c) => c.id === id)?.keys ?? []
  }

  /** Bindings that collide inside the same context (shown in the help overlay). */
  conflicts(): string[] {
    const out: string[] = []
    for (const ctx of new Set(this.commands.map((c) => c.context))) {
      const seen = new Map<string, string>()
      for (const c of this.commands.filter((x) => x.context === ctx)) {
        for (const k of c.keys.map(normalizeBinding)) {
          const prev = seen.get(k)
          if (prev && prev !== c.id) out.push(`${k} (${ctx}): ${prev} vs ${c.id}`)
          seen.set(k, c.id)
        }
      }
    }
    return out
  }
}
