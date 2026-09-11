/**
 * Codex adapter: drives `codex app-server` (JSON-RPC over stdio) and translates its thread /
 * turn / item notifications into BEP events. Types under ./generated come from
 * `codex app-server generate-ts` (codex-cli 0.162.1) — regenerate when bumping Codex.
 */
import type { AgentAdapter } from "@batonsh/protocol"
import { defineAdapter, which } from "@batonsh/protocol"
import { codexModels, detectCodex } from "./detect.ts"
import { CodexSession } from "./session.ts"

export { approvalSettings, appServerArgs, mcpConfigArgs } from "./config.ts"
export { CodexTranslator } from "./translator.ts"

export const codexAdapter: AgentAdapter = defineAdapter({
  id: "codex",
  displayName: "Codex",
  family: "codex",
  binaries: ["codex"],

  detect: (opts) => detectCodex(opts),

  capabilities: () => ({
    steer: true,
    interrupt: true,
    resume: true,
    fork: true,
    diff: true,
    usage: true,
    cost: false,
    permissions: true,
    mcp: true,
    models: codexModels(),
  }),

  async start(cfg, ctx) {
    const bin = which(cfg.command ?? "codex")
    if (!bin) throw new Error(`codex binary not found (${cfg.command ?? "codex"}); install the Codex CLI`)
    const session = new CodexSession(cfg, ctx, { bin, tapFile: process.env.BATON_CODEX_TAP || undefined })
    await session.start()
    return session
  },
})

export default codexAdapter
