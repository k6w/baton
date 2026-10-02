import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { connect } from "@batonsh/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const root = mkdtempSync(join(tmpdir(), "baton-mcp-"))
const env = {
  ...(process.env as Record<string, string>),
  BATON_CONFIG_DIR: mkdtempSync(join(tmpdir(), "baton-cfg-")),
  BATON_STATE_DIR: mkdtempSync(join(tmpdir(), "baton-state-")),
}
Bun.spawnSync(["git", "init", "-q"], { cwd: root })
mkdirSync(join(root, ".baton"))
writeFileSync(join(root, ".baton", "config.toml"), `[orchestrator]\nagent = "mock"\n[bus]\nheartbeat_s = 0\n[workspace]\nisolation = "shared"\n`)

let client: Client | undefined

afterAll(async () => {
  await client?.close()
  const saved = { ...process.env }
  Object.assign(process.env, env)
  try {
    const c = await connect({ cwd: root, autostart: false })
    await c.shutdown().catch(() => {})
    c.close()
  } catch {}
  process.env = saved
})

const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]?.text ?? ""

test("baton mcp: another agent can run a task, follow it and steer the team", async () => {
  client = new Client({ name: "test", version: "1" })
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(import.meta.dir, "main.ts"), "mcp", "--root", root], env, stderr: "ignore" }),
  )
  const tools = (await client.listTools()).tools.map((t) => t.name).sort()
  expect(tools).toEqual(["answer", "diff", "interrupt", "merge", "message", "run_task", "set_autonomy", "status", "wait"])
  expect(text(await client.callTool({ name: "status", arguments: {} }))).toContain("autonomy normal")
  const run = text(await client.callTool({ name: "run_task", arguments: { task: "say hello", wait_s: 30 } }))
  expect(run).toMatch(/the team is done|needs a decision|still working/)
  expect(run).toContain("lead: mock")
  expect(text(await client.callTool({ name: "set_autonomy", arguments: { level: "auto" } }))).toContain("autonomy: auto")
  expect(text(await client.callTool({ name: "status", arguments: {} }))).toContain("autonomy auto")
  const bad = await client.callTool({ name: "answer", arguments: { request_id: "nope", decision: "allow" } })
  expect(bad.isError).toBe(true)
}, 60_000)
