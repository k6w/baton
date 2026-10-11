import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, BatonEvent } from "@batonsh/protocol"
import { a2aAdapter } from "../../adapters/a2a/src/index.ts"
import { parseSse, verifyCard } from "../../adapters/a2a/src/wire.ts"
import { startHarness } from "../../adapters/testkit/src/index.ts"
import { isPrivateAddress } from "./a2a-push.ts"
import { type A2AServer, asksQuestion, startA2AServer } from "./a2a-server.ts"
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
async function rpc(method: string, params: unknown, opts: { token?: string | null; version?: string; server?: A2AServer } = {}): Promise<Rpc> {
  const token = opts.token === undefined ? TOKEN : opts.token
  const res = await fetch(`${(opts.server ?? srv).url}/`, {
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
    expect(card.supportedInterfaces[1]).toEqual({ url: srv.url, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" })
    expect(card.capabilities).toEqual({ streaming: true, pushNotifications: true, extendedAgentCard: true })
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
    expect((await rpc("CreateTaskPushNotificationConfig", { taskId: "x", url: "https://example.com/x" })).error?.code).toBe(-32001)
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

// ───────────────────────────── helpers for the newer features ─────────────────────────────

async function rest(path: string, init: { method?: string; body?: unknown; token?: string | null; server?: A2AServer } = {}) {
  const token = init.token === undefined ? TOKEN : init.token
  const res = await fetch(`${(init.server ?? srv).url}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/a2a+json", "A2A-Version": "1.0", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const text = await res.text()
  return { status: res.status, type: res.headers.get("content-type") ?? "", json: (text ? JSON.parse(text) : {}) as any }
}

const reason = (j: any) => j?.error?.details?.find((d: { reason?: string }) => d.reason)?.reason

/** Replace the lead's prompt handling with a script that emits the lead's events directly. */
function scriptLead(handler: (text: string, emit: (ev: AgentEvent) => void, turnId: string) => Promise<void> | void): () => void {
  const lead = d.runtime.orchestrator()!
  const session = lead.session!
  const orig = session.prompt
  let n = 0
  session.prompt = async (input) => {
    const turnId = `scripted-${++n}`
    queueMicrotask(() => void handler(input.text, (ev) => void d.runtime.emit(ev, lead.info.agentId), turnId))
  }
  return () => {
    session.prompt = orig
  }
}

const say = (emit: (ev: AgentEvent) => void, turnId: string, prompt: string, text: string) => {
  emit({ type: "turn.started", data: { turnId, prompt } })
  emit({ type: "message.completed", data: { messageId: `${turnId}-m`, role: "assistant", text } })
  emit({ type: "turn.completed", data: { turnId, stopReason: "end_turn" } })
}

async function waitState(id: string, want: string, server?: A2AServer): Promise<any> {
  let t: any
  for (let i = 0; i < 100; i++) {
    t = (await rpc("GetTask", { id }, { version: "1.0", server, token: server === open || server === pushy ? null : undefined })).result
    if (t?.status?.state === want) return t
    await Bun.sleep(50)
  }
  return t
}

let pushy: A2AServer
const hooks: { headers: Headers; body: any }[] = []
let hookFailures = 0
let hook: ReturnType<typeof Bun.serve>

describe("A2A server: REST binding, signed card, push, persistence, attribution", () => {
  beforeAll(async () => {
    await d.runtime.ensureOrchestrator()
    pushy = startA2AServer(d.runtime, { idleMs: 300, allowPrivatePush: true, push: { baseDelayMs: 20, attempts: 4 } })
    hook = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        // the first delivery fails: the server must retry
        if (hookFailures++ === 0) return new Response("busy", { status: 503 })
        hooks.push({ headers: req.headers, body: await req.json() })
        return new Response(null, { status: 204 })
      },
    })
  })
  afterAll(() => {
    pushy?.stop()
    hook?.stop(true)
  })

  test("the card is signed (EdDSA, kid, jku) and verifies against /.well-known/jwks.json", async () => {
    const card = (await (await fetch(`${srv.url}/.well-known/agent-card.json`)).json()) as Record<string, any>
    expect(card.signatures.length).toBe(1)
    const header = JSON.parse(Buffer.from(card.signatures[0].protected, "base64url").toString())
    expect(header).toMatchObject({ alg: "EdDSA", typ: "JOSE", jku: `${srv.url}/.well-known/jwks.json` })
    const jwks = (await (await fetch(header.jku)).json()) as { keys: { kid: string; kty: string; crv: string }[] }
    expect(jwks.keys[0]).toMatchObject({ kid: header.kid, kty: "OKP", crv: "Ed25519" })
    expect((await verifyCard(card, { fetchJwks: async (u) => (await fetch(u)).json() })).status).toBe("valid")
    expect((await verifyCard({ ...card, name: "evil" }, { fetchJwks: async (u) => (await fetch(u)).json() })).status).toBe("invalid")
  })

  test("REST: send, get, list, cancel, subscribe, errors (google.rpc.Status + ErrorInfo)", async () => {
    expect((await rest("/tasks", { token: null })).status).toBe(401)
    const sent = await rest("/message:send", { body: { message: userMsgV1("rest hello") } })
    expect(sent.status).toBe(200)
    expect(sent.type).toContain("application/a2a+json")
    const task = sent.json.task
    expect(task.status.state).toBe("TASK_STATE_COMPLETED")
    expect(task.artifacts.find((a: { artifactId: string }) => a.artifactId === "response")).toBeTruthy()
    const got = await rest(`/tasks/${task.id}?historyLength=1`)
    expect(got.json.id).toBe(task.id)
    expect(got.json.history.length).toBe(1)
    expect((await rest(`/v1/tasks/${task.id}`)).json.id).toBe(task.id)
    const listed = await rest(`/tasks?contextId=${task.contextId}&pageSize=5`)
    expect(listed.json.tasks.map((t: { id: string }) => t.id)).toEqual([task.id])
    const cancel = await rest(`/tasks/${task.id}:cancel`, { body: {} })
    expect(cancel.status).toBe(400)
    expect(reason(cancel.json)).toBe("TASK_NOT_CANCELABLE")
    const missing = await rest("/tasks/nope")
    expect(missing.status).toBe(404)
    expect(missing.json.error.status).toBe("NOT_FOUND")
    expect(reason(missing.json)).toBe("TASK_NOT_FOUND")
    expect(reason((await rest(`/tasks/${task.id}:subscribe`)).json)).toBe("UNSUPPORTED_OPERATION")
    expect((await rest("/tasks", { method: "DELETE" })).status).toBe(405)
    expect(reason((await rest("/message:send", { body: { message: { parts: [] } } })).json)).toBe("CONTENT_TYPE_NOT_SUPPORTED")
  })

  test("REST: message:stream is SSE of StreamResponse objects", async () => {
    const res = await fetch(`${srv.url}/message:stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/a2a+json", accept: "text/event-stream" },
      body: JSON.stringify({ message: userMsgV1("stream over rest") }),
    })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const events: any[] = []
    for await (const e of parseSse(res.body!)) events.push(JSON.parse(e.data))
    expect(Object.keys(events[0])).toEqual(["task"])
    expect(events.at(-1).statusUpdate.status.state).toBe("TASK_STATE_COMPLETED")
    expect(events.every((e) => !("jsonrpc" in e))).toBe(true)
  })

  test("extended card: authenticated, lists the team; unsupported without a token", async () => {
    const ext = (await rpc("GetExtendedAgentCard", {}, { version: "1.0" })).result as any
    expect(ext.skills.some((s: { id: string }) => s.id.startsWith("agent:"))).toBe(true)
    expect(ext.signatures.length).toBe(1)
    expect((await rest("/extendedAgentCard")).json.name).toContain("Baton")
    expect(reason((await rest("/extendedAgentCard", { server: open, token: null })).json)).toBe("UNSUPPORTED_OPERATION")
  })

  test("Baton → Baton over REST with requireSignedCard", async () => {
    const h = await startHarness(a2aAdapter, { cwd: d.runtime.projectRoot, options: { url: open.url, transport: "rest", requireSignedCard: true } })
    try {
      await h.session.prompt({ text: "over rest" })
      await h.waitTurn(15_000)
      expect(h.ofType("turn.completed").at(-1)?.data.stopReason).toBe("end_turn")
      expect(h.ofType("message.completed").some((e) => e.data.text.includes("splitting this up"))).toBe(true)
    } finally {
      await h.close()
    }
  }, 20_000)

  test("push: SSRF guard refuses loopback / private / local targets", async () => {
    const t = ((await rpc("SendMessage", { message: userMsgV1("quick") }, { version: "1.0" })).result as any).task
    for (const url of [
      "http://127.0.0.1:9/hook",
      "http://10.0.0.5/x",
      "http://localhost:8080/x",
      "http://[::1]/x",
      "http://169.254.169.254/latest",
      "file:///etc/passwd",
    ]) {
      const r = await rpc("CreateTaskPushNotificationConfig", { taskId: t.id, url }, { version: "1.0" })
      expect(r.error?.code).toBe(-32602)
    }
    expect((await rest(`/tasks/${t.id}/pushNotificationConfigs`, { body: { url: "http://192.168.1.10/x" } })).status).toBe(400)
    const inline = await rpc(
      "SendMessage",
      { message: userMsgV1("with hook"), configuration: { taskPushNotificationConfig: { url: "http://127.0.0.1:1/x" } } },
      { version: "1.0" },
    )
    expect(inline.error?.code).toBe(-32602)
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.1",
      "192.168.0.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "::ffff:127.0.0.1",
      "fd00::1",
      "fe80::1",
    ])
      expect(isPrivateAddress(ip)).toBe(true)
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip)).toBe(false)
  })

  test("push: webhooks get StreamResponse (v1.0) / Task (v0.3) payloads with auth headers, retried after a 5xx", async () => {
    const hookUrl = `http://127.0.0.1:${hook.port}/a2a`
    const r = await rpc(
      "SendMessage",
      {
        message: userMsgV1("notify me"),
        configuration: {
          returnImmediately: true,
          taskPushNotificationConfig: { url: hookUrl, token: "tk-1", authentication: { scheme: "Bearer", credentials: "cred-1" } },
        },
      },
      { version: "1.0", server: pushy, token: null },
    )
    const task = (r.result as any).task
    await waitState(task.id, "TASK_STATE_COMPLETED", pushy)
    await pushy.push.idle()
    const mine = hooks.filter((h) => JSON.stringify(h.body).includes(task.id))
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((h) => h.headers.get("authorization") === "Bearer cred-1" && h.headers.get("x-a2a-notification-token") === "tk-1")).toBe(true)
    expect(mine[0]!.headers.get("content-type")).toContain("application/a2a+json")
    expect(mine.some((h) => h.body.statusUpdate?.status.state === "TASK_STATE_COMPLETED")).toBe(true)
    expect(mine.some((h) => h.body.artifactUpdate?.artifact.artifactId === "response")).toBe(true)
    expect(hookFailures).toBeGreaterThan(mine.length) // the 503 was retried
    // v0.3: the task snapshot on status changes
    const legacy = (
      (await rpc(
        "message/send",
        { message: userMsg("notify me, legacy"), configuration: { blocking: true, pushNotificationConfig: { url: hookUrl, token: "tk-2" } } },
        { server: pushy, token: null },
      )) as any
    ).result
    expect(legacy.status.state).toBe("completed")
    await pushy.push.idle()
    const old = hooks.filter((h) => h.body.kind === "task" && h.body.id === legacy.id)
    expect(old.at(-1)?.body.status.state).toBe("completed")
    expect(old.at(-1)?.headers.get("x-a2a-notification-token")).toBe("tk-2")
  })

  test("push config CRUD over JSON-RPC (v1.0 + v0.3) and REST", async () => {
    const task = ((await rpc("SendMessage", { message: userMsgV1("crud") }, { version: "1.0", server: pushy, token: null })).result as any).task
    const url = `http://127.0.0.1:${hook.port}/x`
    const created = (await rpc("CreateTaskPushNotificationConfig", { taskId: task.id, url, token: "a" }, { version: "1.0", server: pushy, token: null }))
      .result as any
    expect(created).toMatchObject({ taskId: task.id, url, token: "a" })
    expect(created.id).toBeTruthy()
    const got = (await rpc("GetTaskPushNotificationConfig", { taskId: task.id, id: created.id }, { version: "1.0", server: pushy, token: null })).result as any
    expect(got.url).toBe(url)
    const legacy = (
      await rpc("tasks/pushNotificationConfig/set", { taskId: task.id, pushNotificationConfig: { url, id: "legacy-1" } }, { server: pushy, token: null })
    ).result as any
    expect(legacy).toEqual({ taskId: task.id, pushNotificationConfig: { id: "legacy-1", url } })
    expect(((await rpc("tasks/pushNotificationConfig/list", { id: task.id }, { server: pushy, token: null })).result as unknown as unknown[]).length).toBe(2)
    const viaRest = await rest(`/tasks/${task.id}/pushNotificationConfigs`, { server: pushy, token: null, body: { url } })
    expect(viaRest.json.taskId).toBe(task.id)
    expect((await rest(`/tasks/${task.id}/pushNotificationConfigs`, { server: pushy, token: null })).json.configs.length).toBe(3)
    expect((await rest(`/tasks/${task.id}/pushNotificationConfigs/${viaRest.json.id}`, { server: pushy, token: null, method: "DELETE" })).status).toBe(200)
    expect((await rpc("DeleteTaskPushNotificationConfig", { taskId: task.id, id: created.id }, { version: "1.0", server: pushy, token: null })).result).toEqual(
      {},
    )
    expect(
      (await rpc("tasks/pushNotificationConfig/delete", { id: task.id, pushNotificationConfigId: "legacy-1" }, { server: pushy, token: null })).result,
    ).toBeNull()
    const list = (await rpc("ListTaskPushNotificationConfigs", { taskId: task.id }, { version: "1.0", server: pushy, token: null })).result as any
    expect(list).toEqual({ configs: [], nextPageToken: "" })
    expect((await rpc("GetTaskPushNotificationConfig", { taskId: task.id, id: created.id }, { version: "1.0", server: pushy, token: null })).error?.code).toBe(
      -32001,
    )
  })

  test("a final question from the lead (nothing changed) → input-required; the answer continues the task", async () => {
    expect(asksQuestion("Plan ready.\nShould I use Postgres or SQLite?")).toBe(true)
    expect(asksQuestion("**Which one?**")).toBe(true)
    expect(asksQuestion("Done? Yes, all done.")).toBe(false)
    const restore = scriptLead((text, emit, id) =>
      say(emit, id, text, text.includes("SQLite") ? "Done — wired up SQLite." : "I can set this up. Should I use Postgres or SQLite?"),
    )
    try {
      const r = (await rpc("SendMessage", { message: userMsgV1("set up the database") }, { version: "1.0" })).result as any
      expect(r.task.status.state).toBe("TASK_STATE_INPUT_REQUIRED")
      expect(r.task.status.message.parts[0].text).toContain("Postgres or SQLite?")
      expect(r.task.artifacts ?? []).toEqual([])
      // waiting on the requester doesn't hold the team: another task runs meanwhile
      const other = (await rpc("SendMessage", { message: userMsgV1("unrelated, quick: ping") }, { version: "1.0" })).result as any
      expect(other.task.status.state).toBe("TASK_STATE_INPUT_REQUIRED") // the scripted lead asks again
      const done = (await rpc("SendMessage", { message: userMsgV1("SQLite please", { taskId: r.task.id }) }, { version: "1.0" })).result as any
      expect(done.task.id).toBe(r.task.id)
      expect(done.task.status.state).toBe("TASK_STATE_COMPLETED")
      expect(done.task.status.message.parts[0].text).toBe("Done — wired up SQLite.")
      await rpc("CancelTask", { id: other.task.id }, { version: "1.0" })
    } finally {
      restore()
    }
  })

  test("only the lead's turns started by the task (or carrying its delegated results) belong to it", async () => {
    const lead = d.runtime.orchestrator()!.info.agentId
    const restore = scriptLead(async (text, emit, id) => {
      // a human's TUI turn and an unrelated worker result run first
      say(emit, `${id}-h`, "what's for lunch?", "HUMAN-ONLY ANSWER")
      say(emit, `${id}-r`, "[baton] Result from someone:\nunrelated", "UNRELATED RESULT")
      // the task's own turn delegates, then the result comes back
      emit({ type: "turn.started", data: { turnId: id, prompt: text } })
      emit({
        type: "bus.message",
        data: { messageId: `${id}-bus`, from: lead, to: "helper", kind: "request", body: "check the tests", delivery: "queue", priority: "normal" },
      })
      emit({ type: "message.completed", data: { messageId: `${id}-m1`, role: "assistant", text: "Delegated to helper." } })
      emit({ type: "turn.completed", data: { turnId: id, stopReason: "end_turn" } })
      await Bun.sleep(80)
      say(emit, `${id}-back`, "[baton] Result from helper:\nall green", "Helper reports all tests green.")
    })
    try {
      const r = (await rpc("SendMessage", { message: userMsgV1("check the tests via a helper") }, { version: "1.0" })).result as any
      expect(r.task.status.state).toBe("TASK_STATE_COMPLETED")
      expect(r.task.status.message.parts[0].text).toBe("Helper reports all tests green.")
      const all = JSON.stringify(r.task)
      expect(all).toContain("Delegated to helper.")
      expect(all).not.toContain("HUMAN-ONLY ANSWER")
      expect(all).not.toContain("UNRELATED RESULT")
    } finally {
      restore()
    }
  })

  test("cancel denies the team's pending approvals", async () => {
    const w = await d.runtime.spawn({ adapter: "mock", name: "asker", options: { speed: 0 } })
    const seen: BatonEvent[] = []
    const off = d.runtime.store.subscribe((e) => {
      if (e.type === "permission.resolved") seen.push(e)
    })
    try {
      const task = ((await rpc("SendMessage", { message: userMsgV1("ship it"), configuration: { returnImmediately: true } }, { version: "1.0" })).result as any)
        .task
      d.runtime.emit(
        {
          type: "permission.requested",
          data: {
            requestId: "rq-cancel",
            title: "Bash(make release)",
            kind: "execute",
            options: [
              { optionId: "y", name: "Allow", kind: "allow_once" },
              { optionId: "n", name: "Deny", kind: "reject_once" },
            ],
          },
        },
        w.agentId,
      )
      expect((await waitState(task.id, "TASK_STATE_INPUT_REQUIRED")).status.state).toBe("TASK_STATE_INPUT_REQUIRED")
      const c = (await rpc("CancelTask", { id: task.id }, { version: "1.0" })).result as any
      expect(c.status.state).toBe("TASK_STATE_CANCELED")
      expect(d.runtime.state.approvals.has("rq-cancel")).toBe(false)
      const res = seen.find((e) => e.type === "permission.resolved" && e.data.requestId === "rq-cancel") as Extract<BatonEvent, { type: "permission.resolved" }>
      expect(res.data).toMatchObject({ optionId: "n", by: "cancelled" })
    } finally {
      off()
      await d.runtime.kill(w.agentId)
    }
  })

  test("tasks persist across restarts; a task that was running comes back failed", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "baton-a2a-store-")), "tasks.json")
    const p1 = startA2AServer(d.runtime, { idleMs: 300, persist: file, persistDebounceMs: 20 })
    const w = await d.runtime.spawn({ adapter: "mock", name: "longrunner", options: { speed: 1, steps: ["read", "read", "read", "read", "read"] } })
    try {
      const done = ((await rpc("SendMessage", { message: userMsgV1("persist me") }, { version: "1.0", server: p1, token: null })).result as any).task
      expect(done.status.state).toBe("TASK_STATE_COMPLETED")
      await d.runtime.promptAgent(w.agentId, "long job", { from: "user" })
      const running = (
        (
          await rpc(
            "SendMessage",
            { message: userMsgV1("still running"), configuration: { returnImmediately: true } },
            { version: "1.0", server: p1, token: null },
          )
        ).result as any
      ).task
      expect((await waitState(running.id, "TASK_STATE_WORKING", p1)).status.state).toBe("TASK_STATE_WORKING")
      p1.stop()
      // POSIX permissions (Windows protects the profile folder with ACLs instead)
      if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
      const p2 = startA2AServer(d.runtime, { idleMs: 300, persist: file })
      try {
        const again = (await rpc("GetTask", { id: done.id }, { version: "1.0", server: p2, token: null })).result as any
        expect(again.status.state).toBe("TASK_STATE_COMPLETED")
        expect(again.contextId).toBe(done.contextId)
        expect(again.artifacts.find((a: { artifactId: string }) => a.artifactId === "response")).toBeTruthy()
        expect(again.history[0].parts[0].text).toBe("persist me")
        const failed = (await rpc("GetTask", { id: running.id }, { version: "1.0", server: p2, token: null })).result as any
        expect(failed.status.state).toBe("TASK_STATE_FAILED")
        expect(failed.status.message.parts[0].text).toContain("restarted")
        // the same context continues with a new task
        const next = (
          (await rpc("SendMessage", { message: userMsgV1("pick it up", { contextId: running.contextId }) }, { version: "1.0", server: p2, token: null }))
            .result as any
        ).task
        expect(next.contextId).toBe(running.contextId)
      } finally {
        p2.stop()
      }
    } finally {
      await d.runtime.kill(w.agentId)
    }
  }, 20_000)
})
