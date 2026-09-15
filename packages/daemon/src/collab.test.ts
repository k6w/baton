import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonClient } from "@batonsh/sdk"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { matchGlob } from "./collab.ts"
import { type Daemon, startDaemon } from "./daemon.ts"
import { git } from "./git.ts"

let d: Daemon
let client: BatonClient
let root: string

async function until(pred: () => boolean, ms = 8000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout")
    await Bun.sleep(15)
  }
}

async function mcpFor(name: string): Promise<Client> {
  const a = d.runtime.findAgent(name)!
  const c = new Client({ name, version: "1" })
  await c.connect(new StreamableHTTPClientTransport(new URL(`${d.runtime.mcpBaseUrl}/mcp/${a.token}`)))
  return c
}

const text = (r: unknown) => JSON.stringify((r as { content: unknown }).content)

beforeAll(async () => {
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  root = mkdtempSync(join(tmpdir(), "baton-collab-"))
  await git(root, ["init", "-q", "-b", "main"])
  writeFileSync(join(root, "a.ts"), "export const a = 1\n")
  await git(root, ["add", "-A"])
  await git(root, ["commit", "-q", "-m", "init"])
  d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { orchestrator: { agent: "mock", plan_approval: true }, bus: { heartbeat_s: 0 }, workspace: { review: "required" } },
  })
  client = await BatonClient.open(d.socketPath)
  await d.runtime.ensureOrchestrator()
})

afterAll(async () => {
  client?.close()
  await d?.stop()
})

describe("collaboration", () => {
  test("workers get worktrees; the orchestrator works in the project", async () => {
    const w = await client.spawn({ adapter: "mock", name: "w1", options: { speed: 0 } })
    const ws = d.runtime.state.workspaces.get(w.agentId)!
    expect(ws.mode).toBe("worktree")
    expect(ws.path).not.toBe(root)
    expect(d.runtime.state.agents.get(w.agentId)!.cwd).toBe(ws.path)
    const lead = d.runtime.orchestrator()!
    expect(d.runtime.state.workspaces.get(lead.info.agentId)!.mode).toBe("shared")
  })

  test("leases: exclusive claims block others and are visible in state", async () => {
    await client.spawn({ adapter: "mock", name: "w2", options: { speed: 0 } })
    const m1 = await mcpFor("w1")
    const m2 = await mcpFor("w2")
    expect(text(await m1.callTool({ name: "claim_files", arguments: { paths: ["src/auth/**"] } }))).toContain("claimed")
    const denied = await m2.callTool({ name: "claim_files", arguments: { paths: ["src/auth/login.ts"] } })
    expect(denied.isError).toBe(true)
    expect(text(denied)).toContain("w1")
    expect(d.runtime.state.workspaces.get(d.runtime.findAgent("w1")!.info.agentId)!.leases.length).toBe(1)
    await m1.callTool({ name: "release_files", arguments: {} })
    expect(text(await m2.callTool({ name: "claim_files", arguments: { paths: ["src/auth/login.ts"] } }))).toContain("claimed")
    await m1.close()
    await m2.close()
    expect(matchGlob("src/auth/**", "src/auth/x/y.ts")).toBe(true)
    expect(matchGlob("README.md", "README.md")).toBe(true)
    expect(matchGlob("src", "src/a.ts")).toBe(true)
  })

  test("changes are tracked, conflicts predicted, review gate enforced, merge lands the work", async () => {
    const w1 = d.runtime.findAgent("w1")!
    const w2 = d.runtime.findAgent("w2")!
    const p1 = d.runtime.state.workspaces.get(w1.info.agentId)!.path
    const p2 = d.runtime.state.workspaces.get(w2.info.agentId)!.path
    writeFileSync(join(p1, "a.ts"), "export const a = 'w1'\n")
    writeFileSync(join(p2, "a.ts"), "export const a = 'w2'\n")
    await d.runtime.collab.refresh(w1.info.agentId)
    await d.runtime.collab.refresh(w2.info.agentId)
    await until(() => (d.runtime.state.workspaces.get(w2.info.agentId)?.conflicts.length ?? 0) > 0)
    expect(d.runtime.state.workspaces.get(w1.info.agentId)!.files.map((f) => f.path)).toEqual(["a.ts"])
    // the lead is told about the conflict
    await until(() => d.runtime.state.bus.some((m) => m.from === "baton" && m.body.includes("Conflict ahead")))

    const lead = await mcpFor("orchestrator")
    const diff = text(await lead.callTool({ name: "get_diff", arguments: { agent: "w1" } }))
    expect(diff).toContain("w1")
    // review required: merge refuses first
    const refused = await lead.callTool({ name: "merge", arguments: { agent: "w1" } })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toContain("review")
    // reviewer (explicitly the mock adapter here) approves via submit_review
    expect(text(await lead.callTool({ name: "request_review", arguments: { agent: "w1", reviewer: "mock" } }))).toContain("reviewing w1")
    const reviewer = [...d.runtime.agents.values()].find((a) => a.info.label === "review w1")!
    expect(d.runtime.state.agents.get(reviewer.info.agentId)!.cwd).toBe(p1) // reviews the author's worktree in place
    const rm = await mcpFor(reviewer.info.name)
    await rm.callTool({ name: "submit_review", arguments: { verdict: "approve", notes: "LGTM" } })
    await rm.close()
    await until(() => d.runtime.state.workspaces.get(w1.info.agentId)?.review?.status === "approve")
    const merged = await lead.callTool({ name: "merge", arguments: { agent: "w1" } })
    expect(text(merged)).toContain("merged w1")
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export const a = 'w1'\n")
    // w2 now conflicts for real; sync puts markers in its worktree
    const syncRes = text(await lead.callTool({ name: "sync", arguments: { agent: "w2" } }))
    expect(syncRes).toContain("conflicts in a.ts")
    expect(readFileSync(join(p2, "a.ts"), "utf8")).toContain("<<<<<<<")
    await lead.close()
  })

  test("plans wait for the user's approval and track task progress", async () => {
    const lead = await mcpFor("orchestrator")
    const pending = lead.callTool({
      name: "plan_tasks",
      arguments: {
        tasks: [
          { id: "fix", title: "Fix the bug" },
          { id: "test", title: "Add a test", deps: ["fix"] },
        ],
      },
    })
    await until(() => d.runtime.state.plan?.status === "proposed")
    expect(d.runtime.state.tasks.get("test")?.deps).toEqual(["fix"])
    const r = await client.submit("/plan approve go ahead")
    expect(r.output).toBe("plan approved")
    expect(text(await pending)).toContain("go ahead")
    await lead.callTool({ name: "spawn_agent", arguments: { adapter: "mock", task: "pong", task_id: "fix", isolation: "shared" } })
    await until(() => d.runtime.state.tasks.get("fix")?.state === "completed")
    await lead.close()
  })

  test("killing an agent removes clean worktrees and keeps unmerged ones", async () => {
    const w3 = await client.spawn({ adapter: "mock", name: "w3", options: { speed: 0 } })
    const p3 = d.runtime.state.workspaces.get(w3.agentId)!.path
    await client.kill(w3.agentId)
    expect(existsSync(p3)).toBe(false)
    const w2 = d.runtime.findAgent("w2")!
    const p2 = d.runtime.state.workspaces.get(w2.info.agentId)!.path
    await client.kill(w2.info.agentId)
    expect(existsSync(p2)).toBe(true) // unmerged (conflicted) work is never thrown away
  })
})
