import type { AdapterCapabilities, AdapterContext, AgentAdapter, AgentSession, DetectResult, SessionConfig } from "@batonsh/protocol"
import { defineAdapter, parseVersion, runCapture, which } from "@batonsh/protocol"
import type { AcpPreset } from "./presets.ts"
import { runAuthCheck } from "./presets.ts"
import { AcpSession } from "./session.ts"

function resolveBinary(preset: AcpPreset, command?: string): string | undefined {
  if (command) return which(command)
  for (const b of preset.binaries) {
    const p = which(b)
    if (p) return p
  }
  return undefined
}

/**
 * Build an adapter for any agent speaking ACP over stdio.
 *
 * `capabilities().resume` is reported as false: whether an agent supports
 * session/load or session/resume is only known after `initialize`. The session still
 * honours `SessionConfig.resumeId` when the agent advertises either capability.
 */
export function createAcpAdapter(preset: AcpPreset): AgentAdapter {
  return defineAdapter({
    id: preset.id,
    displayName: preset.displayName,
    family: "acp",
    binaries: preset.binaries,

    async detect(opts?: { command?: string }): Promise<DetectResult> {
      const path = resolveBinary(preset, opts?.command)
      const notes = [...(preset.notes ?? [])]
      if (!path) {
        if (!opts?.command && preset.binaries.length === 0) notes.push("no command configured")
        return { installed: false, auth: "unknown", protocols: ["acp"], notes, authHint: preset.authHint }
      }
      let version: string | undefined
      try {
        const r = await runCapture([path, ...(preset.versionArgs ?? ["--version"])], { timeoutMs: 10_000, env: preset.env })
        version = parseVersion(`${r.stdout}\n${r.stderr}`)
      } catch {}
      const auth = await runAuthCheck(preset.authCheck)
      return { installed: true, version, path, auth: auth.auth, authHint: auth.hint ?? preset.authHint, protocols: ["acp"], notes }
    },

    capabilities(_detected?: DetectResult): AdapterCapabilities {
      return {
        steer: false,
        interrupt: true,
        resume: false,
        fork: false,
        diff: true,
        usage: false,
        cost: false,
        permissions: true,
        mcp: true,
        models: preset.models ?? [],
      }
    },

    async start(cfg: SessionConfig, ctx: AdapterContext): Promise<AgentSession> {
      const bin = resolveBinary(preset, cfg.command)
      if (!bin) {
        const what = cfg.command ?? (preset.binaries.join(" / ") || "(no command configured)")
        throw new Error(`${preset.displayName}: executable not found: ${what}`)
      }
      const args = cfg.args ?? preset.args
      const session = new AcpSession({ preset, bin, args }, cfg, ctx)
      await session.start()
      return session
    },
  })
}
