/**
 * Plugin loading. Global plugins (from ~/.config/baton) load unconditionally; project plugins
 * execute code that came with the repository, so — like direnv — they only load once the user
 * ran `baton trust` for them (pinned by spec and file content; see kernel/trust.ts).
 */
import { existsSync } from "node:fs"
import { dirname, isAbsolute, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { type LayerSource, PROJECT_LAYERS, type TrustEntry } from "@batonsh/kernel"
import type { AgentAdapter, BatonPlugin } from "@batonsh/protocol"
import type { Runtime } from "./runtime.ts"

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

export async function loadPlugins(rt: Runtime, layers: LayerSource[], untrusted: TrustEntry[] = []): Promise<{ loaded: string[]; skipped: string[] }> {
  const loaded: string[] = []
  const skipped: string[] = []
  const held = new Set(untrusted.filter((e) => e.path.startsWith("plugins[")).map((e) => String(e.value)))
  for (const layer of layers) {
    const specs = Array.isArray(layer.data.plugins) ? layer.data.plugins.map(String) : []
    if (specs.length === 0) continue
    const fromProject = PROJECT_LAYERS.has(layer.name)
    const base = layer.path ? dirname(layer.path) : rt.projectRoot
    for (const spec of specs) {
      if (fromProject && held.has(spec)) {
        skipped.push(spec)
        continue
      }
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
  return { loaded, skipped }
}
