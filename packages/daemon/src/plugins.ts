/**
 * Plugin loading. Global plugins (from ~/.config/baton) load unconditionally; project plugins
 * execute code that came with the repository, so — like direnv — they only load once the user
 * ran `baton trust` for this exact plugin list.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { type LayerSource, stateDir } from "@batonsh/kernel"
import type { AgentAdapter, BatonPlugin } from "@batonsh/protocol"
import type { Runtime } from "./runtime.ts"

const PROJECT_LAYERS = new Set(["project", "project-local"])

function trustFile(): string {
  return join(stateDir(), "trusted.json")
}

function readTrust(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(trustFile(), "utf8")) as Record<string, string>
  } catch {
    return {}
  }
}

export function projectPluginSpecs(layers: LayerSource[]): string[] {
  const out: string[] = []
  for (const l of layers) {
    if (!PROJECT_LAYERS.has(l.name)) continue
    const p = l.data.plugins
    if (Array.isArray(p)) out.push(...p.map(String))
  }
  return out
}

function fingerprint(specs: string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...specs].sort()))
    .digest("hex")
    .slice(0, 16)
}

export function isTrusted(projectRoot: string, specs: string[]): boolean {
  return specs.length === 0 || readTrust()[projectRoot] === fingerprint(specs)
}

export function trustProject(projectRoot: string, specs: string[], revoke = false): void {
  const t = readTrust()
  if (revoke) delete t[projectRoot]
  else t[projectRoot] = fingerprint(specs)
  mkdirSync(dirname(trustFile()), { recursive: true })
  writeFileSync(trustFile(), JSON.stringify(t, null, 2))
}

function toAdapters(mod: unknown): AgentAdapter[] {
  const m = (mod as { default?: unknown })?.default ?? mod
  const isAdapter = (x: unknown): x is AgentAdapter =>
    !!x && typeof x === "object" && typeof (x as AgentAdapter).id === "string" && typeof (x as AgentAdapter).start === "function"
  if (isAdapter(m)) return [m]
  if (Array.isArray(m)) return m.filter(isAdapter)
  const plugin = m as BatonPlugin
  if (plugin && Array.isArray(plugin.adapters)) return plugin.adapters.filter(isAdapter)
  return []
}

export async function loadPlugins(rt: Runtime, layers: LayerSource[]): Promise<{ loaded: string[]; skipped: string[] }> {
  const loaded: string[] = []
  const skipped: string[] = []
  const projectSpecs = projectPluginSpecs(layers)
  const trusted = isTrusted(rt.projectRoot, projectSpecs)
  for (const layer of layers) {
    const specs = Array.isArray(layer.data.plugins) ? layer.data.plugins.map(String) : []
    if (specs.length === 0) continue
    const fromProject = PROJECT_LAYERS.has(layer.name)
    if (fromProject && !trusted) {
      skipped.push(...specs)
      continue
    }
    const base = layer.path ? dirname(layer.path) : rt.projectRoot
    for (const spec of specs) {
      // relative paths resolve against the directory of the config file that lists them
      const target = spec.startsWith(".") || isAbsolute(spec) ? pathToFileURL(resolve(fromProject ? rt.projectRoot : base, spec)).href : spec
      try {
        if (target.startsWith("file:") && !existsSync(new URL(target))) throw new Error("file not found")
        const adapters = toAdapters(await import(target))
        if (adapters.length === 0) throw new Error("module exports no adapters")
        for (const a of adapters) rt.registry.register(a)
        loaded.push(`${spec} (${adapters.map((a) => a.id).join(", ")})`)
      } catch (e) {
        rt.emit({ type: "log", data: { level: "warn", message: `plugin ${spec}: ${e instanceof Error ? e.message : String(e)}` } })
      }
    }
  }
  if (skipped.length) {
    rt.emit({
      type: "log",
      data: { level: "warn", message: `config: project plugins not loaded (${skipped.join(", ")}) — run \`baton trust\` to allow code from this repository` },
    })
  }
  return { loaded, skipped }
}
