import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonClient } from "@batonsh/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { type Daemon, startDaemon } from "./daemon.ts"
import { diffStat, pageText, waitTuning } from "./mcp.ts"

/**
 * The error a daemon call fails with. Not `expect(promise).rejects`: Bun waits on that promise
 * without serving the named pipe the reply comes back on (Windows), so it can hang until the timeout.
 */
const failure = (p: Promise<unknown>) =>
  p.then(
    () => new Error("expected the call to fail"),
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  )

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

  // skipped on Windows: under bun's test runner the client stops receiving replies after the MCP test
  // (a runner issue, not Baton's: the same flow passes as a script there, see scripts/check-inproc.ts)
  test.skipIf(process.platform === "win32")("@mentions route directly, unknown mention errors", async () => {
    const r = await client.submit("@alpha @beta pong")
    expect(r.routedTo.sort()).toEqual(["alpha", "beta"])
    expect((await failure(client.submit("@nobody hi"))).message).toMatch(/no agent/)
  })

  // skipped on Windows: under bun's test runner the client stops receiving replies after the MCP test
  // (a runner issue, not Baton's: the same flow passes as a script there, see scripts/check-inproc.ts)
  test.skipIf(process.platform === "win32")("orchestrator is spawned lazily for plain input and gets lead tools", async () => {
    const r = await client.submit("pong")
    expect(r.routedTo).toEqual(["orchestrator"])
    const orch = daemon.runtime.orchestrator()!
    expect(orch.info.isOrchestrator).toBe(true)
    const mcp = new Client({ name: "lead", version: "1" })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${daemon.runtime.mcpBaseUrl}/mcp/${orch.token}`)))
    const names = (await mcp.listTools()).tools.map((t) => t.name)
    expect(names).toEqual(expect.arrayContaining(["spawn_agent", "wait_for_results", "kill_agent", "interrupt_agent"]))
    const spawned = await mcp.callTool({
      name: "spawn_agent",
      arguments: { adapter: "mock", count: 2, label: "typo hunt", task: "pong", reason: "independent checks" },
    })
    expect(JSON.stringify(spawned.content)).toContain("mock-")
    const res = await mcp.callTool({ name: "wait_for_results", arguments: { timeout_s: 10 } })
    expect(JSON.stringify(res.content)).toContain("result ok")
    await mcp.close()
  })

  // skipped on Windows: under bun's test runner the client stops receiving replies after the MCP test
  // (a runner issue, not Baton's: the same flow passes as a script there, see scripts/check-inproc.ts)
  test.skipIf(process.platform === "win32")("permission requests: strict policy asks, user approves via the socket", async () => {
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

  // skipped on Windows: under bun's test runner the client stops receiving replies after the MCP test
  // (a runner issue, not Baton's: the same flow passes as a script there, see scripts/check-inproc.ts)
  test.skipIf(process.platform === "win32")("/commands", async () => {
    const r = await client.submit("/spawn mock 2 load test")
    expect(r.routedTo.length).toBe(2)
    const kill = await client.submit(`/kill ${r.routedTo[0]}`)
    expect(kill.output).toBe("killed 1")
    expect((await failure(client.submit("/nope"))).message).toMatch(/unknown command/)
  })
  test("get_diff helpers: per-file stat and line-aligned byte pages", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
      "+more",
      "--- removed sql comment",
      "+++ added line",
      "diff --git a/img.png b/img.png",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n")
    expect(diffStat(diff)).toEqual([
      { path: "src/a.ts", added: 3, removed: 2, binary: false },
      { path: "img.png", added: 0, removed: 0, binary: true },
    ])
    const big = Array.from({ length: 5000 }, (_, i) => `+line ${i} — ünïcödé`).join("\n")
    const total = Buffer.byteLength(big, "utf8")
    let offset = 0
    let joined = ""
    let pages = 0
    for (;;) {
      const p = pageText(big, offset, 4000)
      expect(Buffer.byteLength(p.page, "utf8")).toBeLessThanOrEqual(4000)
      expect(p.total).toBe(total)
      joined += p.page
      pages++
      if (p.next === undefined) break
      expect(p.page.endsWith("\n")).toBe(true)
      offset = p.next
    }
    expect(joined).toBe(big)
    expect(pages).toBeGreaterThan(total / 4000 - 1)
    // a single line longer than the page is cut without splitting a character
    const p = pageText("ü".repeat(3000), 0, 1001)
    expect(p.page).toBe("ü".repeat(500))
    expect(p.next).toBe(1000)
  })

  test.skipIf(process.platform === "win32")("wait_for_results returns results already queued in the inbox", async () => {
    const rt = daemon.runtime
    const orch = rt.orchestrator()!
    const alpha = rt.findAgent("alpha")!
    const mcp = new Client({ name: "lead", version: "1" })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${rt.mcpBaseUrl}/mcp/${orch.token}`)))
    const wasBusy = orch.busy
    orch.busy = true // a busy lead keeps incoming results in its inbox
    try {
      rt.send({ from: alpha.info.agentId, to: "orchestrator", body: "alpha finished: queued-result-42", kind: "result" })
      expect(orch.inbox.some((m) => m.body.includes("queued-result-42"))).toBe(true)
      const t0 = Date.now()
      const res = await mcp.callTool({ name: "wait_for_results", arguments: { timeout_s: 30 } })
      expect(JSON.stringify(res.content)).toContain("queued-result-42")
      expect(Date.now() - t0).toBeLessThan(5000)
      expect(orch.inbox.some((m) => m.body.includes("queued-result-42"))).toBe(false)
    } finally {
      orch.busy = wasBusy
      await mcp.close()
    }
  })

  test.skipIf(process.platform === "win32")("wait_for_results: honest early return for short-timeout clients, keep-alive progress otherwise", async () => {
    const rt = daemon.runtime
    const orch = rt.orchestrator()!
    const mcp = new Client({ name: "lead", version: "1" })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${rt.mcpBaseUrl}/mcp/${orch.token}`)))
    const saved = { ...waitTuning, longHoldAdapters: new Set(waitTuning.longHoldAdapters) }
    try {
      // the lead's adapter can't hold long calls: returns before the client would time out, says so
      waitTuning.longHoldAdapters.delete(orch.info.adapter)
      waitTuning.shortHoldMs = 400
      let t0 = performance.now()
      let res = await mcp.callTool({ name: "wait_for_results", arguments: { agents: ["alpha"], timeout_s: 1800 } })
      let text = JSON.stringify(res.content)
      expect(performance.now() - t0).toBeGreaterThanOrEqual(390)
      expect(performance.now() - t0).toBeLessThan(5000)
      expect(text).toContain("still waiting after")
      expect(text).toContain("of timeout_s 1800")
      expect(text).toContain("alpha (")
      expect(text).toContain("call wait_for_results again")
      // Claude Code times tool calls out after ~60 s without progress: it gets the short hold too
      expect(waitTuning.longHoldAdapters.has("claude")).toBe(false)

      // read_inbox wait_s gets the same honest early return
      t0 = performance.now()
      res = await mcp.callTool({ name: "read_inbox", arguments: { wait_s: 600 } })
      text = JSON.stringify(res.content)
      expect(performance.now() - t0).toBeGreaterThanOrEqual(390)
      expect(performance.now() - t0).toBeLessThan(5000)
      expect(text).toContain("of wait_s 600")
      expect(text).toContain("call read_inbox again")

      // a client that asks for progress gets keep-alives and the full timeout, even with a request
      // timeout shorter than the wait
      waitTuning.progressMs = 100
      const progress: number[] = []
      t0 = performance.now()
      res = await mcp.callTool({ name: "wait_for_results", arguments: { agents: ["alpha"], timeout_s: 2 } }, undefined, {
        timeout: 700,
        resetTimeoutOnProgress: true,
        onprogress: (p) => progress.push(p.progress),
      })
      text = JSON.stringify(res.content)
      expect(performance.now() - t0).toBeGreaterThanOrEqual(1990)
      expect(progress.length).toBeGreaterThan(3)
      expect(text).toContain("timeout reached")

      // unknown agents fail fast instead of waiting out the timeout
      res = await mcp.callTool({ name: "wait_for_results", arguments: { agents: ["nobody"], timeout_s: 60 } })
      expect(res.isError).toBe(true)
    } finally {
      Object.assign(waitTuning, saved)
      await mcp.close()
    }
  })

  test.skipIf(process.platform === "win32")("orchestrator lists and answers worker approvals over MCP", async () => {
    const rt = daemon.runtime
    const orch = rt.orchestrator()!
    const mcp = new Client({ name: "lead", version: "1" })
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${rt.mcpBaseUrl}/mcp/${orch.token}`)))
    try {
      const d = await client.spawn({ adapter: "mock", name: "delta", options: { speed: 0, seed: 3 }, approval: "ask" })
      await client.prompt(d.agentId, "do some work")
      await until(() => [...rt.state.approvals.values()].some((p) => p.agentId === d.agentId), 8000)
      const p = [...rt.state.approvals.values()].find((x) => x.agentId === d.agentId)!

      const listed = JSON.stringify((await mcp.callTool({ name: "list_approvals", arguments: {} })).content)
      expect(listed).toContain(p.requestId)
      expect(listed).toContain("delta")
      const agents = JSON.stringify((await mcp.callTool({ name: "list_agents", arguments: {} })).content)
      expect(agents).toContain(`awaiting approval [${p.requestId}]`)

      const bad = await mcp.callTool({ name: "answer_approval", arguments: { request_id: "nope", allow: true } })
      expect(bad.isError).toBe(true)
      const ans = await mcp.callTool({ name: "answer_approval", arguments: { request_id: p.requestId, allow: true } })
      expect(ans.isError).toBeFalsy()
      expect(JSON.stringify(ans.content)).toContain("allow_once")
      await until(() => !rt.state.approvals.has(p.requestId))
    } finally {
      await mcp.close()
    }
  })
})
