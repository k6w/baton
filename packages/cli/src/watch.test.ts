import { expect, test } from "bun:test"
import type { BatonEvent } from "@batonsh/protocol"
import { describeEvent } from "./watch.ts"

const ev = (type: string, data: unknown, agentId = "a"): BatonEvent => ({ id: "e", seq: 1, ts: 0, runId: "r", agentId, type, data }) as never

test("watch mode describes events as labelled, plain lines", () => {
  const name = (id?: string) => (id === "a" ? "codex-1" : (id ?? "baton"))
  expect(describeEvent(ev("tool.call", { toolCallId: "t", kind: "read", name: "Read", title: "Read(src/app.ts)", status: "pending" }), name)).toBe(
    "[codex-1] tool: Read(src/app.ts)",
  )
  expect(describeEvent(ev("permission.requested", { requestId: "r", title: "Bash(rm -rf x)", options: [] }), name)).toContain("NEEDS APPROVAL")
  expect(describeEvent(ev("message.delta", { messageId: "m", role: "assistant", text: "x" }), name)).toBeUndefined()
  expect(
    describeEvent(ev("bus.message", { messageId: "m", from: "a", to: "b", kind: "heartbeat", body: "hb", delivery: "queue", priority: "normal" }), name),
  ).toBeUndefined()
})
