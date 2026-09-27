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

test("spawn guard: parallel spawns need a reason; above the soft limit the user decides", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js")
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js")
  const root = mkdtempSync(join(tmpdir(), "baton-guard-"))
  const d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 }, budget: { soft_max_agents: 2 }, policy: { preset: "yolo" } },
  })
  const rt = d.runtime
  const lead = await rt.ensureOrchestrator()
  const c = new Client({ name: "lead", version: "1" })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${rt.mcpBaseUrl}/mcp/${lead.token}`)))
  const call = (args: Record<string, unknown>) => c.callTool({ name: "spawn_agent", arguments: { adapter: "mock", ...args } })
  const noReason = await call({ count: 2 })
  expect(noReason.isError).toBe(true)
  expect(JSON.stringify(noReason.content)).toContain("reason")
  expect(JSON.stringify((await call({ count: 2, reason: "two independent files" })).content)).toContain("spawned")
  // third agent: above the soft limit → an ask appears (yolo policy must NOT auto-approve it)
  const pending = call({ reason: "one more" })
  const until = async (p: () => boolean) => {
    for (let i = 0; i < 200 && !p(); i++) await Bun.sleep(10)
  }
  await until(() => rt.state.approvals.size > 0)
  const ask = [...rt.state.approvals.values()][0]!
  expect(ask.title).toContain("start 1 more mock agent (3 total)?")
  await rt.resolvePermission(ask.agentId, ask.requestId, "no")
  const declined = await pending
  expect(declined.isError).toBe(true)
  expect(JSON.stringify(declined.content)).toContain("declined")
  await c.close()
  await d.stop()
})

test("remote notify: webhook receives approvals even with no TUI attached", async () => {
  const got: unknown[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push(await req.json())
      return new Response("ok")
    },
  })
  const root = mkdtempSync(join(tmpdir(), "baton-hook-"))
  const d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { bus: { heartbeat_s: 0 }, notify: { webhook: `http://127.0.0.1:${server.port}/hook` } },
  })
  const w = await d.runtime.spawn({ adapter: "mock", name: "asker", approval: "ask", options: { speed: 0, steps: ["exec"] } })
  await d.runtime.promptAgent(w.agentId, "risky")
  for (let i = 0; i < 300 && got.length === 0; i++) await Bun.sleep(10)
  expect(got[0]).toMatchObject({ kind: "approval", title: "Baton — approval needed" })
  expect(String((got[0] as { body: string }).body)).toContain("asker")
  await d.stop()
  server.stop(true)
})

test("routing tiers pick the model; task.edit renames/cancels plan tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "baton-tier-"))
  const d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { bus: { heartbeat_s: 0 }, routing: { mock: { small: "mock-mini", large: "mock-max" } } },
  })
  const a = await d.runtime.spawn({ adapter: "mock", tier: "small", options: { speed: 0 } })
  expect(a.model).toBe("mock-mini")
  const b = await d.runtime.spawn({ adapter: "mock", tier: "large", model: "explicit", options: { speed: 0 } })
  expect(b.model).toBe("explicit")
  const { BatonClient } = await import("@batonsh/sdk")
  const c = await BatonClient.open(d.socketPath)
  d.runtime.emit({ type: "task.created", data: { taskId: "t1", title: "Old title", deps: [] } })
  await c.call("task.edit", { taskId: "t1", title: "New title" })
  expect(d.runtime.state.tasks.get("t1")?.title).toBe("New title")
  await c.call("task.edit", { taskId: "t1", cancel: true })
  expect(d.runtime.state.tasks.get("t1")?.state).toBe("canceled")
  c.close()
  await d.stop()
})

test("telemetry: OTLP spans for agent turns and tool calls, nested, no content", async () => {
  const bodies: any[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      bodies.push(await req.json())
      return new Response("{}")
    },
  })
  const root = mkdtempSync(join(tmpdir(), "baton-otel-"))
  const d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { bus: { heartbeat_s: 0 }, telemetry: { otlp_endpoint: `http://127.0.0.1:${server.port}` } },
  })
  const w = await d.runtime.spawn({ adapter: "mock", name: "traced", approval: "auto", options: { speed: 0, steps: ["read", "edit"] } })
  await d.runtime.promptAgent(w.agentId, "secret prompt text")
  for (let i = 0; i < 300 && !d.runtime.store.query({ types: ["turn.completed"], agentId: w.agentId }).length; i++) await Bun.sleep(10)
  await d.stop()
  server.stop(true)
  const spans = bodies.flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans)
  const turn = spans.find((s: any) => s.name === "invoke_agent traced")
  expect(turn).toBeTruthy()
  const tools = spans.filter((s: any) => s.name.startsWith("execute_tool"))
  expect(tools.length).toBe(2)
  expect(tools.every((t: any) => t.parentSpanId === turn.spanId && t.traceId === turn.traceId)).toBe(true)
  expect(turn.attributes.find((a: any) => a.key === "gen_ai.system").value.stringValue).toBe("mock")
  expect(JSON.stringify(bodies)).not.toContain("secret prompt text")
})
