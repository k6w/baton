/**
 * Stream-JSON adapter family: one runtime for CLIs that speak Claude Code's stream-json protocol
 * (Claude Code `-p`, Amp `--execute --stream-json`, Qwen Code headless), parameterized by presets.
 */
import type { AgentAdapter, DetectResult } from "../../../protocol/src/index.ts"
import { defineAdapter, parseVersion, runCapture, which } from "../../../protocol/src/index.ts"
import { ampPreset, claudeCliPreset, qwenStreamPreset } from "./presets.ts"
import { childEnv, startSession, type Timings } from "./session.ts"
import type { StreamJsonPreset } from "./types.ts"

export { type Dialect, normalizeMessage, normalizeTool } from "./dialect.ts"
export { ampPreset, builtinPresets, claudeCliPreset, qwenStreamPreset } from "./presets.ts"
export { launchArgv } from "./session.ts"
export type { AuthResult, LaunchContext, StreamJsonPreset, UserMessageOptions } from "./types.ts"

function resolveBinary(preset: StreamJsonPreset, command?: string): string | undefined {
  if (command) return which(command)
  for (const b of preset.binaries) {
    const p = which(b)
    if (p) return p
  }
  return undefined
}

export function createStreamJsonAdapter(preset: StreamJsonPreset, opts: { timings?: Timings } = {}): AgentAdapter {
  async function detect(o?: { command?: string }): Promise<DetectResult> {
    const path = resolveBinary(preset, o?.command)
    if (!path) return { installed: false, auth: "unknown", authHint: preset.installHint, protocols: preset.protocols }
    const env = childEnv(preset, { agentId: "detect", name: "detect", cwd: process.cwd(), mcpServers: [], approval: "ask" })
    const v = await runCapture([path, ...(preset.prefixArgs ?? []), ...(preset.versionArgs ?? ["--version"])], { timeoutMs: 10_000, env }).catch(
      () => undefined,
    )
    const version = v ? parseVersion(`${v.stdout}\n${v.stderr}`) : undefined
    const a = preset.detectAuth ? await preset.detectAuth(path).catch(() => ({ auth: "unknown" as const })) : { auth: "unknown" as const }
    return {
      installed: true,
      ...(version ? { version } : {}),
      path,
      ...a,
      protocols: preset.protocols,
    }
  }

  return defineAdapter({
    id: preset.id,
    displayName: preset.displayName,
    family: "stream-json",
    binaries: preset.binaries,
    detect,
    capabilities: () => ({ ...preset.capabilities, models: [...preset.capabilities.models] }),
    async start(cfg, ctx) {
      const binary = resolveBinary(preset, cfg.command)
      if (!binary) throw new Error(`${preset.displayName} (\`${preset.binaries[0] ?? preset.id}\`) not found on PATH; install it or set the agent's command`)
      return startSession(preset, binary, cfg, ctx, opts.timings)
    },
  })
}

export const claudeCliAdapter = createStreamJsonAdapter(claudeCliPreset)
export const ampAdapter = createStreamJsonAdapter(ampPreset)
export const qwenStreamAdapter = createStreamJsonAdapter(qwenStreamPreset)

export const streamJsonAdapters: AgentAdapter[] = [claudeCliAdapter, ampAdapter, qwenStreamAdapter]

export default createStreamJsonAdapter
