import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent } from "@batonsh/protocol"
import { a2aAdapter } from "../../adapters/a2a/src/index.ts"
import { parseSse } from "../../adapters/a2a/src/wire.ts"
import { startHarness } from "../../adapters/testkit/src/index.ts"
import { type A2AServer, startA2AServer } from "./a2a-server.ts"
import { type Daemon, startDaemon } from "./daemon.ts"

const TOKEN = "a2a-test-token"
let d: Daemon
let srv: A2AServer
let open: A2AServer

beforeAll(async () => {
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-a2a-"))
  d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "a.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 }, workspace: { isolation: "shared" } },
  })
  srv = startA2AServer(d.runtime, { token: TOKEN, idleMs: 300 })
  // a second, token-less endpoint for the adapter round trip
  open = startA2AServer(d.runtime, { idleMs: 300 })
})

afterAll(async () => {
  srv?.stop()
  open?.stop()
  await d?.stop()
})

type Rpc = { jsonrpc: "2.0"; id: number; result?: Record<string, unknown> & { kind?: string }; error?: { code: number; message: string } }
let nextId = 0
async function rpc(method: string, params: unknown, opts: { token?: string | null; version?: string } = {}): Promise<Rpc> {
  const token = opts.token === undefined ? TOKEN : opts.token
  const res = await fetch(`${srv.url}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(opts.version ? { "A2A-Version": opts.version } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  })
  return (await res.json()) as Rpc
}

async function stream(method: string, params: unknown, version = "0.3"): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${srv.url}/`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${TOKEN}`, "A2A-Version": version },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
  })
  expect(res.headers.get("content-type")).toContain("text/event-stream")
  const out: Record<string, unknown>[] = []
  for await (const e of parseSse(res.body!)) out.push((JSON.parse(e.data) as Rpc).result!)
  return out
}

const userMsg = (text: string, extra: Record<string, unknown> = {}) => ({
  kind: "message",
  messageId: crypto.randomUUID(),
  role: "user",
  parts: [{ kind: "text", text }],
  ...extra,
})
const userMsgV1 = (text: string, extra: Record<string, unknown> = {}) => ({ messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }], ...extra })

describe("A2A server", () => {
  test("agent card is public and describes the team (v1.0 + v0.3 fields)", async () => {
    const res = await fetch(`${srv.url}/.well-known/agent-card.json`)
    expect(res.status).toBe(200)
    const card = (await res.json()) as Record<string, any>
    expect(card.name).toContain("Baton")
    expect(card.capabilities.streaming).toBe(true)
    expect(card.supportedInterfaces[0]).toEqual({ url: `${srv.url}/`, protocolBinding: "JSONRPC", protocolVersion: "1.0" })
    expect(card.url).toBe(`${srv.url}/`)
    expect(card.protocolVersion).toBe("0.3.0")
    expect(card.skills.map((s: { id: string }) => s.id)).toContain("code")
    expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe("Bearer")
    expect(card.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }])
    expect((await fetch(`${srv.url}/.well-known/agent.json`)).status).toBe(200)
    const openCard = (await (await fetch(`${open.url}/.well-known/agent-card.json`)).json()) as Record<string, unknown>
    expect(openCard.securitySchemes).toBeUndefined()
  })

  test("JSON-RPC needs the bearer token; protocol errors are JSON-RPC errors", async () => {
    const res = await fetch(`${srv.url}/`, { method: "POST", body: "{}" })
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toContain("Bearer")
    expect((await fetch(`${srv.url}/`, { method: "POST", headers: { authorization: "Bearer nope" }, body: "{}" })).status).toBe(401)
    expect((await rpc("nope/nope", {})).error?.code).toBe(-32601)
    expect((await rpc("tasks/get", { id: "missing" })).error?.code).toBe(-32001)
    expect((await rpc("GetTask", { id: "x" }, { version: "9.0" })).error?.code).toBe(-32009)
    expect((await rpc("message/send", {})).error?.code).toBe(-32602)
    expect((await rpc("CreateTaskPushNotificationConfig", { taskId: "x", url: "http://x" })).error?.code).toBe(-32003)
  })

  test("message/send (v0.3, blocking) completes with the lead's answer; tasks/get returns history", async () => {
    const r = await rpc("message/send", { message: userMsg("summarize the repo") })
    expect(r.error).toBeUndefined()
    const task = r.result as any
    expect(task.kind).toBe("task")
    expect(task.status.state).toBe("completed")
    expect(task.status.message.parts[0].text).toContain("splitting this up")
    expect(task.artifacts.find((a: { name: string }) => a.name === "response").parts[0].text).toContain("splitting this up")
    expect(task.history[0].parts[0].text).toBe("summarize the repo")
    const got = (await rpc("tasks/get", { id: task.id, historyLength: 1 })).result as any
    expect(got.id).toBe(task.id)
    expect(got.history.length).toBe(1)
    // the lead got the text from "a2a"
    const lead = d.runtime.orchestrator()!
    const feed = d.runtime.state.feed(lead.info.agentId).items
    expect(feed.some((i) => i.kind === "user" && i.text.includes("summarize the repo"))).toBe(true)
    // a finished task can't be continued
    expect((await rpc("message/send", { message: userMsg("more", { taskId: task.id }) })).error?.code).toBe(-32004)
    expect((await rpc("tasks/cancel", { id: task.id })).error?.code).toBe(-32002)
  })

  test("SendStreamingMessage (v1.0): task, working updates with lead text, artifacts, completed; contextId reused", async () => {
    const events = await stream("SendStreamingMessage", { message: userMsgV1("add a flag") }, "1.0")
    expect(Object.keys(events[0]!)).toEqual(["task"])
    const first = events[0]!.task as any
    expect(first.status.state).toMatch(/TASK_STATE_(SUBMITTED|WORKING)/)
    const states = events.filter((e) => e.statusUpdate).map((e) => (e.statusUpdate as any).status.state)
    expect(states).toContain("TASK_STATE_WORKING")
    expect(states.at(-1)).toBe("TASK_STATE_COMPLETED")
    const working = events.filter((e) => (e.statusUpdate as any)?.status.message)
    expect(JSON.stringify(working)).toContain("splitting this up")
    expect(events.some((e) => (e.artifactUpdate as any)?.artifact.artifactId === "response")).toBe(true)
    expect(events.every((e) => !("kind" in e))).toBe(true)
    // same context, new task
    const again = await rpc("SendMessage", { message: userMsgV1("and docs", { contextId: first.contextId }) }, { version: "1.0" })
    const t2 = (again.result as any).task
    expect(t2.contextId).toBe(first.contextId)
    expect(t2.id).not.toBe(first.id)
    expect(t2.status.state).toBe("TASK_STATE_COMPLETED")
    const list = (await rpc("ListTasks", { contextId: first.contextId }, { version: "1.0" })).result as any
    expect(list.tasks.length).toBe(2)
    expect(list.totalSize).toBe(2)
  })

  test("message/stream (v0.3): kind-tagged events with final flags", async () => {
    const events = await stream("message/stream", { message: userMsg("hello") })
    expect(events[0]!.kind).toBe("task")
    const last = events.at(-1) as any
    expect(last.kind).toBe("status-update")
    expect(last.final).toBe(true)
    expect(last.status.state).toBe("completed")
  })

  test("an approval puts the task into input-required; 'allow' answers it and the task completes", async () => {
    const w = await d.runtime.spawn({ adapter: "mock", name: "approver", options: { speed: 0 } })
    const r = await rpc("message/send", { message: userMsg("deploy it"), configuration: { blocking: false } })
    const task = r.result as any
    expect(["submitted", "working"]).toContain(task.status.state)
    d.runtime.emit(
      {
        type: "permission.requested",
        data: {
          requestId: "rq-a2a",
          title: "Bash(make deploy)",
          kind: "execute",
          options: [
            { optionId: "y", name: "Allow", kind: "allow_once" },
            { optionId: "n", name: "Deny", kind: "reject_once" },
          ],
        },
      },
      w.agentId,
    )
    // blocking send on a task waiting for input returns at input-required
    let state = ""
    for (let i = 0; i < 50 && state !== "input-required"; i++) {
      await Bun.sleep(50)
      state = ((await rpc("tasks/get", { id: task.id })).result as any).status.state
    }
    expect(state).toBe("input-required")
    const got = (await rpc("tasks/get", { id: task.id })).result as any
    expect(got.status.message.parts[0].text).toContain("make deploy")
    // anything else keeps it waiting
    const unclear = (await rpc("message/send", { message: userMsg("hmm", { taskId: task.id }) })).result as any
    expect(unclear.status.state).toBe("input-required")
    const done = (await rpc("message/send", { message: userMsg("allow", { taskId: task.id, contextId: task.contextId }) })).result as any
    expect(d.runtime.state.approvals.has("rq-a2a")).toBe(false)
    expect(done.status.state).toBe("completed")
    await d.runtime.kill(w.agentId)
  })

  test("tasks/cancel interrupts the busy team → canceled", async () => {
    const w = await d.runtime.spawn({ adapter: "mock", name: "slowpoke", options: { speed: 1, steps: ["read", "read", "read", "read", "read"] } })
    await d.runtime.promptAgent(w.agentId, "long job", { from: "user" })
    const r = await rpc("message/send", { message: userMsg("big job"), configuration: { blocking: false } })
    const task = r.result as any
    await Bun.sleep(400)
    expect(((await rpc("tasks/get", { id: task.id })).result as any).status.state).toBe("working")
    const c = (await rpc("tasks/cancel", { id: task.id })).result as any
    expect(c.status.state).toBe("canceled")
    // the mock stops at its next step boundary
    for (let i = 0; i < 60 && d.runtime.agents.get(w.agentId)?.busy; i++) await Bun.sleep(50)
    expect(d.runtime.agents.get(w.agentId)?.busy).toBe(false)
    const feed = d.runtime.state.feed(w.agentId).items
    expect(feed.some((it) => it.kind === "note" && it.text === "Interrupted")).toBe(true)
    await d.runtime.kill(w.agentId)
  })

  test("Baton talks to Baton: the a2a adapter drives this server end to end", async () => {
    const h = await startHarness(a2aAdapter, { cwd: d.runtime.projectRoot, options: { url: open.url } })
    try {
      await h.waitFor("agent.updated")
      expect(h.ofType("agent.updated")[0]?.data.model).toContain("Baton")
      await h.session.prompt({ text: "fix the typo in README" })
      await h.waitTurn(15_000)
      const said = (events: AgentEvent[]) =>
        events.filter((e): e is Extract<AgentEvent, { type: "message.completed" }> => e.type === "message.completed").map((e) => e.data.text)
      expect(said(h.events).join("\n")).toContain("splitting this up")
      // shown once even though it arrives as a status message, a final message and an artifact
      expect(said(h.events).filter((t) => t.includes("splitting this up")).length).toBe(1)
      expect(h.ofType("turn.completed").at(-1)?.data.stopReason).toBe("end_turn")
      const ctx = h.session.resumeId()
      expect(ctx).toBeTruthy()
      await h.session.prompt({ text: "and the changelog" })
      await h.waitTurn(15_000)
      expect(h.session.resumeId()).toBe(ctx)
      expect(h.ofType("turn.completed").length).toBe(2)
    } finally {
      await h.close()
    }
    expect(h.ofType("agent.exited").length).toBe(1)
  }, 30_000)

  test("the adapter's interrupt cancels the remote task (v0.3 dialect, non-streaming)", async () => {
    const w = await d.runtime.spawn({ adapter: "mock", name: "busybee", options: { speed: 1, steps: ["read", "read", "read", "read", "read"] } })
    await d.runtime.promptAgent(w.agentId, "long job", { from: "user" })
    const h = await startHarness(a2aAdapter, { cwd: d.runtime.projectRoot, options: { url: open.url, protocolVersion: "0.3", streaming: false } })
    try {
      await h.session.prompt({ text: "something slow" })
      await Bun.sleep(500)
      await h.session.interrupt()
      await h.waitFor("turn.interrupted", undefined, 5_000)
      const res = await fetch(`${open.url}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ListTasks", params: {} }),
      })
      const newest = ((await res.json()) as { result: { tasks: { status: { state: string } }[] } }).result.tasks[0]
      expect(newest?.status.state).toBe("TASK_STATE_CANCELED")
    } finally {
      await h.close()
      await d.runtime.kill(w.agentId)
    }
  }, 20_000)
})
