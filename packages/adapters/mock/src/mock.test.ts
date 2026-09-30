import { expect, test } from "bun:test"
import type { AgentEvent, SessionConfig } from "@batonsh/protocol"
import { mockAdapter } from "./index.ts"

const cfg = { agentId: "a", name: "w", cwd: "/tmp", mcpServers: [], approval: "yolo", options: { steps: ["read", "exec", "edit"] } } as unknown as SessionConfig

test("close stops the running turn: no events after agent.exited, exited exactly once", async () => {
  const events: AgentEvent[] = []
  const ac = new AbortController()
  const s = await mockAdapter.start(cfg, { emit: (e: AgentEvent) => events.push(e), log: () => {}, signal: ac.signal } as never)
  await s.prompt({ text: "do it" })
  await s.prompt({ text: "queued" })
  await Bun.sleep(100)
  await s.close()
  ac.abort()
  await s.close()
  await expect(s.prompt({ text: "again" })).rejects.toThrow()
  const atClose = events.length
  await Bun.sleep(1500)
  expect(events.length).toBe(atClose)
  expect(events.at(-1)?.type).toBe("agent.exited")
  expect(events.at(-2)?.type).toBe("turn.interrupted")
  expect(events.filter((e) => e.type === "agent.exited")).toHaveLength(1)
  expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1)
})
