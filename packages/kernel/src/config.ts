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
  appearance: z.enum(["auto", "dark", "light"]).default("auto"),
  layout: z.enum(["grid", "focus", "swarm", "wide"]).default("grid"),
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
  status_left: z.string().default("{dot} {running}/{total} {noun} running · {calls} calls · {msgs} msgs"),
  status_right: z.string().default("{cost}  {added} {removed}  {repo}@{branch}"),
  timestamp_format: z.enum(["ss.mmm", "hh:mm:ss", "relative"]).default("ss.mmm"),
  mouse: z.boolean().default(true),
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
    })
    .default({ enabled: true, agent: "claude", approval: "auto-edit", mode: "orchestrator" }),
  defaults: z
    .object({
      approval: Approval.default("ask"),
      worker: z.string().default("codex"),
    })
    .default({ approval: "ask", worker: "codex" }),
  agents: z.record(z.string(), AgentConfig).default({}),
  providers: z.record(z.string(), ProviderConfig).default({}),
  roles: z.record(z.string(), z.object({ prompt: z.string(), adapter: z.string().optional(), model: z.string().optional() })).default({}),
  budget: z
    .object({
      run_usd: z.number().positive().optional(),
      per_agent_usd: z.number().positive().optional(),
      max_agents: z.number().int().positive().default(16),
      max_depth: z.number().int().nonnegative().default(2),
      warn_at: z.number().min(0).max(1).default(0.8),
    })
    .default({ max_agents: 16, max_depth: 2, warn_at: 0.8 }),
  policy: z
    .object({
      preset: z.enum(["strict", "balanced", "yolo"]).default("balanced"),
      rules: z.array(PolicyRule).default([]),
      /** Seconds before an unanswered approval is auto-denied (0 = never). */
      timeout_s: z.number().int().nonnegative().default(0),
    })
    .default({ preset: "balanced", rules: [], timeout_s: 0 }),
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

function readToml(path: string, errors: string[]): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined
  try {
    return parseToml(readFileSync(path, "utf8")) as Record<string, unknown>
  } catch (e) {
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

export function loadConfig(opts: { projectRoot?: string; overrides?: Record<string, unknown>; env?: Record<string, string | undefined> } = {}): LoadedConfig {
  const errors: string[] = []
  const layers: LayerSource[] = []
  const globalPath = join(configDir(), "config.toml")
  const g = readToml(globalPath, errors)
  if (g) layers.push({ name: "global", path: globalPath, data: g })
  if (opts.projectRoot) {
    const projectPath = join(projectBatonDir(opts.projectRoot), "config.toml")
    const p = readToml(projectPath, errors)
    if (p) layers.push({ name: "project", path: projectPath, data: p })
    const localPath = join(projectBatonDir(opts.projectRoot), "config.local.toml")
    const l = readToml(localPath, errors)
    if (l) layers.push({ name: "project-local", path: localPath, data: l })
  }
  const e = envLayer(opts.env)
  if (Object.keys(e).length) layers.push({ name: "env", data: e })
  if (opts.overrides && Object.keys(opts.overrides).length) layers.push({ name: "cli", data: opts.overrides })

  const merged: Record<string, unknown> = {}
  const provenance: Record<string, string> = {}
  for (const layer of layers) mergeInto(merged, layer.data, layer.name, provenance)

  // One bad key must not take the whole config down: drop each invalid leaf (reporting
  // where it came from) and re-validate, so every other setting still applies.
  for (let attempt = 0; attempt < 20; attempt++) {
    const parsed = BatonConfig.safeParse(merged)
    if (parsed.success) return { config: parsed.data, provenance, layers, errors }
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".")
      const from = provenance[key] ?? Object.entries(provenance).find(([k]) => k.startsWith(`${key}.`))?.[1]
      errors.push(`config ${key || "(root)"}${from ? ` (from ${from})` : ""}: ${issue.message} — ignored`)
      if (issue.path.length === 0) return { config: BatonConfig.parse({}), provenance: {}, layers, errors }
      deletePath(merged, issue.path.map(String))
      for (const k of Object.keys(provenance)) if (k === key || k.startsWith(`${key}.`)) delete provenance[k]
    }
  }
  return { config: BatonConfig.parse({}), provenance: {}, layers, errors }
}

function deletePath(obj: Record<string, unknown>, path: string[]): void {
  let cur: unknown = obj
  for (let i = 0; i < path.length - 1; i++) {
    if (typeof cur !== "object" || cur === null) return
    cur = (cur as Record<string, unknown>)[path[i] as string]
  }
  if (typeof cur === "object" && cur !== null) delete (cur as Record<string, unknown>)[path[path.length - 1] as string]
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
