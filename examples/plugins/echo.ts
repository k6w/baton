// .baton/plugins/echo.ts — plugins need no runtime imports (types are erased), so they run
// from any folder and from the compiled `baton` binary.
import type { AgentAdapter, BatonPlugin } from "@batonsh/sdk"

const id = () => crypto.randomUUID()

const echo: AgentAdapter = {
  id: "echo",
  displayName: "Echo",
  family: "custom",
  binaries: [],
  async detect() {
    return { installed: true, auth: "ok", protocols: ["in-process"] }
  },
  capabilities() {
    return { steer: false, interrupt: true, resume: false, fork: false, diff: false, usage: false, cost: false, permissions: false, mcp: false, models: [] }
  },
  async start(_cfg, ctx) {
    ctx.emit({ type: "agent.status", data: { status: "ready" } })
    return {
      async prompt({ text }) {
        const turnId = id()
        ctx.emit({ type: "turn.started", data: { turnId, prompt: text } })
        ctx.emit({ type: "message.completed", data: { messageId: id(), role: "assistant", text: `echo: ${text}` } })
        ctx.emit({ type: "turn.completed", data: { turnId, stopReason: "end_turn" } })
      },
      async interrupt() {},
      async respondPermission() {},
      resumeId: () => undefined,
      async close() {
        ctx.emit({ type: "agent.exited", data: { code: 0 } })
      },
    }
  },
}

export default { name: "echo", adapters: [echo] } satisfies BatonPlugin
