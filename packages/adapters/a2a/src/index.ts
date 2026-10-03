/**
 * A2A adapter: drives a remote Agent2Agent (A2A) agent as a Baton agent.
 *
 * Config (`[agents.<name>]` with `adapter = "a2a"`). String values may be `env:NAME` references.
 *   options.url              agent base URL or agent-card URL (or `args[0]`)
 *   options.endpoint         endpoint override (skips the card's interface choice)
 *   options.transport        "auto" (default: the card's preference) | "jsonrpc" | "rest" (HTTP+JSON)
 *   options.token            bearer token · options.tokenEnv: env var holding it
 *   options.apiKey           API key for an apiKey security scheme (header / query / cookie per the card)
 *   options.basic            "user:password" for an HTTP basic scheme
 *   options.clientId / clientSecret / tokenUrl / scopes / audience / clientAuth
 *                            OAuth2 client credentials (token URL from the card unless given);
 *                            options.oidcUrl overrides the card's OpenID Connect discovery URL
 *   options.headers          extra HTTP headers
 *   options.protocolVersion  "1.0" | "0.3" — force a dialect (default: what the card offers, 1.0 first)
 *   options.streaming        false = never stream even if the card says it can
 *   options.blocking         non-streaming only: true = one blocking SendMessage instead of
 *                            returning at once and polling GetTask (default false)
 *   options.pollIntervalMs   GetTask polling interval when a response isn't final (default 1000)
 *   options.reconnectAttempts / reconnectDelayMs
 *                            resubscribe attempts after a dropped stream (default 3, backoff from 500 ms), then poll
 *   options.cancelOnClose    cancel the running remote task on close (default true)
 *   options.requireSignedCard  refuse agents whose card isn't signed with a verifiable key
 *   options.cardJwks         trusted signing keys (JWKS object or URL) instead of the card's `jku`
 *   options.pushUrl          webhook registered for every task (+ pushToken, pushAuth = { scheme, credentials })
 *   options.sendContext      false = don't send the session's system prompt as context (default true)
 *   options.steer            false = queue mid-turn input instead of sending it to the running task
 *   options.permissions      false = show confirmation questions as plain input-required turns
 *
 * Mapping: each prompt is one A2A message (streamed when the card allows). The contextId is kept
 * for the whole session (multi-turn; it is also the resume id). The first message of a new
 * conversation carries the session's system prompt as a leading "Context from Baton" text part.
 * A task that asks for a yes/no confirmation (input-required) becomes a permission request
 * (Allow / Deny, answered with "yes" / "no" on the same task, in the same turn); any other
 * input-required / auth-required ends the Baton turn with the agent's question and the next prompt
 * continues that task. Steering sends a follow-up message on the running task. Text parts become
 * assistant messages, other parts (files, data) show as tool output. failed / rejected → error +
 * turn.completed(error); canceled → turn.interrupted.
 */
import type { AdapterCapabilities, AdapterContext, AgentAdapter, AgentEvent, AgentSession, DetectResult, PromptInput, SessionConfig } from "@batonsh/protocol"
import { defineAdapter, newId } from "@batonsh/protocol"
import { resolveRef } from "./auth.ts"
import { A2AClient } from "./client.ts"
import {
  A2AError,
  type Artifact,
  type Dialect,
  ErrorCode,
  isFinalState,
  type Message,
  type Part,
  type StreamEvent,
  type TaskState,
  type TaskStatus,
  type TransportPref,
  textMessage,
  textOf,
} from "./wire.ts"

export { Auth, type AuthOptions, resolveRef } from "./auth.ts"
export { A2AClient, type A2AClientOptions, cardCandidates } from "./client.ts"
export * from "./wire.ts"

/** Max length of the system prompt sent as context. */
const MAX_CONTEXT = 16_000

/** Does an input-required question ask for a yes/no confirmation (→ a permission prompt)? */
export function isConfirmation(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  if (/\breply\s+["'“]?(allow|yes|approve)\b/i.test(t) || /\b(yes\s*\/\s*no|y\s*\/\s*n)\b/i.test(t)) return true
  if (/\b(allow|deny|approve|approval|permission|confirm|confirmation)\b/i.test(t)) return true
  return /\b(proceed|go ahead|continue|ok to|okay to|is (it|that) ok(ay)?|shall i|may i|should i go ahead)\b[^?]*\?\s*$/i.test(t)
}

interface PendingPermission {
  requestId: string
  taskId: string
  promise: Promise<boolean | null>
  resolve: (allow: boolean | null) => void
}

interface Turn {
  id: string
  ac: AbortController
  taskId?: string
  done: boolean
  interrupted: boolean
  texts: Set<string>
  artifacts: Map<string, { messageId: string; text: string; done: boolean; streamed: boolean }>
  /** A confirmation question waiting for the user's Allow / Deny. */
  permission?: PendingPermission
}

const MAX_SEEN = 2000

function describePart(p: Exclude<Part, { kind: "text" }>): string {
  if (p.kind === "data") return JSON.stringify(p.data, null, 2)
  const f = p.file
  const label = [f.name, f.mimeType].filter(Boolean).join(" · ") || "file"
  if (f.uri) return `${label}: ${f.uri}`
  return `${label} (${f.bytes ? Math.floor((f.bytes.length * 3) / 4) : 0} bytes inline)`
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : d)

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener("abort", done)
      resolve()
    }
    signal.addEventListener("abort", done, { once: true })
  })
}

class A2ASession implements AgentSession {
  private client!: A2AClient
  private contextId: string | undefined
  /** Task waiting for our input (input-required / auth-required); the next prompt continues it. */
  private pendingTaskId: string | undefined
  /** The status that ended the last turn; echoed back in the next response's task snapshot, it is stale. */
  private pendingStatusKey: string | undefined
  private queue: PromptInput[] = []
  private turn: Turn | undefined
  private closed = false
  private streaming = false
  private seen = new Set<string>()
  private turns = 0
  /** The system prompt still has to go out (first message of a new conversation). */
  private contextPending: boolean
  /** The remote refused a follow-up on a running task once: queue from then on. */
  private steerRefused = false
  private perms = new Map<string, PendingPermission>()

  constructor(
    private cfg: SessionConfig,
    private ctx: AdapterContext,
  ) {
    this.contextId = cfg.resumeId
    this.contextPending = !cfg.resumeId && !!cfg.systemPrompt?.trim() && cfg.options?.sendContext !== false
  }

  private get opt() {
    return this.cfg.options ?? {}
  }

  async start(): Promise<void> {
    const o = this.opt
    const env = { ...process.env, ...(this.cfg.env ?? {}) }
    const ref = (k: string) => resolveRef(o[k], env)
    const url = ref("url") || this.cfg.args?.[0]
    if (!url) throw new Error('a2a: no agent URL — set options.url (e.g. [agents.remote.options] url = "https://agent.example.com")')
    const tokenEnv = typeof o.tokenEnv === "string" ? env[o.tokenEnv] : undefined
    const headers: Record<string, string> = {}
    if (o.headers && typeof o.headers === "object")
      for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) headers[k] = resolveRef(String(v), env) ?? ""
    const dialect = o.protocolVersion === undefined ? undefined : String(o.protocolVersion).startsWith("0.") ? "0.3" : "1.0"
    const transport = (["auto", "jsonrpc", "rest"] as const).find((t) => t === String(o.transport ?? "auto").toLowerCase()) ?? "auto"
    const scopes = Array.isArray(o.scopes) ? o.scopes.map(String) : typeof o.scopes === "string" ? o.scopes.split(/[\s,]+/).filter(Boolean) : undefined
    const pushUrl = ref("pushUrl")
    const pushAuth = o.pushAuth && typeof o.pushAuth === "object" ? (o.pushAuth as Record<string, unknown>) : undefined
    this.client = await A2AClient.connect(
      {
        url,
        endpoint: ref("endpoint"),
        transport: transport as TransportPref,
        headers,
        token: ref("token") || tokenEnv || undefined,
        auth: {
          apiKey: ref("apiKey"),
          basic: ref("basic"),
          clientId: ref("clientId"),
          clientSecret: ref("clientSecret"),
          tokenUrl: ref("tokenUrl"),
          oidcUrl: ref("oidcUrl"),
          audience: ref("audience"),
          scopes,
          clientAuth: o.clientAuth === "post" ? "post" : undefined,
          scheme: ref("securityScheme"),
        },
        dialect: dialect as Dialect | undefined,
        timeoutMs: typeof o.timeoutMs === "number" ? o.timeoutMs : undefined,
        requireSignedCard: o.requireSignedCard === true,
        cardJwks: typeof o.cardJwks === "string" ? o.cardJwks : o.cardJwks && typeof o.cardJwks === "object" ? (o.cardJwks as never) : undefined,
        push: pushUrl
          ? {
              url: pushUrl,
              token: ref("pushToken"),
              authentication: pushAuth?.scheme ? { scheme: String(pushAuth.scheme), credentials: resolveRef(pushAuth.credentials, env) } : undefined,
            }
          : undefined,
        log: (level, msg) => this.ctx.log(level, msg),
      },
      this.ctx.signal,
    )
    if (pushUrl && !this.client.card.pushNotifications)
      this.ctx.log("warn", `a2a: ${this.client.card.name} does not support push notifications; options.pushUrl is ignored`)
    this.streaming = this.client.card.streaming && o.streaming !== false
    this.ctx.log(
      "info",
      `a2a: ${this.client.card.name} at ${this.client.endpoint} (A2A ${this.client.dialect} ${this.client.binding}, ${this.streaming ? "streaming" : "blocking"}, auth: ${this.client.auth.describe()})`,
    )
    queueMicrotask(() => {
      this.emit({ type: "agent.updated", data: { version: this.client.card.version, model: this.cfg.model ?? this.client.card.name } })
      if (this.contextId) this.emit({ type: "agent.session", data: { sessionId: this.contextId } })
      this.emit({ type: "agent.status", data: { status: "ready" } })
    })
    this.ctx.signal.addEventListener("abort", () => void this.close(), { once: true })
  }

  private emit(e: AgentEvent): void {
    if (!this.closed || e.type === "agent.exited" || e.type === "turn.interrupted") this.ctx.emit(e)
  }

  resumeId(): string | undefined {
    return this.contextId
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.closed) throw new Error("a2a session is closed")
    if (this.turn) {
      this.queue.push(input)
      return
    }
    void this.run(input)
  }

  /**
   * Mid-turn input: a follow-up message on the running task (same taskId / contextId). Remote
   * agents that refuse messages on a working task get it as the next prompt instead.
   */
  async steer(input: PromptInput): Promise<void> {
    const t = this.turn
    if (!t || t.done || !t.taskId || t.permission || this.opt.steer === false || this.steerRefused) return this.prompt(input)
    const message = textMessage("user", input.text, { contextId: this.contextId, taskId: t.taskId, metadata: this.fromMeta(input) })
    try {
      const ev = await this.client.send(message, t.ac.signal, false)
      if (this.turn !== t || t.done) return
      // the running stream reports progress; apply only what belongs to this task
      if (ev.kind === "message") this.emitMessage(t, ev)
      else if ((ev.kind === "task" ? ev.id : ev.taskId) === t.taskId) this.handle(t, ev)
    } catch (e) {
      if (t.ac.signal.aborted) return
      if (e instanceof A2AError && e.code !== ErrorCode.InvalidAgentResponse) this.steerRefused = true
      this.ctx.log(
        "info",
        `a2a: the remote agent did not take a follow-up on the running task (${e instanceof Error ? e.message : e}); queued as the next prompt`,
      )
      this.queue.push(input)
    }
  }

  async respondPermission(requestId: string, optionId: string | null): Promise<void> {
    const p = this.perms.get(requestId)
    if (!p) return
    this.perms.delete(requestId)
    p.resolve(optionId === null ? null : optionId === "allow" || optionId.startsWith("allow"))
  }

  async interrupt(): Promise<void> {
    const t = this.turn
    if (!t) {
      // a task waiting for our input can be dropped too
      const id = this.pendingTaskId
      this.pendingTaskId = undefined
      if (id) await this.client.cancelTask(id).catch((e) => this.ctx.log("warn", `a2a: cancel ${id}: ${e instanceof Error ? e.message : e}`))
      return
    }
    t.interrupted = true
    if (t.taskId) {
      try {
        const task = await this.client.cancelTask(t.taskId)
        if (task && this.turn === t) this.handle(t, task)
      } catch (e) {
        this.ctx.log("warn", `a2a: cancel ${t.taskId}: ${e instanceof Error ? e.message : e}`)
      }
    }
    if (!t.done) this.finish(t, "interrupted")
    t.ac.abort()
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue = []
    const t = this.turn
    if (t && !t.done) {
      if (t.taskId && this.opt.cancelOnClose !== false) {
        await this.client.cancelTask(t.taskId, AbortSignal.timeout(2_000)).catch(() => {})
      }
      this.finish(t, "interrupted")
    }
    t?.ac.abort()
    this.ctx.emit({ type: "agent.exited", data: { code: 0, reason: "closed" } })
  }

  // ───────────────────────────── turns ─────────────────────────────

  private fromMeta(input: PromptInput): Record<string, unknown> | undefined {
    return input.from && input.from !== "user" ? { baton: { from: input.from } } : undefined
  }

  /**
   * The outgoing message. The first one of a new conversation carries the session's system
   * prompt as a leading text part ("Context from Baton: …", tagged `metadata.baton.kind =
   * "context"`): A2A has no system-prompt slot, most agents ignore unknown metadata, and a
   * separate part keeps the user's text intact (a Baton server can tell the two apart).
   */
  private buildMessage(input: PromptInput): Message {
    const message = textMessage("user", input.text, { contextId: this.contextId, taskId: this.pendingTaskId, metadata: this.fromMeta(input) })
    if (this.contextPending && !this.contextId) {
      this.contextPending = false
      let sp = (this.cfg.systemPrompt ?? "").trim()
      if (sp.length > MAX_CONTEXT) sp = `${sp.slice(0, MAX_CONTEXT)}\n…(truncated)`
      message.parts.unshift({
        kind: "text",
        text: `Context from Baton (the orchestrator delegating to you):\n${sp}\n---`,
        metadata: { baton: { kind: "context" } },
      })
    }
    return message
  }

  private async run(input: PromptInput): Promise<void> {
    const t: Turn = {
      id: `t${++this.turns}`,
      ac: new AbortController(),
      done: false,
      interrupted: false,
      texts: new Set(),
      artifacts: new Map(),
    }
    this.turn = t
    this.emit({ type: "agent.status", data: { status: "busy" } })
    this.emit({ type: "turn.started", data: { turnId: t.id, prompt: input.text } })
    let message: Message | undefined = this.buildMessage(input)
    t.taskId = this.pendingTaskId
    try {
      while (message) {
        await this.exchange(t, message)
        message = undefined
        if (t.done) break
        const p = t.permission
        if (!p) {
          if (t.ac.signal.aborted || this.closed) break
          throw new Error("the remote agent closed the response without a final task state")
        }
        const allow = await p.promise
        t.permission = undefined
        this.perms.delete(p.requestId)
        if (t.done || this.closed || t.ac.signal.aborted) break
        this.emit({ type: "agent.status", data: { status: "busy" } })
        message = textMessage("user", allow ? "yes" : "no", { contextId: this.contextId, taskId: p.taskId })
      }
      if (!t.done) this.finish(t, "interrupted")
    } catch (e) {
      if (!t.done) {
        if (t.interrupted || this.closed) this.finish(t, "interrupted")
        else {
          this.emit({ type: "error", data: { message: `a2a: ${e instanceof Error ? e.message : String(e)}` } })
          this.finish(t, "error")
        }
      }
    } finally {
      t.ac.abort()
      if (t.permission) this.perms.delete(t.permission.requestId)
      this.turn = undefined
      if (!this.closed) {
        this.emit({ type: "agent.status", data: { status: "ready", detail: this.pendingTaskId ? "input required" : undefined } })
        const next = this.queue.shift()
        if (next) void this.run(next)
      }
    }
  }

  /** The turn can still make progress (not over, not waiting on the user, not aborted). */
  private open(t: Turn): boolean {
    return !t.done && !t.permission && !t.ac.signal.aborted && !this.closed
  }

  /** Send one message and follow its task until it is final (stream → resubscribe → poll). */
  private async exchange(t: Turn, message: Message): Promise<void> {
    if (this.streaming) {
      try {
        for await (const ev of this.client.sendStream(message, t.ac.signal)) if (this.handle(t, ev) || t.done) break
      } catch (e) {
        // before the task is known there's nothing to reattach to
        if (!t.taskId || !this.open(t)) {
          if (!this.open(t) && t.taskId) return
          throw e
        }
        this.ctx.log("warn", `a2a: event stream dropped: ${e instanceof Error ? e.message : e}`)
      }
      if (this.open(t) && t.taskId) await this.reconnect(t)
    } else {
      // non-blocking by default: we learn the task id at once (so interrupt can cancel it), then poll
      this.handle(t, await this.client.send(message, t.ac.signal, this.opt.blocking === true))
    }
    if (this.open(t) && t.taskId) await this.poll(t)
  }

  /** The stream ended before the task did: resubscribe with backoff, up to N times. */
  private async reconnect(t: Turn): Promise<void> {
    const max = num(this.opt.reconnectAttempts, 3)
    const base = num(this.opt.reconnectDelayMs, 500)
    for (let i = 0; i < max && this.open(t) && t.taskId; i++) {
      await sleep(base * 2 ** i, t.ac.signal)
      if (!this.open(t)) return
      this.ctx.log("info", `a2a: stream ended before task ${t.taskId} finished — resubscribing (${i + 1}/${max})`)
      try {
        for await (const ev of this.client.resubscribe(t.taskId, t.ac.signal)) if (this.handle(t, ev) || t.done) return
      } catch (e) {
        if (!this.open(t)) return
        this.ctx.log("warn", `a2a: resubscribe failed: ${e instanceof Error ? e.message : e}`)
        // a protocol answer (task is final, resubscribe unsupported, …): polling will tell
        if (e instanceof A2AError && e.code !== ErrorCode.InvalidAgentResponse) return
      }
    }
    if (this.open(t)) this.ctx.log("info", `a2a: polling task ${t.taskId}`)
  }

  private async poll(t: Turn): Promise<void> {
    const every = num(this.opt.pollIntervalMs, 1_000)
    let failures = 0
    while (this.open(t) && t.taskId) {
      await sleep(every, t.ac.signal)
      if (!this.open(t)) return
      try {
        this.handle(t, await this.client.getTask(t.taskId, undefined, t.ac.signal))
        failures = 0
      } catch (e) {
        if (!this.open(t)) return
        if (e instanceof A2AError || ++failures >= 3) throw e
        this.ctx.log("warn", `a2a: GetTask failed (${e instanceof Error ? e.message : e}); retrying`)
      }
    }
  }

  /** Apply one A2A event to the turn; true when the turn is over (or waits for a permission answer). */
  private handle(t: Turn, ev: StreamEvent): boolean {
    if (t.done) return true
    if (ev.contextId && ev.contextId !== this.contextId) {
      this.contextId = ev.contextId
      this.emit({ type: "agent.session", data: { sessionId: ev.contextId } })
    }
    switch (ev.kind) {
      case "message":
        // a direct reply: no task was created (or it is over)
        if (ev.role === "agent") this.emitMessage(t, ev)
        if (!ev.taskId) this.pendingTaskId = undefined
        this.finish(t, "end_turn")
        return true
      case "task": {
        t.taskId = ev.id
        for (const m of ev.history ?? []) if (m.role === "agent") this.emitMessage(t, m)
        // a snapshot of a running task (resubscribe / poll) carries artifacts so far, not finished ones
        const final = isFinalState(ev.status.state)
        for (const a of ev.artifacts ?? []) this.artifact(t, ev.id, a, false, final ? undefined : false)
        return this.status(t, ev.id, ev.status)
      }
      case "status-update":
        t.taskId = ev.taskId || t.taskId
        return this.status(t, t.taskId ?? ev.taskId, ev.status) || (ev.final && !t.done && !t.permission ? this.finishUnknown(t, ev.status.state) : false)
      case "artifact-update":
        t.taskId = ev.taskId || t.taskId
        this.artifact(t, ev.taskId, ev.artifact, ev.append === true, ev.lastChunk)
        return false
    }
  }

  private finishUnknown(t: Turn, state: TaskState): boolean {
    this.ctx.log("warn", `a2a: final status update in state ${state}`)
    this.finish(t, "end_turn")
    return true
  }

  private status(t: Turn, taskId: string, s: TaskStatus): boolean {
    const key = `${taskId}:${s.state}:${s.message?.messageId ?? ""}:${s.timestamp ?? ""}`
    if (key === this.pendingStatusKey) return false
    if (t.permission) return true
    if (s.message && s.message.role === "agent") this.emitMessage(t, s.message)
    const why = s.message ? textOf(s.message.parts).trim() : ""
    switch (s.state) {
      case "input-required":
      case "auth-required":
        this.pendingTaskId = taskId
        this.pendingStatusKey = key
        if (s.state === "input-required" && this.opt.permissions !== false && isConfirmation(why)) {
          this.askPermission(t, taskId, why)
          return true
        }
        this.finish(t, s.state === "input-required" ? "input_required" : "auth_required")
        return true
      case "completed":
        this.pendingTaskId = undefined
        this.finish(t, "end_turn")
        return true
      case "failed":
      case "rejected":
        this.pendingTaskId = undefined
        this.emit({ type: "error", data: { message: `a2a: remote task ${s.state}${why ? `: ${why}` : ""}` } })
        this.finish(t, "error")
        return true
      case "canceled":
        this.pendingTaskId = undefined
        this.finish(t, "interrupted")
        return true
      default:
        return isFinalState(s.state)
    }
  }

  /** A yes/no question from the remote agent → a Baton permission request (Allow / Deny). */
  private askPermission(t: Turn, taskId: string, question: string): void {
    let resolve!: (v: boolean | null) => void
    const promise = new Promise<boolean | null>((r) => {
      resolve = r
    })
    const p: PendingPermission = { requestId: newId("perm"), taskId, promise, resolve }
    t.permission = p
    this.perms.set(p.requestId, p)
    t.ac.signal.addEventListener("abort", () => resolve(null), { once: true })
    const first = question.split("\n").find((l) => l.trim()) ?? ""
    this.emit({ type: "agent.status", data: { status: "awaiting_approval" } })
    this.emit({
      type: "permission.requested",
      data: {
        requestId: p.requestId,
        title: `${this.client.card.name}: ${first.trim().slice(0, 200) || "confirm?"}`,
        kind: "other",
        detail: question.length > first.length ? question : undefined,
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    })
  }

  private finish(t: Turn, stop: string): void {
    if (t.done) return
    // close artifacts that never got their last chunk
    for (const a of t.artifacts.values()) if (!a.done) this.completeArtifact(t, a)
    t.done = true
    t.permission?.resolve(null)
    // anything still reading for this turn (a stream after a steer reply ended it, a poll) stops
    queueMicrotask(() => t.ac.abort())
    if (stop === "interrupted") this.emit({ type: "turn.interrupted", data: { turnId: t.id } })
    else this.emit({ type: "turn.completed", data: { turnId: t.id, stopReason: stop } })
  }

  private markSeen(id: string): boolean {
    if (this.seen.has(id)) return false
    this.seen.add(id)
    if (this.seen.size > MAX_SEEN) this.seen.delete(this.seen.values().next().value as string)
    return true
  }

  private emitText(t: Turn, messageId: string, text: string): void {
    const key = text.trim()
    if (!key || t.texts.has(key)) return
    t.texts.add(key)
    this.emit({ type: "message.delta", data: { messageId, role: "assistant", text } })
    this.emit({ type: "message.completed", data: { messageId, role: "assistant", text } })
  }

  private emitMessage(t: Turn, m: Message): void {
    if (!this.markSeen(`m:${m.messageId}`)) return
    this.emitText(t, `a2a_${m.messageId}`, textOf(m.parts))
    for (const p of m.parts) if (p.kind !== "text") this.emitPart(p, "Agent sent")
  }

  private emitPart(p: Exclude<Part, { kind: "text" }>, verb: string, name?: string): void {
    const toolCallId = newId("tc")
    const what = p.kind === "data" ? "data" : (p.file.name ?? "a file")
    const title = `${verb} ${name ? `${name} (${what})` : what}`
    this.emit({
      type: "tool.call",
      data: { toolCallId, kind: "other", name: "a2a", title, status: "completed", rawInput: p.kind === "file" ? { ...p.file, bytes: undefined } : undefined },
    })
    this.emit({
      type: "tool.update",
      data: { toolCallId, status: "completed", content: [{ type: "text", text: describePart(p) }], summary: p.kind === "file" ? p.file.mimeType : "data" },
    })
  }

  private artifact(t: Turn, taskId: string, a: Artifact, append: boolean, lastChunk: boolean | undefined): void {
    const key = `a:${taskId}:${a.artifactId}`
    let st = t.artifacts.get(key)
    const chunk = textOf(a.parts)
    const complete = lastChunk === true || (lastChunk === undefined && !append)
    if (!st) {
      // the same artifact already shown in an earlier turn (task snapshots repeat them)
      if (this.seen.has(`${key}:${chunk}`) && complete) return
      st = { messageId: `a2a_${taskId}_${a.artifactId}`, text: "", done: false, streamed: false }
      t.artifacts.set(key, st)
    } else if (st.done && !append && st.text === chunk) return
    if (append) {
      st.text += chunk
      if (chunk) {
        st.streamed = true
        this.emit({ type: "message.delta", data: { messageId: st.messageId, role: "assistant", text: chunk } })
      }
    } else if (st.streamed && chunk.startsWith(st.text)) {
      // a snapshot (after a reconnect) of an artifact we were streaming: show only what's new
      const rest = chunk.slice(st.text.length)
      if (rest) this.emit({ type: "message.delta", data: { messageId: st.messageId, role: "assistant", text: rest } })
      st.text = chunk
    } else st.text = chunk
    st.done = false
    for (const p of a.parts) if (p.kind !== "text" && this.markSeen(`p:${key}:${JSON.stringify(p)}`)) this.emitPart(p, "Artifact", a.name)
    if (complete) {
      this.completeArtifact(t, st)
      this.markSeen(`${key}:${st.text}`)
    }
  }

  private completeArtifact(t: Turn, st: { messageId: string; text: string; done: boolean; streamed: boolean }): void {
    st.done = true
    const key = st.text.trim()
    if (!key) return
    if (!st.streamed) {
      this.emitText(t, st.messageId, st.text)
      return
    }
    t.texts.add(key)
    this.emit({ type: "message.completed", data: { messageId: st.messageId, role: "assistant", text: st.text } })
  }
}

export const a2aAdapter: AgentAdapter = defineAdapter({
  id: "a2a",
  displayName: "A2A agent",
  family: "a2a",
  binaries: [],
  async detect(): Promise<DetectResult> {
    return {
      installed: true,
      auth: "unknown",
      protocols: ["a2a"],
      notes: ['remote Agent2Agent agent: set options.url (and options.token if it needs one) in [agents.<name>] with adapter = "a2a"'],
    }
  },
  capabilities(): AdapterCapabilities {
    return { steer: true, interrupt: true, resume: true, fork: false, diff: false, usage: false, cost: false, permissions: true, mcp: false, models: [] }
  },
  async start(cfg: SessionConfig, ctx: AdapterContext): Promise<AgentSession> {
    const s = new A2ASession(cfg, ctx)
    await s.start()
    return s
  },
})

export default a2aAdapter
