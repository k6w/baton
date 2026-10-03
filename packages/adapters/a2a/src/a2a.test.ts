import { afterAll, describe, expect, test } from "bun:test"
import { generateKeyPairSync, type KeyObject } from "node:crypto"
import type { AgentEvent } from "@batonsh/protocol"
import { startHarness } from "../../testkit/src/index.ts"
import { a2aAdapter, cardCandidates, isConfirmation } from "./index.ts"
import {
  canonicalize,
  type Dialect,
  decodeMessage,
  decodePushConfig,
  decodeResult,
  encodeEvent,
  encodePushConfig,
  type Message,
  parseSse,
  publicJwk,
  readCard,
  restError,
  type StreamEvent,
  signCard,
  type Task,
  type TaskState,
  textOf,
  verifyCard,
} from "./wire.ts"

// ───────────────────────────── a scripted fake A2A agent ─────────────────────────────

type FakeAuth =
  | { kind: "apiKey"; location: "header" | "query" | "cookie"; name: string; key: string; v1?: boolean }
  | { kind: "oauth2"; clientId: string; clientSecret: string; oidc?: boolean; ttl?: number }

interface FakeOpts {
  dialect: Dialect
  streaming: boolean
  /** Serve the card only under the legacy v0.2 name. */
  legacyCard?: boolean
  token?: string
  auth?: FakeAuth
  /** Card signature: valid, valid-then-modified, or none. */
  sign?: "valid" | "tampered"
  push?: boolean
  /** Answer resubscribe with an error (→ the client falls back to polling). */
  noResubscribe?: boolean
  /** Refuse messages on a task that is still working. */
  rejectFollowUps?: boolean
}

interface Fake {
  url: string
  requests: { method: string; params: Record<string, unknown>; headers: Headers; url: string }[]
  tokenRequests: { auth: string | null; body: string }[]
  key: KeyObject
  /** Invalidate every issued OAuth token (the next call gets a 401). */
  revoke(): void
  stop(): void
}

const DROP = Symbol("drop")
type Scripted = StreamEvent | typeof DROP

const enc = new TextEncoder()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function fakeAgent(o: FakeOpts): Fake {
  const tasks = new Map<string, Task>()
  const cancelers = new Map<string, () => void>()
  /** Every event per task (resubscribe replays what came after its snapshot). */
  const logs = new Map<string, { events: StreamEvent[]; wake: Set<() => void> }>()
  const requests: Fake["requests"] = []
  const tokenRequests: Fake["tokenRequests"] = []
  const { privateKey: key } = generateKeyPairSync("ed25519")
  let tokens = new Set<string>()
  let issued = 0
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
  const record = (taskId: string, e: StreamEvent) => {
    const l = logs.get(taskId) ?? { events: [], wake: new Set<() => void>() }
    logs.set(taskId, l)
    l.events.push(e)
    for (const w of [...l.wake]) w()
  }

  /** The script: what the agent does for a message, as a list of events (some delayed). */
  async function* script(msg: Message, signal: AbortSignal): AsyncGenerator<Scripted> {
    const text = textOf(msg.parts.filter((p) => !(p.metadata?.baton as { kind?: string } | undefined)?.kind))
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
      case "hello":
      case "drop": {
        yield status(t, "working", "Thinking…")
        const artifactId = "a1"
        t.artifacts = [{ artifactId, name: "answer", parts: [{ kind: "text", text: "Hel" }] }]
        yield {
          kind: "artifact-update",
          taskId: t.id,
          contextId: t.contextId,
          artifact: { artifactId, name: "answer", parts: [{ kind: "text", text: "Hel" }] },
          append: true,
        }
        if (text === "drop") {
          yield DROP
          await sleep(250)
        }
        t.artifacts = [{ artifactId, name: "answer", parts: [{ kind: "text", text: "Hello world" }] }]
        yield {
          kind: "artifact-update",
          taskId: t.id,
          contextId: t.contextId,
          artifact: { artifactId, name: "answer", parts: [{ kind: "text", text: "lo world" }] },
          append: true,
          lastChunk: true,
        }
        yield status(t, "completed")
        return
      }
      case "ask":
        yield status(t, "input-required", "What is your name?")
        return
      case "deploy":
        yield status(t, "input-required", "Do you approve deploying to production? (yes/no)")
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
        if (t.status.state !== "completed") yield status(t, "canceled")
        return
      }
      default:
        yield status(t, "completed", `echo: ${text}`)
    }
  }

  const security = (): Record<string, unknown> => {
    const a = o.auth
    if (o.token) {
      return o.dialect === "1.0"
        ? { securitySchemes: { b: { httpAuthSecurityScheme: { scheme: "Bearer" } } }, securityRequirements: [{ schemes: { b: { list: [] } } }] }
        : { securitySchemes: { b: { type: "http", scheme: "bearer" } }, security: [{ b: [] }] }
    }
    if (!a) return {}
    const base = `http://127.0.0.1:${server.port}`
    if (a.kind === "apiKey") {
      return a.v1
        ? {
            securitySchemes: { k: { apiKeySecurityScheme: { location: a.location, name: a.name } } },
            securityRequirements: [{ schemes: { k: { list: [] } } }],
          }
        : { securitySchemes: { k: { type: "apiKey", in: a.location, name: a.name } }, security: [{ k: [] }] }
    }
    if (a.oidc)
      return {
        securitySchemes: { oidc: { openIdConnectSecurityScheme: { openIdConnectUrl: `${base}/.well-known/openid-configuration` } } },
        securityRequirements: [{ schemes: { oidc: { list: ["a2a"] } } }],
      }
    return {
      securitySchemes: {
        // an unusable scheme first: the client must pick the one it has credentials for
        mtls: { mtlsSecurityScheme: {} },
        oauth: { oauth2SecurityScheme: { flows: { clientCredentials: { tokenUrl: `${base}/token`, scopes: { "a2a:write": "send tasks" } } } } },
      },
      securityRequirements: [{ schemes: { mtls: { list: [] } } }, { schemes: { oauth: { list: ["a2a:write"] } } }],
    }
  }

  const card = (base: string) => {
    const rpc = `${base}/rpc`
    const common = {
      name: "Fake Agent",
      description: "scripted",
      version: "9.9.9",
      capabilities: { streaming: o.streaming, ...(o.push ? { pushNotifications: true } : {}) },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [{ id: "x", name: "x", description: "x", tags: [] }],
      ...security(),
    }
    const c: Record<string, unknown> =
      o.dialect === "1.0"
        ? { ...common, supportedInterfaces: [{ url: rpc, protocolBinding: "JSONRPC", protocolVersion: "1.0" }] }
        : { ...common, protocolVersion: "0.3.0", url: rpc, preferredTransport: "JSONRPC" }
    if (!o.sign) return c
    const signed = signCard(c, key, { jku: `${base}/.well-known/jwks.json` })
    return o.sign === "tampered" ? { ...signed, name: "Evil Agent" } : signed
  }

  const authorized = (req: Request, url: URL): boolean => {
    if (o.token) return req.headers.get("authorization") === `Bearer ${o.token}`
    const a = o.auth
    if (!a) return true
    if (a.kind === "apiKey") {
      if (a.location === "header") return req.headers.get(a.name) === a.key
      if (a.location === "query") return url.searchParams.get(a.name) === a.key
      return (req.headers.get("cookie") ?? "").split(/;\s*/).includes(`${a.name}=${a.key}`)
    }
    const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")
    return !!m && tokens.has(m[1] as string)
  }

  const sse = (events: AsyncIterable<Scripted>, id: number, wrap: (e: StreamEvent) => unknown, onEnd: () => void, signal: AbortSignal) =>
    new ReadableStream<Uint8Array>({
      // deliberately awkward framing: comments, multi-line data, CRLF, writes split mid-line
      async start(ctrl) {
        ctrl.enqueue(enc.encode(": hello from fake\n\n"))
        let i = 0
        let open = true
        signal.addEventListener("abort", () => (open = false), { once: true })
        for await (const e of events) {
          if (e === DROP) {
            // the connection dies; the task carries on
            open = false
            try {
              ctrl.close()
            } catch {}
            continue
          }
          if (!open) continue
          const payload = JSON.stringify({ jsonrpc: "2.0", id, result: wrap(e) }, null, i % 2 ? 2 : 0)
          const nl = i % 3 === 0 ? "\r\n" : "\n"
          const frame = `event: message${nl}${payload
            .split("\n")
            .map((l) => `data: ${l}`)
            .join(nl)}${nl}${nl}`
          for (let k = 0; k < frame.length && open; k += 7) {
            try {
              ctrl.enqueue(enc.encode(frame.slice(k, k + 7)))
            } catch {
              open = false
            }
            if (k % 21 === 0) await sleep(0)
          }
          i++
        }
        onEnd()
        if (open)
          try {
            ctrl.close()
          } catch {}
      },
    })

  async function* recorded(gen: AsyncGenerator<Scripted>): AsyncGenerator<Scripted> {
    for await (const e of gen) {
      if (e !== DROP) record(e.kind === "task" ? e.id : e.kind === "message" ? (e.taskId ?? "") : e.taskId, e)
      yield e
    }
  }

  async function* replay(t: Task): AsyncGenerator<Scripted> {
    const l = logs.get(t.id) ?? { events: [], wake: new Set<() => void>() }
    logs.set(t.id, l)
    let i = l.events.length
    yield structuredClone(t)
    while (true) {
      while (i < l.events.length) {
        const e = l.events[i++] as StreamEvent
        yield e
        if (e.kind === "status-update" && e.final) return
      }
      if (["completed", "failed", "canceled"].includes(t.status.state)) return
      await new Promise<void>((r) => {
        const w = () => {
          l.wake.delete(w)
          r()
        }
        l.wake.add(w)
      })
    }
  }

  const server: Bun.Server<undefined> = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 30,
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url)
      const base: string = `http://127.0.0.1:${server.port}`
      if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [publicJwk(key)] })
      if (url.pathname === "/.well-known/openid-configuration") return Response.json({ issuer: base, token_endpoint: `${base}/token` })
      if (url.pathname === "/token" && req.method === "POST") {
        const body = await req.text()
        tokenRequests.push({ auth: req.headers.get("authorization"), body })
        const a = o.auth
        const ok =
          a?.kind === "oauth2" &&
          req.headers.get("authorization") === `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64")}` &&
          new URLSearchParams(body).get("grant_type") === "client_credentials"
        if (!ok) return Response.json({ error: "invalid_client" }, { status: 401 })
        const tok = `tok-${++issued}`
        tokens.add(tok)
        return Response.json({ access_token: tok, token_type: "Bearer", expires_in: a.ttl ?? 3600 })
      }
      if (req.method === "GET") {
        const want = o.legacyCard ? "/.well-known/agent.json" : "/.well-known/agent-card.json"
        return url.pathname === want ? Response.json(card(base)) : new Response("nope", { status: 404 })
      }
      if (!authorized(req, url)) return new Response("unauthorized", { status: 401 })
      const body = (await req.json()) as { id: number; method: string; params: Record<string, unknown> }
      requests.push({ method: body.method, params: body.params, headers: req.headers, url: req.url })
      const reply = (result: unknown) => Response.json({ jsonrpc: "2.0", id: body.id, result })
      const fail = (code: number, message: string) => Response.json({ jsonrpc: "2.0", id: body.id, error: { code, message } })
      const wrap = (e: StreamEvent) => encodeEvent(e, o.dialect)
      const v1 = o.dialect === "1.0"
      const m = (
        (v1
          ? { SendMessage: "send", SendStreamingMessage: "stream", GetTask: "get", CancelTask: "cancel", SubscribeToTask: "subscribe" }
          : { "message/send": "send", "message/stream": "stream", "tasks/get": "get", "tasks/cancel": "cancel", "tasks/resubscribe": "subscribe" }) as Record<
          string,
          string
        >
      )[body.method]
      if (!m) return fail(-32601, "method not found")
      if (m === "get" || m === "subscribe") {
        const t = tasks.get(String(body.params.id))
        if (!t) return fail(-32001, "task not found")
        if (m === "get") return reply(v1 ? (wrap(t) as { task: unknown }).task : t)
        if (o.noResubscribe) return fail(-32004, "resubscribe not supported")
        return new Response(
          sse(replay(t), body.id, wrap, () => {}, req.signal),
          { headers: { "content-type": "text/event-stream" } },
        )
      }
      if (m === "cancel") {
        const id = String(body.params.id)
        const t = tasks.get(id)
        if (!t) return fail(-32001, "task not found")
        t.status = { state: "canceled" }
        cancelers.get(id)?.()
        return reply(v1 ? (wrap(t) as { task: unknown }).task : t)
      }
      const msg = decodeMessage(body.params.message)
      if (!msg) return fail(-32602, "bad message")
      const prior = msg.taskId ? tasks.get(msg.taskId) : undefined
      if (prior && prior.status.state === "working") {
        if (o.rejectFollowUps) return fail(-32004, "task is busy")
        cancelers.get(prior.id)?.()
      }
      const ac = new AbortController()
      if (m === "send") {
        let last: StreamEvent | undefined
        for await (const e of recorded(script(msg, ac.signal))) if (e !== DROP) last = e
        const final = last?.kind === "message" ? last : last && "taskId" in last ? tasks.get(last.taskId) : last
        return reply(wrap(final as StreamEvent))
      }
      return new Response(
        sse(recorded(script(msg, ac.signal)), body.id, wrap, () => {}, req.signal),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    tokenRequests,
    key,
    revoke: () => {
      tokens = new Set()
    },
    stop: () => server.stop(true),
  }
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
    expect(c.steer).toBe(true)
    expect(c.permissions).toBe(true)
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

describe("a2a adapter: reconnect, steering, permissions, context, push", () => {
  for (const dialect of ["0.3", "1.0"] as const)
    test(`a dropped stream is resumed with resubscribe, without duplicate text (${dialect})`, async () => {
      const f = fake({ dialect, streaming: true })
      const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url, reconnectDelayMs: 20 } })
      try {
        await h.session.prompt({ text: "drop" })
        await h.waitTurn(10_000)
        expect(f.requests.map((r) => r.method)).toContain(dialect === "1.0" ? "SubscribeToTask" : "tasks/resubscribe")
        expect(said(h.events)).toEqual(["Thinking…", "Hello world"])
        expect(
          of(h.events, "message.delta")
            .filter((e) => e.data.messageId.endsWith("_a1"))
            .map((e) => e.data.text),
        ).toEqual(["Hel", "lo world"])
        expect(of(h.events, "turn.completed").at(-1)?.data.stopReason).toBe("end_turn")
        expect(of(h.events, "error").length).toBe(0)
      } finally {
        await h.close()
      }
    })

  test("when resubscribe fails the client falls back to polling GetTask", async () => {
    const f = fake({ dialect: "1.0", streaming: true, noResubscribe: true })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url, reconnectDelayMs: 10, pollIntervalMs: 50 } })
    try {
      await h.session.prompt({ text: "drop" })
      await h.waitTurn(10_000)
      const methods = f.requests.map((r) => r.method)
      expect(methods).toContain("SubscribeToTask")
      expect(methods).toContain("GetTask")
      expect(said(h.events)).toEqual(["Thinking…", "Hello world"])
      expect(
        of(h.events, "message.delta")
          .filter((e) => e.data.messageId.endsWith("_a1"))
          .map((e) => e.data.text),
      ).toEqual(["Hel", "lo world"])
      expect(of(h.events, "turn.completed").at(-1)?.data.stopReason).toBe("end_turn")
    } finally {
      await h.close()
    }
  })

  test("steer sends a follow-up on the running task (same taskId / contextId)", async () => {
    const f = fake({ dialect: "1.0", streaming: true })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    try {
      await h.session.prompt({ text: "slow" })
      await h.waitFor("message.completed", (e) => e.data.text === "Working slowly", 10_000)
      await h.session.steer?.({ text: "faster please" })
      await h.waitFor("turn.completed", undefined, 10_000)
      const follow = f.requests.find((r) => r.method === "SendMessage")
      const first = f.requests[0]?.params.message as { contextId?: string }
      const msg = follow?.params.message as { taskId?: string; contextId?: string; parts: { text: string }[] }
      expect(msg.taskId).toBeTruthy()
      expect(msg.parts[0]?.text).toBe("faster please")
      expect((follow!.params.configuration as { returnImmediately?: boolean }).returnImmediately).toBe(true)
      expect(said(h.events).at(-1)).toBe("Nice to meet you, faster please")
      expect(of(h.events, "turn.started").length).toBe(1)
      expect(first.contextId === undefined || first.contextId === msg.contextId).toBe(true)
    } finally {
      await h.close()
    }
  })

  test("steer falls back to the queue when the remote refuses follow-ups on a working task", async () => {
    const f = fake({ dialect: "0.3", streaming: true, rejectFollowUps: true })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    try {
      await h.session.prompt({ text: "slow" })
      await h.waitFor("message.completed", (e) => e.data.text === "Working slowly", 10_000)
      await h.session.steer?.({ text: "also this" })
      await h.session.interrupt()
      await h.waitFor("turn.started", (e) => e.data.prompt === "also this", 10_000)
      await h.waitFor("message.completed", (e) => e.data.text === "echo: also this", 10_000)
    } finally {
      await h.close()
    }
  })

  for (const answer of ["allow_once", "reject_once"] as const)
    test(`a confirmation question becomes a permission request; ${answer} answers "${answer === "allow_once" ? "yes" : "no"}" in the same turn`, async () => {
      const f = fake({ dialect: "1.0", streaming: true })
      const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
      h.autoApprove = answer
      try {
        await h.session.prompt({ text: "deploy" })
        await h.waitTurn(10_000)
        const req = of(h.events, "permission.requested")[0]
        expect(req?.data.title).toContain("deploying to production")
        expect(req?.data.options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"])
        const second = f.requests[1]?.params.message as { taskId?: string; parts: { text: string }[] }
        expect(second.taskId).toBeTruthy()
        expect(second.parts[0]?.text).toBe(answer === "allow_once" ? "yes" : "no")
        expect(of(h.events, "turn.started").length).toBe(1)
        expect(of(h.events, "turn.completed").map((e) => e.data.stopReason)).toEqual(["end_turn"])
        expect(said(h.events).at(-1)).toBe(`Nice to meet you, ${answer === "allow_once" ? "yes" : "no"}`)
      } finally {
        await h.close()
      }
    })

  test("a plain question stays a normal input-required turn end (permissions: false forces that too)", async () => {
    const f = fake({ dialect: "1.0", streaming: true })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url, permissions: false } })
    try {
      await h.session.prompt({ text: "deploy" })
      await h.waitTurn(10_000)
      expect(of(h.events, "permission.requested").length).toBe(0)
      expect(of(h.events, "turn.completed").at(-1)?.data.stopReason).toBe("input_required")
    } finally {
      await h.close()
    }
  })

  test("the system prompt goes out once, as a leading context part of the first message", async () => {
    const f = fake({ dialect: "1.0", streaming: false })
    const h = await startHarness(a2aAdapter, { cwd, systemPrompt: "You are the researcher on team Baton.", options: { url: f.url } })
    try {
      await h.session.prompt({ text: "hello" })
      await h.waitTurn(10_000)
      await h.session.prompt({ text: "direct" })
      await h.waitTurn(10_000)
      const first = f.requests[0]?.params.message as { parts: { text: string; metadata?: Record<string, any> }[] }
      expect(first.parts.length).toBe(2)
      expect(first.parts[0]?.text).toStartWith("Context from Baton")
      expect(first.parts[0]?.text).toContain("You are the researcher on team Baton.")
      expect(first.parts[0]?.metadata?.baton.kind).toBe("context")
      expect(first.parts[1]?.text).toBe("hello")
      const sends = f.requests.filter((r) => r.method === "SendMessage")
      expect((sends[1]!.params.message as { parts: unknown[] }).parts.length).toBe(1)
    } finally {
      await h.close()
    }
  })

  for (const dialect of ["0.3", "1.0"] as const)
    test(`options.pushUrl registers a webhook with every message (${dialect})`, async () => {
      const f = fake({ dialect, streaming: false, push: true })
      const h = await startHarness(a2aAdapter, {
        cwd,
        options: { url: f.url, pushUrl: "https://hooks.example.com/a2a", pushToken: "t0k", pushAuth: { scheme: "Bearer", credentials: "c" } },
      })
      try {
        await h.session.prompt({ text: "hello" })
        await h.waitTurn(10_000)
        const cfg = f.requests[0]?.params.configuration as Record<string, any>
        const p = dialect === "1.0" ? cfg.taskPushNotificationConfig : cfg.pushNotificationConfig
        expect(p.url).toBe("https://hooks.example.com/a2a")
        expect(p.token).toBe("t0k")
        if (dialect === "1.0") expect(p.authentication).toEqual({ scheme: "Bearer", credentials: "c" })
        else expect(p.authentication).toEqual({ schemes: ["Bearer"], credentials: "c" })
      } finally {
        await h.close()
      }
    })
})

describe("a2a adapter: auth from the card's security schemes", () => {
  for (const [location, v1] of [
    ["header", true],
    ["query", false],
    ["cookie", true],
  ] as const)
    test(`API key in the ${location} (env: reference)`, async () => {
      const f = fake({ dialect: v1 ? "1.0" : "0.3", streaming: false, auth: { kind: "apiKey", location, name: "X-Fake-Key", key: "k-123", v1 } })
      const h = await startHarness(a2aAdapter, { cwd, env: { FAKE_KEY: "k-123" }, options: { url: f.url, apiKey: "env:FAKE_KEY" } })
      try {
        await h.session.prompt({ text: "hi" })
        await h.waitTurn(10_000)
        expect(said(h.events)).toEqual(["echo: hi"])
        if (location === "query") expect(new URL(f.requests[0]!.url).searchParams.get("X-Fake-Key")).toBe("k-123")
      } finally {
        await h.close()
      }
    })

  test("OAuth2 client credentials: token from the card's tokenUrl, cached, refreshed after a 401", async () => {
    const f = fake({ dialect: "1.0", streaming: false, auth: { kind: "oauth2", clientId: "baton", clientSecret: "s3cret" } })
    process.env.A2A_TEST_SECRET = "s3cret"
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url, clientId: "baton", clientSecret: "env:A2A_TEST_SECRET" } })
    try {
      await h.session.prompt({ text: "one" })
      await h.waitTurn(10_000)
      await h.session.prompt({ text: "two" })
      await h.waitTurn(10_000)
      expect(f.tokenRequests.length).toBe(1)
      expect(new URLSearchParams(f.tokenRequests[0]!.body).get("scope")).toBe("a2a:write")
      expect(f.requests[0]?.headers.get("authorization")).toBe("Bearer tok-1")
      f.revoke()
      await h.session.prompt({ text: "three" })
      await h.waitTurn(10_000)
      expect(f.tokenRequests.length).toBe(2)
      expect(said(h.events)).toEqual(["echo: one", "echo: two", "echo: three"])
      expect(f.requests.at(-1)?.headers.get("authorization")).toBe("Bearer tok-2")
    } finally {
      await h.close()
      delete process.env.A2A_TEST_SECRET
    }
  })

  test("OpenID Connect: token endpoint discovered from openIdConnectUrl; expired tokens are renewed", async () => {
    const f = fake({ dialect: "1.0", streaming: true, auth: { kind: "oauth2", clientId: "c", clientSecret: "s", oidc: true, ttl: 1 } })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url, clientId: "c", clientSecret: "s" } })
    try {
      await h.session.prompt({ text: "hi" })
      await h.waitTurn(10_000)
      expect(said(h.events)).toEqual(["echo: hi"])
      expect(f.tokenRequests.length).toBe(1)
      await sleep(600) // ttl 1 s → the client renews ahead of expiry
      await h.session.prompt({ text: "again" })
      await h.waitTurn(10_000)
      expect(f.tokenRequests.length).toBe(2)
    } finally {
      await h.close()
    }
  })

  test("missing credentials: a clear error", async () => {
    const f = fake({ dialect: "1.0", streaming: false, auth: { kind: "oauth2", clientId: "c", clientSecret: "s" } })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    try {
      await h.session.prompt({ text: "hi" })
      await h.waitTurn(10_000)
      expect(of(h.events, "error")[0]?.data.message).toMatch(/401|not authorized/)
    } finally {
      await h.close()
    }
  })
})

describe("a2a adapter: signed agent cards", () => {
  test("a valid signature passes requireSignedCard", async () => {
    const f = fake({ dialect: "1.0", streaming: false, sign: "valid" })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url, requireSignedCard: true } })
    await h.close()
  })

  test("a tampered card: a warning by default, fatal with requireSignedCard", async () => {
    const f = fake({ dialect: "1.0", streaming: false, sign: "tampered" })
    const h = await startHarness(a2aAdapter, { cwd, options: { url: f.url } })
    await h.close()
    await expect(startHarness(a2aAdapter, { cwd, options: { url: f.url, requireSignedCard: true } })).rejects.toThrow(/signature/)
  })

  test("an unsigned card fails requireSignedCard; pinned keys override jku", async () => {
    const f = fake({ dialect: "1.0", streaming: false })
    await expect(startHarness(a2aAdapter, { cwd, options: { url: f.url, requireSignedCard: true } })).rejects.toThrow(/not signed/)
    const g = fake({ dialect: "1.0", streaming: false, sign: "valid" })
    const other = publicJwk(generateKeyPairSync("ed25519").privateKey)
    await expect(startHarness(a2aAdapter, { cwd, options: { url: g.url, requireSignedCard: true, cardJwks: { keys: [other] } } })).rejects.toThrow(/signature/)
    const ok = await startHarness(a2aAdapter, { cwd, options: { url: g.url, requireSignedCard: true, cardJwks: { keys: [publicJwk(g.key)] } } })
    await ok.close()
  })
})

describe("wire extras", () => {
  test("JCS canonicalization (RFC 8785)", () => {
    expect(canonicalize({ b: 2, a: [1, "x", null, true], c: { z: 1e21, y: 0.000001, "€": "é\n" } })).toBe(
      '{"a":[1,"x",null,true],"b":2,"c":{"y":0.000001,"z":1e+21,"€":"é\\n"}}',
    )
    expect(canonicalize({ "\u{1F600}": 1, é: 2, a: undefined })).toBe('{"é":2,"😀":1}')
  })

  test("card signatures: sign → verify; tampering and stripped defaults", async () => {
    const { privateKey } = generateKeyPairSync("ed25519")
    const card = { name: "x", skills: [], capabilities: { streaming: true }, description: "" }
    const signed = signCard(card, privateKey, { jku: "https://x/jwks.json" })
    const header = JSON.parse(Buffer.from(signed.signatures[0]!.protected, "base64url").toString())
    expect(header).toMatchObject({ alg: "EdDSA", typ: "JOSE", jku: "https://x/jwks.json" })
    expect(header.kid).toBe(publicJwk(privateKey).kid)
    const jwks = { keys: [publicJwk(privateKey)] }
    expect((await verifyCard(signed, { jwks })).status).toBe("valid")
    expect((await verifyCard({ ...signed, name: "y" }, { jwks })).status).toBe("invalid")
    expect((await verifyCard(card, { jwks })).status).toBe("unsigned")
    // jku is fetched when no keys are pinned
    expect((await verifyCard(signed, { fetchJwks: async () => jwks })).status).toBe("valid")
    // a producer that dropped default values before signing still verifies
    const stripped = signCard({ name: "x", capabilities: { streaming: true } }, privateKey)
    expect((await verifyCard({ ...stripped, skills: [], description: "" }, { jwks })).status).toBe("valid")
  })

  test("readCard: binding choice, security schemes, capabilities", () => {
    const card = {
      name: "n",
      supportedInterfaces: [
        { url: "grpc.example.com:443", protocolBinding: "GRPC", protocolVersion: "1.0" },
        { url: "https://a.example/rest", protocolBinding: "HTTP+JSON", protocolVersion: "1.0", tenant: "t1" },
        { url: "https://a.example/rpc", protocolBinding: "JSONRPC", protocolVersion: "1.0" },
      ],
      capabilities: { streaming: true, pushNotifications: true },
      securitySchemes: {
        k: { apiKeySecurityScheme: { location: "query", name: "key" } },
        o: { type: "openIdConnect", openIdConnectUrl: "https://i/.well-known" },
      },
      securityRequirements: [{ schemes: { k: { list: [] } } }],
    }
    const auto = readCard(card, "https://a.example/.well-known/agent-card.json")
    expect(auto.endpoint).toEqual({ url: "https://a.example/rest", binding: "HTTP+JSON", dialect: "1.0", tenant: "t1" })
    expect(auto.pushNotifications).toBe(true)
    expect(auto.interfaces.map((i) => i.binding)).toEqual(["GRPC", "HTTP+JSON", "JSONRPC"])
    expect(auto.securitySchemes.k).toEqual({ type: "apiKey", location: "query", name: "key", description: undefined })
    expect(auto.securitySchemes.o?.type).toBe("openIdConnect")
    expect(auto.securityRequirements).toEqual([{ k: [] }])
    expect(readCard(card, "https://a.example/", undefined, "jsonrpc").endpoint?.url).toBe("https://a.example/rpc")
    expect(readCard({ name: "g", supportedInterfaces: [card.supportedInterfaces[0]] }, "https://a.example/").endpoint).toBeUndefined()
    // a v0.3 REST-only card is not usable (different JSON); its JSON-RPC alternative is
    const legacy = readCard(
      { name: "l", url: "https://l/rest", preferredTransport: "HTTP+JSON", additionalInterfaces: [{ url: "https://l/rpc", transport: "JSONRPC" }] },
      "https://l/",
    )
    expect(legacy.endpoint).toEqual({ url: "https://l/rpc", binding: "JSONRPC", dialect: "0.3" })
  })

  test("push config codecs accept every shape", () => {
    const flat = decodePushConfig({ taskId: "t", id: "c", url: "https://h", token: "x", authentication: { scheme: "Bearer", credentials: "y" } })
    expect(flat).toEqual({ id: "c", taskId: "t", url: "https://h", token: "x", authentication: { scheme: "Bearer", credentials: "y" } })
    const legacy = decodePushConfig({
      taskId: "t",
      pushNotificationConfig: { id: "c", url: "https://h", authentication: { schemes: ["Basic"], credentials: "z" } },
    })
    expect(legacy).toMatchObject({ id: "c", taskId: "t", authentication: { scheme: "Basic", credentials: "z" } })
    expect(decodePushConfig({ url: "https://h" }, "t2").taskId).toBe("t2")
    expect(() => decodePushConfig({ taskId: "t" })).toThrow(/url/)
    const c = { id: "c", taskId: "t", url: "https://h", authentication: { scheme: "Bearer" } }
    expect(encodePushConfig(c, "0.3")).toEqual({ taskId: "t", pushNotificationConfig: { id: "c", url: "https://h", authentication: { schemes: ["Bearer"] } } })
    expect(decodePushConfig(encodePushConfig(c, "1.0"))).toEqual({ ...c, token: undefined, authentication: { scheme: "Bearer", credentials: undefined } })
  })

  test("REST errors map back to A2A codes", () => {
    const e = restError(400, { error: { code: 400, message: "nope", details: [{ "@type": "x", reason: "TASK_NOT_CANCELABLE" }] } }, "")
    expect(e.code).toBe(-32002)
    expect(restError(404, {}, "gone").code).toBe(-32001)
  })

  test("confirmation questions", () => {
    expect(isConfirmation("Do you approve deploying to production?")).toBe(true)
    expect(isConfirmation('needs approval: Bash(rm -rf build)\nReply "allow" or "deny".')).toBe(true)
    expect(isConfirmation("Shall I proceed with the migration?")).toBe(true)
    expect(isConfirmation("Delete 3 files? (y/n)")).toBe(true)
    expect(isConfirmation("What is your name?")).toBe(false)
    expect(isConfirmation("Which database should I use, Postgres or SQLite?")).toBe(false)
  })
})
