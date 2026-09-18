import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemon } from "./daemon.ts"

test("watchdog flags silent busy agents and tells the lead", async () => {
  const root = mkdtempSync(join(tmpdir(), "baton-wd-"))
  const d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 } },
  })
  const rt = d.runtime
  await rt.ensureOrchestrator()
  const w = await rt.spawn({ adapter: "mock", name: "slow", options: { speed: 1000, steps: ["read", "read"] } })
  await rt.promptAgent(w.agentId, "work slowly")
  await Bun.sleep(50)
  rt.watchdog(Date.now() + 10 * 60_000)
  expect(rt.state.agents.get(w.agentId)?.attention?.reason).toBe("stalled")
  expect(rt.state.bus.some((m) => m.from === "baton" && m.body.includes("slow has shown no activity"))).toBe(true)
  // a second check doesn't re-flag
  const n = rt.store.query({ types: ["agent.attention"], agentId: w.agentId }).length
  rt.watchdog(Date.now() + 20 * 60_000)
  expect(rt.store.query({ types: ["agent.attention"], agentId: w.agentId }).length).toBe(n)
  await d.stop()
})
