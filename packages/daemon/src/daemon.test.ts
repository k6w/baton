import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonClient } from "@batonsh/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { type Daemon, startDaemon } from "./daemon.ts"

let daemon: Daemon
let client: BatonClient
const root = mkdtempSync(join(tmpdir(), "baton-daemon-"))

async function until(pred: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout")
    await Bun.sleep(10)
  }
}

beforeAll(async () => {
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  daemon = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "t.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 }, policy: { preset: "strict" } },
  })
  client = await BatonClient.open(daemon.socketPath, "test")
})

afterAll(async () => {
  client?.close()
  await daemon?.stop()
})

describe("daemon", () => {
  test("hello + snapshot", async () => {
    const snap = await client.call("state.snapshot", {})
    expect(snap.runId).toBe(daemon.runtime.runId)
    expect(snap.projectRoot).toBe(root)
  })

  test("spawn mock agents, live state follows over the socket", async () => {
    const run = await client.live()
    const a = await client.spawn({ adapter: "mock", name: "alpha", options: { speed: 0 }, approval: "auto" })
    const b = await client.spawn({ adapter: "mock", name: "beta", options: { speed: 0 }, approval: "auto" })
    await until(() => run.state.agents.get(a.agentId)?.status === "ready" && run.state.agents.get(b.agentId)?.status === "ready")
    await client.prompt(a.agentId, "pong please")
    await until(() => run.state.feed(a.agentId).items.some((i) => i.kind === "message" && i.text === "PONG"))
    await run.stop()
  })

  test("agents talk to each other through the MCP server", async () => {
    const rt = daemon.runtime
    const a = rt.findAgent("alpha")!
    const b = rt.findAgent("beta")!
    const mcp = new Client({ name: "fake-agent", version: "1" })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${rt.mcpBaseUrl}/mcp/${a.token}`)))
    const tools = await mcp.listTools()
    const names = tools.tools.map((t) => t.name)
    expect(names).toContain("send_message")
    expect(names).toContain("list_agents")
    expect(names).not.toContain("kill_agent") // worker, not orchestrator

    const listed = await mcp.callTool({ name: "list_agents", arguments: {} })
    expect(JSON.stringify(listed.content)).toContain("beta")

    await mcp.callTool({ name: "send_message", arguments: { to: "beta", body: "pong — tailwind landed", kind: "request" } })
    await until(() => rt.state.bus.some((m) => m.from === a.info.agentId && m.to === b.info.agentId && m.body.includes("tailwind")))
    // beta is idle → message delivered as a new turn
    await until(() => rt.state.feed(b.info.agentId).items.some((i) => i.kind === "user" && i.text.includes("Message from alpha")))
    await until(() => rt.state.bus.some((m) => m.delivered))
    // beta's turn result goes back to alpha (it was a request)
    await until(() => rt.state.bus.some((m) => m.kind === "result" && m.from === b.info.agentId))
    await mcp.close()
  })

  test("@mentions route directly, unknown mention errors", async () => {
    const r = await client.submit("@alpha @beta pong")
    expect(r.routedTo.sort()).toEqual(["alpha", "beta"])
    await expect(client.submit("@nobody hi")).rejects.toThrow(/no agent/)
  })

  test("orchestrator is spawned lazily for plain input and gets lead tools", async () => {
    const r = await client.submit("pong")
    expect(r.routedTo).toEqual(["orchestrator"])
    const orch = daemon.runtime.orchestrator()!
    expect(orch.info.isOrchestrator).toBe(true)
    const mcp = new Client({ name: "lead", version: "1" })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${daemon.runtime.mcpBaseUrl}/mcp/${orch.token}`)))
    const names = (await mcp.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(["spawn_agent", "wait_for_results", "kill_agent", "interrupt_agent"]))
    const spawned = await mcp.callTool({ name: "spawn_agent", arguments: { adapter: "mock", count: 2, label: "typo hunt", task: "pong" } })
    expect(JSON.stringify(spawned.content)).toContain("mock-")
    const res = await mcp.callTool({ name: "wait_for_results", arguments: { timeout_s: 10 } })
    expect(JSON.stringify(res.content)).toContain("result ok")
    await mcp.close()
  })

  test("permission requests: strict policy asks, user approves via the socket", async () => {
    const run = await client.live()
    const g = await client.spawn({ adapter: "mock", name: "gamma", options: { speed: 0, seed: 3 }, approval: "ask" })
    await client.prompt(g.agentId, "do some work")
    await until(() => run.state.approvals.size > 0, 8000)
    const p = [...run.state.approvals.values()][0]!
    expect(p.agentId).toBe(g.agentId)
    const allow = p.options.find((o) => o.kind === "allow_once")!
    await client.respond(p.agentId, p.requestId, allow.optionId)
    await until(() => !run.state.approvals.has(p.requestId))
    await run.stop()
  })

  test("/commands", async () => {
    const r = await client.submit("/spawn mock 2 load test")
    expect(r.routedTo.length).toBe(2)
    const kill = await client.submit(`/kill ${r.routedTo[0]}`)
    expect(kill.output).toBe("killed 1")
    await expect(client.submit("/nope")).rejects.toThrow(/unknown command/)
  })
})
