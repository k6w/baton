/**
 * Project trust (like direnv). A repository's .baton/config.toml can carry settings that run
 * commands or widen permissions — plugins, agent commands/env, workspace setup/verify hooks,
 * `cmd:` secrets, notification commands, yolo approvals, allow rules, provider endpoints.
 * Cloning a repo must not be enough to execute any of that: such entries only apply once the
 * user ran `baton trust` for their exact values (plugin files are pinned by content hash).
 * Everything else in project config (themes, layout, budgets, …) applies normally.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { stateDir } from "./config.ts"

export const PROJECT_LAYERS = new Set(["project", "project-local"])

export interface TrustEntry {
  /** Dotted config path, e.g. "workspace.setup", "agents.fast.command", "policy.rules[2]". */
  path: string
  value: unknown
  /** Stable hash of path + value (+ plugin file content). */
  id: string
}

const AGENT_KEYS = ["command", "args", "env"]
const OPTION_KEYS = ["command", "bin", "binary", "path", "args", "env", "cwd"]
const WIDE_APPROVAL = new Set(["auto", "yolo"])

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function fileHash(p: string): string {
  try {
    if (!existsSync(p) || !statSync(p).isFile()) return ""
    return createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16)
  } catch {
    return ""
  }
}

function entry(root: string, path: string, value: unknown, extra = ""): TrustEntry {
  const id = createHash("sha256")
    .update(`${root}\0${path}\0${JSON.stringify(value)}\0${extra}`)
    .digest("hex")
    .slice(0, 20)
  return { path, value, id }
}

/** Every trust-requiring entry in one config layer. */
export function trustSurface(root: string, data: Record<string, unknown>): TrustEntry[] {
  const out: TrustEntry[] = []
  const push = (path: string, value: unknown, extra = "") => {
    if (value !== undefined) out.push(entry(root, path, value, extra))
  }
  if (Array.isArray(data.plugins))
    data.plugins.forEach((spec, i) => {
      const s = String(spec)
      const local = s.startsWith(".") || isAbsolute(s)
      push(`plugins[${i}]`, s, local ? fileHash(resolve(root, s)) : "")
    })
  for (const sect of ["orchestrator", "defaults"] as const) {
    const o = data[sect]
    if (isObj(o) && typeof o.approval === "string" && WIDE_APPROVAL.has(o.approval)) push(`${sect}.approval`, o.approval)
  }
  if (isObj(data.agents))
    for (const [name, a] of Object.entries(data.agents)) {
      if (!isObj(a)) continue
      for (const k of AGENT_KEYS) push(`agents.${name}.${k}`, a[k])
      if (typeof a.approval === "string" && WIDE_APPROVAL.has(a.approval)) push(`agents.${name}.approval`, a.approval)
      if (isObj(a.options)) for (const k of OPTION_KEYS) push(`agents.${name}.options.${k}`, a.options[k])
    }
  if (isObj(data.providers))
    for (const [name, p] of Object.entries(data.providers)) {
      if (!isObj(p)) continue
      // a repo-chosen endpoint + the user's own key would leak the key; cmd:/keychain: run things
      for (const k of ["base_url", "api_key", "headers"]) push(`providers.${name}.${k}`, p[k])
    }
  if (isObj(data.workspace)) for (const k of ["setup", "verify", "dir"]) push(`workspace.${k}`, data.workspace[k])
  if (isObj(data.notify)) for (const k of ["command", "webhook"]) push(`notify.${k}`, data.notify[k])
  if (isObj(data.telemetry)) for (const k of ["otlp_endpoint", "headers"]) push(`telemetry.${k}`, data.telemetry[k])
  if (isObj(data.policy)) {
    if (data.policy.preset === "yolo") push("policy.preset", "yolo")
    if (data.policy.autonomy === "auto" || data.policy.autonomy === "yolo") push("policy.autonomy", data.policy.autonomy)
    if (Array.isArray(data.policy.rules))
      data.policy.rules.forEach((r, i) => {
        if (isObj(r) && r.action === "allow") push(`policy.rules[${i}]`, r)
      })
  }
  return out
}

function trustFile(): string {
  return join(stateDir(), "trusted.json")
}

function readTrust(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(trustFile(), "utf8")) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function trustedIds(root: string): Set<string> {
  const v = readTrust()[root]
  return new Set(Array.isArray(v) ? v.map(String) : [])
}

/** Trust these entries for the project (merged with what was trusted before). */
export function trustEntries(root: string, entries: TrustEntry[]): void {
  const t = readTrust()
  const ids = trustedIds(root)
  for (const e of entries) ids.add(e.id)
  t[root] = [...ids]
  mkdirSync(dirname(trustFile()), { recursive: true })
  writeFileSync(trustFile(), JSON.stringify(t, null, 2))
}

export function revokeTrust(root: string): void {
  const t = readTrust()
  delete t[root]
  mkdirSync(dirname(trustFile()), { recursive: true })
  writeFileSync(trustFile(), JSON.stringify(t, null, 2))
}

/** "a.b[2].c" → ["a", "b", 2, "c"] */
function parsePath(path: string): (string | number)[] {
  const out: (string | number)[] = []
  for (const part of path.split(".")) {
    const m = /^(.*?)((?:\[\d+\])*)$/.exec(part)
    if (!m) continue
    if (m[1]) out.push(m[1])
    for (const idx of (m[2] ?? "").matchAll(/\[(\d+)\]/g)) out.push(Number(idx[1]))
  }
  return out
}

/**
 * Remove untrusted entries from a layer's data (returns a copy). Array elements are removed
 * by index (highest first, so earlier indices stay valid).
 */
export function stripUntrusted(data: Record<string, unknown>, untrusted: TrustEntry[]): Record<string, unknown> {
  const copy = structuredClone(data)
  const sorted = [...untrusted].sort((a, b) => b.path.localeCompare(a.path, undefined, { numeric: true }))
  for (const e of sorted) {
    const parts = parsePath(e.path)
    let cur: unknown = copy
    for (let i = 0; i < parts.length - 1; i++) cur = (cur as Record<string | number, unknown>)?.[parts[i] as string]
    const last = parts[parts.length - 1]
    if (Array.isArray(cur) && typeof last === "number") cur.splice(last, 1)
    else if (isObj(cur) && typeof last === "string") delete cur[last]
  }
  return copy
}
