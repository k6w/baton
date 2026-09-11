/**
 * The public ACP agent registry → presets. Only describes how to *run* an already
 * installed agent; nothing is downloaded or installed here.
 *
 * Format (registry v1): { version, agents: [{ id, name, version, description, distribution:
 *   { binary?: { "<os>-<arch>": { archive, cmd, args?, env? } }, npx?: { package, args?, env? },
 *     uvx?: { package, args?, env? } } }] }
 */
import type { AcpPreset } from "./presets.ts"

export const ACP_REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json"

interface RegistryCommand {
  cmd?: string
  package?: string
  args?: string[]
  env?: Record<string, string>
}

export interface RegistryAgent {
  id: string
  name?: string
  version?: string
  description?: string
  website?: string
  repository?: string
  distribution?: {
    binary?: Record<string, RegistryCommand>
    npx?: RegistryCommand
    uvx?: RegistryCommand
  }
}

export function currentPlatformKey(): string {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux"
  const arch = process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : process.arch
  return `${os}-${arch}`
}

function basename(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/** "@scope/name@1.2.3" → "name"; "name==1.2" → "name" */
function packageBin(pkg: string): string {
  const noVersion = pkg.replace(/(?!^)@[^/]*$/, "").replace(/[=<>~!].*$/, "")
  return basename(noVersion)
}

/** Convert one registry entry to a preset (undefined if it has no stdio command we can describe). */
export function registryAgentToPreset(a: RegistryAgent, platform = currentPlatformKey()): AcpPreset | undefined {
  const d = a.distribution ?? {}
  const notes: string[] = []
  if (a.description) notes.push(a.description)
  const bin = d.binary?.[platform]
  if (bin?.cmd) {
    const name = basename(bin.cmd).replace(/\.exe$/, "")
    notes.push(`registry binary distribution (${a.version ?? "?"}); install it so \`${name}\` is on PATH`)
    return { id: a.id, displayName: a.name ?? a.id, binaries: [name], args: bin.args ?? [], env: bin.env, notes }
  }
  const pkg = d.npx ?? d.uvx
  if (pkg?.package) {
    const name = packageBin(pkg.package)
    const via = d.npx ? "npm i -g" : "uv tool install"
    const bins = [...new Set([name, a.id])]
    notes.push(
      `registry ${d.npx ? "npm" : "uv"} package ${pkg.package}; install with \`${via} ${pkg.package.replace(/@[^@/]+$/, "")}\` (binary name may differ — set command if detection fails)`,
    )
    return { id: a.id, displayName: a.name ?? a.id, binaries: bins, args: pkg.args ?? [], env: pkg.env, notes }
  }
  return undefined
}

/**
 * Download the registry and convert entries to presets. Returns [] when offline or on any
 * error (never throws).
 */
export async function fetchAcpRegistry(opts: { url?: string; timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<AcpPreset[]> {
  const f = opts.fetch ?? fetch
  try {
    const res = await f(opts.url ?? ACP_REGISTRY_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) })
    if (!res.ok) return []
    const json = (await res.json()) as { agents?: RegistryAgent[] }
    if (!Array.isArray(json.agents)) return []
    return json.agents.map((a) => registryAgentToPreset(a)).filter((p): p is AcpPreset => !!p)
  } catch {
    return []
  }
}
