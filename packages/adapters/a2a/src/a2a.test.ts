import { afterAll, describe, expect, test } from "bun:test"
import type { AgentEvent } from "@batonsh/protocol"
import { startHarness } from "../../testkit/src/index.ts"
import { a2aAdapter, cardCandidates } from "./index.ts"
import { type Dialect, decodeMessage, decodeResult, encodeEvent, type Message, parseSse, type StreamEvent, type Task, type TaskState, textOf } from "./wire.ts"

// ───────────────────────────── a scripted fake A2A agent ─────────────────────────────

interface FakeOpts {
  dialect: Dialect
  streaming: boolean
  /** Serve the card only under the legacy v0.2 name. */
  legacyCard?: boolean
  token?: string
}

interface Fake {
  url: string
  requests: { method: string; params: Record<string, unknown>; headers: Headers }[]
  stop(): void
}

const enc = new TextEncoder()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeAgent(o: FakeOpts): Fake {
  const tasks = new Map<string, Task>()
  const cancelers = new Map<string, () => void>()
  const requests: Fake["requests"] = []
  const agentMsg = (text: string, t: Task): Message => ({
    kind: "message",
    messageId: crypto.randomUUID(),
    role: "agent",
    parts: [{ kind: "text", text }],
    taskId: t.id,
    contextId: t.contextId,
  })
  const status = (t: Task, state: TaskState, text?: string): StreamEvent => {
    t.status = { state, message: text ? agentMsg(text, t) : undefined, timestamp: new Date().toISOString() }
    return {
      kind: "status-update",
      taskId: t.id,
      contextId: t.contextId,
      status: t.status,
      final: ["completed", "failed", "canceled", "input-required"].includes(state),
    }
  }

  /** The script: what the agent does for a message, as a list of events (some delayed). */
  async function* script(msg: Message, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    const text = textOf(msg.parts)
    if (text === "direct") {
      yield {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: "pong" }],
        contextId: msg.contextId ?? "ctx-direct",
      }
      return
    }
    let t = msg.taskId ? tasks.get(msg.taskId) : undefined
    if (!t) {
      t = { kind: "task", id: crypto.randomUUID(), contextId: msg.contextId ?? crypto.randomUUID(), status: { state: "submitted" }, history: [], artifacts: [] }
      tasks.set(t.id, t)
    }
    t.history?.push({ ...msg, taskId: t.id, contextId: t.contextId })
    yield structuredClone(t)
    if (msg.taskId) {
      yield status(t, "completed", `Nice to meet you, ${text}`)
      return
    }
    switch (text) {
      case "hello": {
        yield status(t, "working", "Thinking…")
        const artifactId = "a1"
        yield {
          kind: "artifact-update",
          taskId: t.id,
          contextId: t.contextId,
          artifact: { artifactId, name: "answer", parts: [{ kind: "text", text: "Hel" }] },
          append: true,
        }
        yield {
          kind: "artifact-update",
          taskId: t.id,
          contextId: t.contextId,
          artifact: { artifactId, name: "answer", parts: [{ kind: "text", text: "lo world" }] },
          append: true,
          lastChunk: true,
        }
        t.artifacts = [{ artifactId, name: "answer", parts: [{ kind: "text", text: "Hello world" }] }]
        yield status(t, "completed")
        return
      }
      case "ask":
        yield status(t, "input-required", "What is your name?")
        return
      case "fail":
        yield status(t, "working")
        yield status(t, "failed", "boom")
        return
      case "files":
        t.artifacts = [
          {
            artifactId: "f",
            name: "report",
            parts: [
              { kind: "text", text: "see attached" },
              { kind: "file", file: { name: "r.txt", mimeType: "text/plain", uri: "https://example.com/r.txt" } },
              { kind: "data", data: { ok: true } },
            ],
          },
        ]
        yield structuredClone(t)
        yield status(t, "completed")
        return
      case "slow": {
        yield status(t, "working", "Working slowly")
        const id = t.id
        await new Promise<void>((resolve) => {
          cancelers.set(id, resolve)
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        yield status(t, "canceled")
        return
      }
      default:
        yield status(t, "completed", `echo: ${text}`)
    }
  }

  const card = (base: string) => {
    const rpc = `${base}/rpc`
    const common = {
      name: "Fake Agent",
      description: "scripted",
      version: "9.9.9",
      capabilities: { streaming: o.streaming },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "x", name: "x", description: "x", tags: [] }],
    }
    if (o.dialect === "1.0") {
      return {
        ...common,
        supportedInterfaces: [{ url: rpc, protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
        ...(o.token
          ? { securitySchemes: { b: { httpAuthSecurityScheme: { scheme: "Bearer" } } }, securityRequirements: [{ schemes: { b: { list: [] } } }] }
          : {}),
      }
    }
    return {
      ...common,
      protocolVersion: "0.3.0",
      url: rpc,
      preferredTransport: "JSONRPC",
      ...(o.token ? { securitySchemes: { b: { type: "http", scheme: "bearer" } }, security: [{ b: [] }] } : {}),
    }
  }

  const server: Bun.Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url)
      const base: string = `http://127.0.0.1:${server.port}`
      if (req.method === "GET") {
        const want = o.legacyCard ? "/.well-known/agent.json" : "/.well-known/agent-card.json"
        return url.pathname === want ? Response.json(card(base)) : new Response("nope", { status: 404 })
      }
      if (o.token && req.headers.get("authorization") !== `Bearer ${o.token}`) return new Response("unauthorized", { status: 401 })
      const body = (await req.json()) as { id: number; method: string; params: Record<string, unknown> }
      requests.push({ method: body.method, params: body.params, headers: req.headers })
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result })
      const wrap = (e: StreamEvent) => encodeEvent(e, o.dialect)
      const v1 = o.dialect === "1.0"
      const m = (
        (v1
          ? { SendMessage: "send", SendStreamingMessage: "stream", GetTask: "get", CancelTask: "cancel" }
          : { "message/send": "send", "message/stream": "stream", "tasks/get": "get", "tasks/cancel": "cancel" }) as Record<string, string>
      )[body.method]
      if (!m) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "method not found" } })
      if (m === "get") {
        const t = tasks.get(String(body.params.id))
        return t
          ? reply(v1 ? (wrap(t) as { task: unknown }).task : t)
          : Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "task not found" } })
      }
      if (m === "cancel") {
        const id = String(body.params.id)
        const t = tasks.get(id)
        if (!t) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32001, message: "task not found" } })
        cancelers.get(id)?.()
        t.status = { state: "canceled" }
        return reply(v1 ? (wrap(t) as { task: unknown }).task : t)
      }
      const msg = decodeMessage(body.params.message)
      if (!msg) return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "bad message" } })
      if (m === "send") {
        let last: StreamEvent | undefined
        const ac = new AbortController()
        for await (const e of script(msg, ac.signal)) last = e
        const final = last?.kind === "message" ? last : last && "taskId" in last ? tasks.get(last.taskId) : last
        return reply(wrap(final as StreamEvent))
      }
      // SSE, deliberately awkward: comments, multi-line data, CRLF, writes split mid-line
      const ac = new AbortController()
      req.signal.addEventListener("abort", () => ac.abort())
      const stream = new ReadableStream<Uint8Array>({
        async start(ctrl) {
          ctrl.enqueue(enc.encode(": hello from fake\n\n"))
          let i = 0
          for await (const e of script(msg, ac.signal)) {
            const payload = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: wrap(e) }, null, i % 2 ? 2 : 0)
            const nl = i % 3 === 0 ? "\r\n" : "\n"
            const frame = `event: message${nl}${payload
              .split("\n")
              .map((l) => `data: ${l}`)
              .join(nl)}${nl}${nl}`
            for (let k = 0; k < frame.length; k += 7) {
              ctrl.enqueue(enc.encode(frame.slice(k, k + 7)))
              if (k % 21 === 0) await sleep(0)
            }
            i++
          }
          ctrl.close()
        },
        cancel() {
          ac.abort()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) }
}

type Of<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>
const of = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) => events.filter((e) => e.type === type) as Of<T>[]
const said = (events: AgentEvent[]) =>
  of(events, "message.completed")
    .filter((e) => e.data.role === "assistant")
    .map((e) => e.data.text)

const fakes: Fake[] = []
const fake = (o: FakeOpts) => {
  const f = fakeAgent(o)
  fakes.push(f)
  return f
}
afterAll(() => {
  for (const f of fakes) f.stop()
})

const cwd = process.cwd()

describe("a2a adapter (client)", () => {
  test("detect + capabilities", async () => {
    const d = await a2aAdapter.detect()
    expect(d.installed).toBe(true)
    expect(d.protocols).toEqual(["a2a"])
    const c = a2aAdapter.capabilities()
    expect(c.steer).toBe(false)
    expect(c.interrupt).toBe(true)
    expect(c.resume).toBe(true)
  })

  test("card discovery candidates", () => {
    expect(cardCandidates("https://a.example/agents/x/")).toEqual([
      "https://a.example/agents/x/.well-known/agent-card.json",
      "https://a.example/.well-known/agent-card.json",
      "https://a.example/agents/x/.well-known/agent.json",
      "https://a.example/.well-known/agent.json",
    ])
    expect(cardCandidates("https://a.example/card.json")).toEqual(["https://a.example/card.json"])
  })

  test("no url → start fails with a hint", async () => {
    await expect(startHarness(a2aAdapter, { cwd })).rejects.toThrow(/options\.url/)
  })

  test("v0.3 streaming: legacy card path, awkward SSE, artifact chunks", async () => {
    const f = fake({ dialect: "0.3", streaming: true, legacyCard: true })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    try {
      await h.waitFor("agent.updated")
      expect(h.ofType("agent.updated")[0]?.data).toMatchObject({ model: "Fake Agent", version: "9.9.9" })
      await h.session.prompt({ text: "hello" })
      await h.waitTurn(10_000)
      expect(f.requests[0]?.method).toBe("message/stream")
      expect(f.requests[0]?.headers.get("a2a-version")).toBe("0.3")
      expect(said(h.events)).toEqual(["Thinking…", "Hello world"])
      expect(of(h.events, "message.delta").map((e) => e.data.text)).toContain("Hel")
      expect(of(h.events, "turn.completed").at(-1)?.data.stopReason).toBe("end_turn")
      expect(h.session.resumeId()).toBeTruthy()
    } finally {
      await h.close()
    }
  })

  test("v1.0 blocking: SendMessage, contextId kept across turns, direct Message replies", async () => {
    const f = fake({ dialect: "1.0", streaming: false })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    try {
      await h.session.prompt({ text: "hello" })
      await h.waitTurn(10_000)
      expect(f.requests[0]?.method).toBe("SendMessage")
      expect(f.requests[0]?.headers.get("a2a-version")).toBe("1.0")
      expect((f.requests[0]?.params.message as { role?: string } | undefined)?.role).toBe("ROLE_USER")
      expect(said(h.events)).toContain("Hello world")
      const ctx = h.session.resumeId()
      await h.session.prompt({ text: "direct" })
      await h.waitTurn(10_000)
      expect((f.requests[1]?.params.message as { contextId?: string } | undefined)?.contextId).toBe(ctx)
      expect(said(h.events).at(-1)).toBe("pong")
    } finally {
      await h.close()
    }
  })

  for (const dialect of ["0.3", "1.0"] as const)
    test(`input-required ends the turn with the question; the next prompt continues the task (${dialect})`, async () => {
      const f = fake({ dialect, streaming: true })
      const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
      try {
        await h.session.prompt({ text: "ask" })
        await h.waitTurn(10_000)
        expect(of(h.events, "turn.completed").at(-1)?.data.stopReason).toBe("input_required")
        expect(said(h.events).at(-1)).toBe("What is your name?")
        await h.session.prompt({ text: "Ada" })
        await h.waitTurn(10_000)
        const second = f.requests[1]?.params.message as { taskId?: string }
        expect(second.taskId).toBeTruthy()
        expect(said(h.events).at(-1)).toBe("Nice to meet you, Ada")
        expect(of(h.events, "turn.completed").at(-1)?.data.stopReason).toBe("end_turn")
      } finally {
        await h.close()
      }
    })

  test("interrupt → tasks/cancel → turn.interrupted", async () => {
    const f = fake({ dialect: "0.3", streaming: true })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    try {
      await h.session.prompt({ text: "slow" })
      await h.waitFor("message.completed", (e) => e.data.text === "Working slowly", 10_000)
      await h.session.interrupt()
      await h.waitFor("turn.interrupted", undefined, 5_000)
      expect(f.requests.some((r) => r.method === "tasks/cancel")).toBe(true)
      expect(of(h.events, "turn.completed").length).toBe(0)
      // the session is usable afterwards
      await h.session.prompt({ text: "again" })
      await h.waitFor("message.completed", (e) => e.data.text === "echo: again", 10_000)
    } finally {
      await h.close()
    }
  })

  test("failed task → error + turn.completed(error)", async () => {
    const f = fake({ dialect: "1.0", streaming: true })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    try {
      await h.session.prompt({ text: "fail" })
      await h.waitTurn(10_000)
      expect(of(h.events, "error")[0]?.data.message).toContain("boom")
      expect(of(h.events, "turn.completed").at(-1)?.data.stopReason).toBe("error")
    } finally {
      await h.close()
    }
  })

  test("file and data parts show as tool output", async () => {
    const f = fake({ dialect: "1.0", streaming: false })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    try {
      await h.session.prompt({ text: "files" })
      await h.waitTurn(10_000)
      expect(said(h.events)).toContain("see attached")
      const outputs = of(h.events, "tool.update").flatMap((e) => e.data.content ?? [])
      expect(outputs.some((c) => c.type === "text" && c.text.includes("https://example.com/r.txt"))).toBe(true)
      expect(outputs.some((c) => c.type === "text" && c.text.includes('"ok": true'))).toBe(true)
    } finally {
      await h.close()
    }
  })

  test("bearer token: sent when configured, a clear error when missing", async () => {
    const f = fake({ dialect: "0.3", streaming: false, token: "s3cret" })
    const ok = await startHarness(a2aAdapter, { cwd, options: { url: f.url, token: "s3cret" } })
    try {
      await ok.session.prompt({ text: "hi" })
      await ok.waitTurn(10_000)
      expect(said(ok.events)).toEqual(["echo: hi"])
    } finally {
      await ok.close()
    }
    const bad = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    try {
      await bad.session.prompt({ text: "hi" })
      await bad.waitTurn(10_000)
      expect(of(bad.events, "error")[0]?.data.message).toMatch(/401|not authorized/)
    } finally {
      await bad.close()
    }
  })

  test("close interrupts the running turn and emits agent.exited once", async () => {
    const f = fake({ dialect: "1.0", streaming: true })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    await h.session.prompt({ text: "slow" })
    await h.waitFor("message.completed", (e) => e.data.text === "Working slowly", 10_000)
    await h.session.close()
    await h.session.close()
    expect(of(h.events, "agent.exited").length).toBe(1)
    expect(of(h.events, "turn.interrupted").length).toBe(1)
    expect(f.requests.some((r) => r.method === "CancelTask")).toBe(true)
  })
})

describe("wire", () => {
  const sse = (chunks: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch))
        c.close()
      },
    })
  const collect = async (chunks: string[]) => {
    const out: string[] = []
    for await (const e of parseSse(sse(chunks))) out.push(e.data)
    return out
  }

  test("SSE parser: multi-line data, comments, CR/LF/CRLF across chunks, trailing event", async () => {
    expect(await collect(["﻿: comment\n", "data: a\r", "\ndata: b\r\n\r", "\n", "data:c\rid: 1\r\r", "event: x\ndata: last"])).toEqual(["a\nb", "c", "last"])
    expect(await collect(['data: {"x":\n', "data: 1}\n\n", "\n\n:ping\n\n"])).toEqual(['{"x":\n1}'])
  })

  test("decodes both dialects to the same model", () => {
    const v1 = decodeResult({
      statusUpdate: {
        taskId: "t",
        contextId: "c",
        status: { state: "TASK_STATE_INPUT_REQUIRED", message: { messageId: "m", role: "ROLE_AGENT", parts: [{ text: "?" }] } },
      },
    })
    expect(v1).toMatchObject({ kind: "status-update", final: true, status: { state: "input-required", message: { role: "agent" } } })
    const v03 = decodeResult({ kind: "status-update", taskId: "t", contextId: "c", status: { state: "working" }, final: false })
    expect(v03).toMatchObject({ kind: "status-update", final: false, status: { state: "working" } })
    const file = decodeResult({
      message: { messageId: "m", role: "ROLE_AGENT", parts: [{ url: "https://x/y.png", filename: "y.png", mediaType: "image/png" }] },
    })
    expect(file).toMatchObject({ kind: "message", parts: [{ kind: "file", file: { uri: "https://x/y.png", name: "y.png", mimeType: "image/png" } }] })
    const t: Task = {
      kind: "task",
      id: "t",
      contextId: "c",
      status: { state: "completed" },
      artifacts: [{ artifactId: "a", parts: [{ kind: "data", data: { n: 1 } }] }],
    }
    expect(decodeResult(encodeEvent(t, "1.0"))).toEqual(t)
  })
})
