/**
 * Layered configuration.
 *
 *   built-in defaults → ~/.config/baton/config.toml → <project>/.baton/config.toml
 *   → BATON_* environment → CLI overrides → runtime overrides
 *
 * Later layers deep-merge over earlier ones; arrays replace. Every leaf remembers which
 * layer set it (provenance) so `baton config explain <key>` can tell you why.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parse as parseToml } from "smol-toml"
import { z } from "zod"
import { PROJECT_LAYERS, stripUntrusted, type TrustEntry, trustedIds, trustSurface } from "./trust.ts"

const Approval = z.enum(["ask", "auto-edit", "auto", "yolo"])

export const AgentConfig = z.object({
  adapter: z.string(),
  model: z.string().optional(),
  provider: z.string().optional(),
  approval: Approval.optional(),
  role: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  /** Spawn this many instances at startup. */
  autostart: z.number().int().nonnegative().default(0),
  label: z.string().optional(),
})
export type AgentConfig = z.infer<typeof AgentConfig>

export const ProviderConfig = z.object({
  kind: z.string(),
  base_url: z.string().optional(),
  api_key: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.record(z.string(), z.string()).optional(),
})
export type ProviderConfig = z.infer<typeof ProviderConfig>

export const Access = z.enum(["read-only", "write"])
export type Access = z.infer<typeof Access>

export const RoleConfig = z.object({
  /** Instructions added to the worker's system prompt. */
  prompt: z.string().optional(),
  /** One line: what the role is for (shown to the lead and in /roles). */
  description: z.string().optional(),
  adapter: z.string().optional(),
  model: z.string().optional(),
  tier: z.enum(["small", "medium", "large"]).optional(),
  /** read-only: may not edit files (enforced by Baton's policy, even in yolo). */
  access: Access.optional(),
  /** A command that must pass before the worker's result counts as done. */
  acceptance: z.string().optional(),
  /** Skills the role starts with (names). */
  skills: z.array(z.string()).optional(),
})
export type RoleConfig = z.infer<typeof RoleConfig>

export const TeamMember = z.object({
  role: z.string().optional(),
  adapter: z.string().optional(),
  count: z.number().int().min(1).max(10).default(1),
  label: z.string().optional(),
})

export const PolicyRule = z.object({
  /** Tool kinds this rule matches ("execute", "edit", …); empty = any. */
  kinds: z.array(z.string()).optional(),
  /** Regex tested against the request title / command. */
  match: z.string().optional(),
  /** Agent names or adapter ids; empty = any. */
  agents: z.array(z.string()).optional(),
  action: z.enum(["allow", "deny", "ask"]),
})
export type PolicyRule = z.infer<typeof PolicyRule>

export const AgentStyle = z.object({
  icon: z.string().optional(),
  color: z.string().optional(),
  name_pattern: z.string().optional(),
})

export const UiConfig = z.object({
  theme: z.string().default("baton"),
  /** Style preset (shapes, not colors): classic · modern · minimal · accent · tabs · neon · retro · zen · paper · glass · brutalist. Sets the keys below. */
  style: z.string().default("classic"),
  /** Pane frames: line (boxes) · tab · bar (filled title bars) · minimal (title rule only) · accent (colored stripe). */
  frame: z.enum(["line", "tab", "bar", "minimal", "accent"]).default("line"),
  /** Status bar: plain · blocks (chips) · powerline (needs a Nerd Font) · minimal (no fill). */
  status_style: z.enum(["plain", "blocks", "powerline", "minimal"]).default("plain"),
  /** theme: paint the theme background · terminal: keep your terminal's own background (transparent). */
  background: z.enum(["theme", "terminal"]).default("theme"),
  /** Tint each agent card's border with the agent's brand color. */
  brand_borders: z.boolean().default(false),
  appearance: z.enum(["auto", "dark", "light"]).default("auto"),
  layout: z.enum(["grid", "list", "focus", "swarm", "wide"]).default("grid"),
  icons: z.enum(["auto", "unicode", "nerd", "ascii"]).default("auto"),
  border: z.enum(["rounded", "single", "heavy", "double", "ascii", "none"]).default("rounded"),
  density: z.enum(["comfy", "compact"]).default("comfy"),
  /** native = each agent mimics its own CLI's look; unified = one look for all. */
  render_style: z.enum(["native", "unified"]).default("native"),
  spinner: z.string().default("star"),
  verbs: z.array(z.string()).optional(),
  animations: z.boolean().default(true),
  fps: z.number().int().min(5).max(120).default(30),
  min_card_width: z.number().int().min(20).default(44),
  min_card_height: z.number().int().min(4).default(9),
  max_columns: z.number().int().min(1).default(4),
  show_bus: z.boolean().default(true),
  show_thoughts: z.boolean().default(false),
  card_fields: z.array(z.string()).default(["adapter", "version", "model", "dir", "approval"]),
  status_left: z.string().default("{trust} {focus} {dot} {running}/{total} {noun} running · {calls} calls · {msgs} msgs  {attention}"),
  status_right: z.string().default("{viewers}  {unmerged}  {cost}  {added} {removed}  {repo}@{branch}"),
  timestamp_format: z.enum(["ss.mmm", "hh:mm:ss", "relative"]).default("ss.mmm"),
  mouse: z.boolean().default(true),
  /** One-line hint bar with the keys that matter in the current context. */
  hints: z.boolean().default(true),
  /** Show "⚑ 2 baton · project" in the terminal tab title. */
  tab_title: z.boolean().default(true),
  /** Render agents' Markdown (bold, lists, tables, code blocks); off shows the raw text. */
  markdown: z.boolean().default(true),
})
export type UiConfig = z.infer<typeof UiConfig>

export const BatonConfig = z.object({
  project: z.object({ name: z.string().optional() }).default({}),
  orchestrator: z
    .object({
      enabled: z.boolean().default(true),
      agent: z.string().default("claude"),
      model: z.string().optional(),
      approval: Approval.default("auto-edit"),
      mode: z.string().default("orchestrator"),
      /** Extra instructions appended to the orchestrator playbook. */
      instructions: z.string().optional(),
      /** Require the user to approve the orchestrator's task plan before it dispatches work. */
      plan_approval: z.boolean().default(false),
    })
    .default({ enabled: true, agent: "claude", approval: "auto-edit", mode: "orchestrator", plan_approval: false }),
  defaults: z
    .object({
      approval: Approval.default("ask"),
      worker: z.string().default("codex"),
    })
    .default({ approval: "ask", worker: "codex" }),
  agents: z.record(z.string(), AgentConfig).default({}),
  providers: z.record(z.string(), ProviderConfig).default({}),
  /**
   * Roles for workers ("tester", "security", …): built-in ones, plus .baton/roles/*.md,
   * ~/.config/baton/roles/*.md and these entries (later wins, field by field).
   */
  roles: z.record(z.string(), RoleConfig).default({}),
  /** Skills: folders with a SKILL.md that workers can load on demand (load_skill). */
  skills: z
    .object({
      /** Extra skill folders (each containing <skill>/SKILL.md). */
      dirs: z.array(z.string()).default([]),
      /** Also offer the project's .claude/skills. */
      claude: z.boolean().default(true),
      /** Also offer your personal ~/.claude/skills. */
      claude_user: z.boolean().default(false),
    })
    .default({ dirs: [], claude: true, claude_user: false }),
  /**
   * Team features, each on its own switch. Off means the agents never hear of it: no tools, no
   * prompt text, and the matching spawn fields are ignored.
   */
  features: z
    .object({
      /** Roles for workers (tester, reviewer, …, .baton/roles): instructions, access, size. Reviews use the read-only reviewer role. */
      roles: z.boolean().default(true),
      /** Skills (SKILL.md folders) workers can load with load_skill. */
      skills: z.boolean().default(true),
      /** Acceptance checks: a command Baton runs when a worker finishes; its result counts only if it passes. */
      acceptance: z.boolean().default(true),
      /** Team notes: agents record facts (note / recall) in .baton/notes.md and new workers start with them. Opt-in. */
      notes: z.boolean().default(false),
    })
    .default({ roles: true, skills: true, acceptance: true, notes: false }),
  /** Team notes settings (turn them on with features.notes). */
  notes: z
    .object({
      /** Notes given to each new worker (the most recent). */
      max: z.number().int().nonnegative().default(30),
      /** Save review findings (changes requested) as notes. */
      reviews: z.boolean().default(true),
    })
    .default({ max: 30, reviews: true }),
  /** Saved teams for /team <name>: who to start. */
  teams: z.record(z.string(), z.array(TeamMember)).default({}),
  budget: z
    .object({
      run_usd: z.number().positive().optional(),
      per_agent_usd: z.number().positive().optional(),
      max_agents: z.number().int().positive().default(16),
      /** Above this many live workers, the orchestrator must get your OK to spawn more (0 = never ask). */
      soft_max_agents: z.number().int().nonnegative().default(4),
      max_depth: z.number().int().nonnegative().default(2),
      warn_at: z.number().min(0).max(1).default(0.8),
    })
    .default({ max_agents: 16, soft_max_agents: 4, max_depth: 2, warn_at: 0.8 }),
  policy: z
    .object({
      preset: z.enum(["strict", "balanced", "yolo"]).default("balanced"),
      /**
       * One dial for every agent in the run (lead + workers, also ones already running):
       * normal = use the per-agent settings · ask = everyone asks first · auto = agents act on
       * their own, destructive commands still ask · yolo = no prompts, no sandbox.
       * Switch live with shift+tab or /autonomy.
       */
      autonomy: z.enum(["normal", "ask", "auto", "yolo"]).default("normal"),
      rules: z.array(PolicyRule).default([]),
      /** Seconds before an unanswered approval is auto-denied (0 = never). */
      timeout_s: z.number().int().nonnegative().default(0),
    })
    .default({ preset: "balanced", autonomy: "normal", rules: [], timeout_s: 0 }),
  bus: z
    .object({
      heartbeat_s: z.number().int().nonnegative().default(15),
      /** Who may message whom: open = anyone; tree = only parent/children/siblings. */
      contact: z.enum(["open", "tree"]).default("open"),
      max_body: z.number().int().positive().default(8000),
    })
    .default({ heartbeat_s: 15, contact: "open", max_body: 8000 }),
  ui: UiConfig.default(UiConfig.parse({})),
  agent_style: z.record(z.string(), AgentStyle).default({}),
  keys: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
  /**
   * Plugin modules (paths relative to the config file that lists them, or package names).
   * A plugin default-exports an adapter, an array of adapters, or `definePlugin({ adapters })`.
   * Project-level plugins only load after `baton trust` (they run code from the repo).
   */
  plugins: z.array(z.string()).default([]),
  /** Model per difficulty tier, per adapter: spawn_agent(tier: "small") picks routing.<adapter>.small. */
  routing: z.record(z.string(), z.object({ small: z.string().optional(), medium: z.string().optional(), large: z.string().optional() })).default({
    claude: { small: "haiku", medium: "sonnet", large: "opus" },
  }),
  telemetry: z
    .object({
      /** OTLP/HTTP base URL (e.g. http://localhost:4318). Empty = off. */
      otlp_endpoint: z.string().optional(),
      headers: z.record(z.string(), z.string()).default({}),
      service_name: z.string().default("baton"),
    })
    .default({ headers: {}, service_name: "baton" }),
  watchdog: z
    .object({
      /** Flag a busy agent with no activity for this long (seconds, 0 = off). */
      stall_s: z.number().int().nonnegative().default(300),
      /** Flag an agent repeating the same tool call this many times in a row (0 = off). */
      loop_repeats: z.number().int().nonnegative().default(4),
    })
    .default({ stall_s: 300, loop_repeats: 4 }),
  notify: z
    .object({
      /** Desktop notifications (OSC 9/777 via the terminal). */
      desktop: z.boolean().default(true),
      /** Ring the terminal bell. */
      bell: z.boolean().default(false),
      /** Play a sound: system = a different system sound per kind (approval, done, error, merge). */
      sound: z.enum(["off", "system"]).default("off"),
      /** Your own sound files per kind, e.g. { approval = "~/sounds/ding.wav" }. */
      sounds: z.record(z.string(), z.string()).default({}),
      /** Also notify while the Baton window has focus. */
      when_focused: z.boolean().default(false),
      /** approval = an agent needs you · done = the orchestrator finished · error = an agent failed · merge = a merge landed or failed */
      events: z.array(z.enum(["approval", "done", "error", "merge"])).default(["approval", "done", "error"]),
      /** POST notifications here even when no TUI is attached (phone, chat). */
      webhook: z.string().optional(),
      /** json: {title, body, kind, …} · ntfy: ntfy.sh-style text + headers · slack: {text} */
      webhook_format: z.enum(["json", "ntfy", "slack"]).default("json"),
      /** Shell command run per notification; receives JSON on stdin and BATON_TITLE/BATON_BODY env vars. */
      command: z.string().optional(),
    })
    .default({ desktop: true, bell: false, sound: "off", sounds: {}, when_focused: false, events: ["approval", "done", "error"], webhook_format: "json" }),
  workspace: z
    .object({
      /** worktree: every worker gets its own git worktree; shared: everyone edits the project directly. */
      isolation: z.enum(["worktree", "shared"]).default("worktree"),
      /** Where worktrees live (default: ~/.local/state/baton/worktrees/<project>). Outside the repo so test runners never see them. */
      dir: z.string().optional(),
      /** Symlinked from the project into each worktree when present (dependency folders). */
      link: z.array(z.string()).default(["node_modules", ".venv", "vendor"]),
      /** Copied into each worktree when present (usually git-ignored secrets). */
      copy: z.array(z.string()).default([".env", ".env.local", ".env.development.local"]),
      /** Command run once in each new worktree (e.g. "bun install"). */
      setup: z.string().optional(),
      /** Command that must pass in the worktree before its changes are merged. */
      verify: z.string().optional(),
      /** off | suggested (orchestrator is told to get reviews) | required (merge refuses without an approval). */
      review: z.enum(["off", "suggested", "required"]).default("suggested"),
      /** Adapter used for reviews (default: a different vendor than the author). */
      reviewer: z.string().optional(),
      /** What happens to a worktree when its agent is removed. */
      cleanup: z.enum(["merged", "always", "never"]).default("merged"),
      /** Ports reserved per worktree: BATON_PORT_0..N-1 (and PORT = the first) so dev servers don't collide. */
      ports: z.number().int().min(0).max(20).default(2),
      /** First port handed out; each worker gets a block of 10. */
      port_base: z.number().int().min(1024).max(60000).default(4100),
      /** Predict merge conflicts between workers as they edit. */
      conflict_check: z.boolean().default(true),
    })
    .default({
      isolation: "worktree",
      link: ["node_modules", ".venv", "vendor"],
      copy: [".env", ".env.local", ".env.development.local"],
      review: "suggested",
      cleanup: "merged",
      ports: 2,
      port_base: 4100,
      conflict_check: true,
    }),
  github: z
    .object({
      /** API base (GitHub Enterprise: https://ghe.example.com/api/v3). */
      api_url: z.string().default("https://api.github.com"),
      /** Token reference (env:VAR · cmd:… · keychain:…). Default: $GITHUB_TOKEN / $GH_TOKEN / \`gh auth token\`. */
      token: z.string().optional(),
      /** Remote to push PR branches to. */
      remote: z.string().default("origin"),
      /** Open pull requests as drafts. */
      draft: z.boolean().default(true),
    })
    .default({ api_url: "https://api.github.com", remote: "origin", draft: true }),
  a2a: z
    .object({
      /** Serve the A2A endpoint with the daemon (otherwise: \`baton a2a\`). */
      autostart: z.boolean().default(false),
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(0).max(65535).default(0),
      /** Where other agents reach this endpoint (advertised in the agent card). */
      public_url: z.string().optional(),
      /** Require a bearer token (printed by \`baton a2a\`). */
      token: z.boolean().default(true),
      /** How long the team must be quiet before a task counts as done (ms). */
      idle_ms: z.number().int().min(200).default(2000),
      /** Allow push-notification webhooks on private / loopback addresses (SSRF guard off — local setups only). */
      allow_private_push: z.boolean().default(false),
      /** A lead's final message that asks the requester something becomes input-required instead of completed. */
      questions_as_input: z.boolean().default(true),
    })
    .default({ autostart: false, host: "127.0.0.1", port: 0, token: true, idle_ms: 2000, allow_private_push: false, questions_as_input: true }),
  remote: z
    .object({
      /** Start the web view with the daemon (otherwise: `baton web` / `/web`). */
      autostart: z.boolean().default(false),
      /** Listen on all interfaces so a phone on the same network can connect (default: this machine only). */
      lan: z.boolean().default(false),
      /** Fixed port (0 = pick a free one). A fixed port keeps bookmarks working. */
      port: z.number().int().min(0).max(65535).default(0),
      /** off: plain HTTP · self-signed: HTTPS with a certificate Baton creates (your phone will ask you to trust it once). */
      tls: z.enum(["off", "self-signed"]).default("off"),
      /** Publish through \`tailscale serve\`: a real HTTPS certificate on your tailnet, reachable from anywhere you're logged in. */
      tailscale: z.boolean().default(false),
      /** How phones reach the web view (e.g. a Tailscale / tunnel URL); used for one-tap approve buttons in notifications. */
      public_url: z.string().optional(),
    })
    .default({ autostart: false, lan: false, port: 0, tls: "off", tailscale: false }),
  daemon: z
    .object({
      /** Keep the daemon alive after the last client detaches. */
      persist: z.boolean().default(true),
      mcp_port: z.number().int().nonnegative().default(0),
    })
    .default({ persist: true, mcp_port: 0 }),
})
export type BatonConfig = z.infer<typeof BatonConfig>
export type BatonConfigInput = z.input<typeof BatonConfig>

export interface LayerSource {
  name: string
  path?: string
  data: Record<string, unknown>
}

export interface LoadedConfig {
  config: BatonConfig
  provenance: Record<string, string>
  layers: LayerSource[]
  errors: string[]
  /** Project entries held back until `baton trust` (commands, plugins, widened permissions). */
  untrusted: TrustEntry[]
  /** Config files that exist but failed to parse (their settings are missing from `config`). */
  failed: string[]
}

export function configDir(): string {
  return process.env.BATON_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "baton")
}

export function stateDir(): string {
  return process.env.BATON_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "baton")
}

export function projectBatonDir(root: string): string {
  return join(root, ".baton")
}

function readToml(path: string, errors: string[], failed?: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch (e) {
    failed?.push(path)
    errors.push(`${path}: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}

/** BATON_UI__THEME=nord → { ui: { theme: "nord" } }. Values parse as JSON when possible. */
export function envLayer(env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const shortcuts: Record<string, string> = { BATON_THEME: "ui.theme", BATON_LAYOUT: "ui.layout", BATON_ICONS: "ui.icons" }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue
    let path: string | undefined = shortcuts[k]
    if (!path && k.startsWith("BATON_") && k.includes("__")) path = k.slice(6).toLowerCase().split("__").join(".")
    if (!path) continue
    let value: unknown = v
    try {
      value = JSON.parse(v)
    } catch {}
    setPath(out, path, value)
  }
  if (env.NO_COLOR) setPath(out, "ui.theme", "mono")
  return out
}

export function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".")
  let cur: Record<string, unknown> = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i] as string
    if (typeof cur[p] !== "object" || cur[p] === null || Array.isArray(cur[p])) cur[p] = {}
    cur = cur[p] as Record<string, unknown>
  }
  cur[parts[parts.length - 1] as string] = value
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const p of path.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined
    cur = (cur as Record<string, unknown>)[p]
  }
  return cur
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function mergeInto(target: Record<string, unknown>, src: Record<string, unknown>, layer: string, prov: Record<string, string>, prefix = ""): void {
  for (const [k, v] of Object.entries(src)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (isPlainObject(v)) {
      if (!isPlainObject(target[k])) target[k] = {}
      mergeInto(target[k] as Record<string, unknown>, v, layer, prov, key)
    } else {
      target[k] = v
      prov[key] = layer
    }
  }
}

export function loadConfig(
  opts: {
    projectRoot?: string
    overrides?: Record<string, unknown>
    env?: Record<string, string | undefined>
    /** Apply project entries that need trust without asking (tests, explicit opt-in). */
    trustAll?: boolean
  } = {},
): LoadedConfig {
  const errors: string[] = []
  const untrusted: TrustEntry[] = []
  const failed: string[] = []
  const layers: LayerSource[] = []
  const globalPath = join(configDir(), "config.toml")
  const g = readToml(globalPath, errors, failed)
  if (g) layers.push({ name: "global", path: globalPath, data: g })
  if (opts.projectRoot) {
    const projectPath = join(projectBatonDir(opts.projectRoot), "config.toml")
    const p = readToml(projectPath, errors, failed)
    if (p) layers.push({ name: "project", path: projectPath, data: p })
    const localPath = join(projectBatonDir(opts.projectRoot), "config.local.toml")
    const l = readToml(localPath, errors, failed)
    if (l) layers.push({ name: "project-local", path: localPath, data: l })
  }
  const e = envLayer(opts.env)
  if (Object.keys(e).length) layers.push({ name: "env", data: e })
  if (opts.overrides && Object.keys(opts.overrides).length) layers.push({ name: "cli", data: opts.overrides })

  const merged: Record<string, unknown> = {}
  const provenance: Record<string, string> = {}
  const trusted = opts.projectRoot && !opts.trustAll ? trustedIds(opts.projectRoot) : undefined
  for (const layer of layers) {
    let data = layer.data
    if (trusted && opts.projectRoot && PROJECT_LAYERS.has(layer.name)) {
      const held = trustSurface(opts.projectRoot, data).filter((e) => !trusted.has(e.id))
      if (held.length) {
        untrusted.push(...held)
        data = stripUntrusted(data, held)
      }
    }
    mergeInto(merged, data, layer.name, provenance)
  }

  // One bad key must not take the whole config down: drop each invalid leaf (reporting
  // where it came from) and re-validate, so every other setting still applies.
  for (let attempt = 0; attempt < 20; attempt++) {
    const parsed = BatonConfig.safeParse(merged)
    if (parsed.success) return { config: parsed.data, provenance, layers, errors, untrusted, failed }
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".")
      const from = provenance[key] ?? Object.entries(provenance).find(([k]) => k.startsWith(`${key}.`))?.[1]
      errors.push(`config ${key || "(root)"}${from ? ` (from ${from})` : ""}: ${issue.message} — ignored`)
      if (issue.path.length === 0) return { config: BatonConfig.parse({}), provenance: {}, layers, errors, untrusted, failed }
      deletePath(merged, issue.path.map(String))
      for (const k of Object.keys(provenance)) if (k === key || k.startsWith(`${key}.`)) delete provenance[k]
    }
  }
  return { config: BatonConfig.parse({}), provenance: {}, layers, errors, untrusted, failed }
}

/**
 * Remove the value at path. When the leaf is already gone (a required key is missing), remove
 * the nearest container entry instead — an array element is spliced out, a record entry
 * (e.g. agents.<name>) is deleted — so validation always makes progress.
 */
function deletePath(obj: Record<string, unknown>, path: string[]): void {
  for (let depth = path.length; depth > 0; depth--) {
    let cur: unknown = obj
    for (let i = 0; i < depth - 1; i++) {
      if (typeof cur !== "object" || cur === null) return
      cur = (cur as Record<string, unknown>)[path[i] as string]
    }
    if (typeof cur !== "object" || cur === null) continue
    const last = path[depth - 1] as string
    if (Array.isArray(cur)) {
      const idx = Number(last)
      if (Number.isInteger(idx) && idx < cur.length) {
        cur.splice(idx, 1)
        return
      }
      continue
    }
    if (Object.hasOwn(cur, last)) {
      delete (cur as Record<string, unknown>)[last]
      return
    }
  }
}

export function configJsonSchema(): unknown {
  return z.toJSONSchema(BatonConfig, { io: "input" })
}

/** Resolve "env:VAR", "cmd:<shell>", "keychain:<service>" secret references. */
export async function resolveSecret(ref: string | undefined): Promise<string | undefined> {
  if (!ref) return undefined
  if (ref.startsWith("env:")) return process.env[ref.slice(4)]
  if (ref.startsWith("cmd:")) {
    const p = Bun.spawn(["sh", "-c", ref.slice(4)], { stdout: "pipe", stderr: "ignore" })
    const out = (await new Response(p.stdout).text()).trim()
    return (await p.exited) === 0 ? out : undefined
  }
  if (ref.startsWith("keychain:")) {
    const p = Bun.spawn(["security", "find-generic-password", "-s", ref.slice(9), "-w"], { stdout: "pipe", stderr: "ignore" })
    const out = (await new Response(p.stdout).text()).trim()
    return (await p.exited) === 0 ? out : undefined
  }
  return ref
}
