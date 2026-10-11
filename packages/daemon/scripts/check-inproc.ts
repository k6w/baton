/**
 * Daemon and client in one process (as in `baton demo`): live view, agents working, MCP traffic
 * over the bus, then requests and an error reply on the control socket. Exits 1 on any failure.
 * CI runs it on every OS (on Windows it covers what bun's test runner can't: see daemon.test.ts).
 *   bun packages/daemon/scripts/check-inproc.ts
 */
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonClient } from "@batonsh/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { startDaemon } from "../src/index.ts"

const fail = (msg: string): never => {
  console.error(`check-inproc: ${msg}`)
  process.exit(1)
}
const within = <T>(p: Promise<T>, ms: number, what: string) => Promise.race([p, Bun.sleep(ms).then(() => fail(`${what} took over ${ms}ms`))])
const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !ok(); i++) await Bun.sleep(25)
  if (!ok()) fail(`timed out waiting for ${what}`)
}

const root = mkdtempSync(join(tmpdir(), "baton-inproc-"))
Bun.spawnSync(["git", "init", "-q"], { cwd: root })
const d = await startDaemon({
  projectRoot: root,
  ephemeral: true,
  socketPath: join(root, "t.sock"),
  overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 }, policy: { preset: "strict" } },
})
const c = await within(BatonClient.open(join(root, "t.sock"), "check"), 5000, "connecting")
const run = await c.live()
const ids: string[] = []
for (const name of ["alpha", "beta"])
  ids.push((await within(c.spawn({ adapter: "mock", name, options: { speed: 0 }, approval: "auto" }), 10_000, `spawning ${name}`)).agentId)
await until(() => ids.every((id) => run.state.agents.get(id)?.status === "ready"), "agents ready in the live view")
await c.prompt(ids[0] as string, "pong please")
await until(() => run.state.feed(ids[0] as string).items.some((x) => x.kind === "message" && x.text === "PONG"), "PONG in the live view")
await run.stop()

const alpha = d.runtime.findAgent("alpha") ?? fail("no alpha")
const mcp = new Client({ name: "check", version: "1" })
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${d.runtime.mcpBaseUrl}/mcp/${alpha.token}`)))
if ((await mcp.listTools()).tools.length === 0) fail("no MCP tools")
await mcp.callTool({ name: "send_message", arguments: { to: "beta", body: "hello beta", kind: "request" } })
await mcp.close()

const r = await within(c.submit("@alpha @beta pong"), 5000, "submit")
if (r.routedTo.sort().join() !== "alpha,beta") fail(`routed to ${r.routedTo}`)
const err = await within(
  c.submit("@nobody hi").then(
    () => "",
    (e: unknown) => String(e),
  ),
  5000,
  "the error reply",
)
if (!/no agent/.test(err)) fail(`expected "no agent", got "${err}"`)
c.close()
await d.stop()
console.log("check-inproc: ok")
process.exit(0)
