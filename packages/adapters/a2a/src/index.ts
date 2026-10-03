/**
 * A2A adapter: drives a remote Agent2Agent (A2A) agent as a Baton agent.
 *
 * Config (`[agents.<name>]` with `adapter = "a2a"`):
 *   options.url              agent base URL or agent-card URL (or `args[0]`)
 *   options.endpoint         JSON-RPC endpoint override (skips the card's interface choice)
 *   options.token            bearer token · options.tokenEnv: env var holding it
 *   options.headers          extra HTTP headers (e.g. an API key)
 *   options.protocolVersion  "1.0" | "0.3" — force a dialect (default: what the card offers, 1.0 first)
 *   options.streaming        false = never stream even if the card says it can
 *   options.blocking         non-streaming only: true = one blocking SendMessage instead of
 *                            returning at once and polling GetTask (default false)
 *   options.pollIntervalMs   GetTask polling interval when a response isn't final (default 1000)
 *   options.cancelOnClose    cancel the running remote task on close (default true)
 *
 * Mapping: each prompt is one A2A message (streamed when the card allows). The contextId is kept
 * for the whole session (multi-turn; it is also the resume id). A task that asks for input
 * (input-required / auth-required) ends the Baton turn with the agent's question; the next prompt
 * continues that task. Text parts become assistant messages, other parts (files, data) show as
 * tool output. failed / rejected → error + turn.completed(error); canceled → turn.interrupted.
 */
import type { AdapterCapabilities, AdapterContext, AgentAdapter, AgentEvent, AgentSession, DetectResult, PromptInput, SessionConfig } from "@batonsh/protocol"
import { defineAdapter, newId } from "@batonsh/protocol"
import { A2AClient } from "./client.ts"
import {
  type Artifact,
  type Dialect,
  isFinalState,
  type Message,
  type Part,
  type StreamEvent,
  type TaskState,
  type TaskStatus,
  textMessage,
  textOf,
} from "./wire.ts"

export { A2AClient, type A2AClientOptions, cardCandidates } from "./client.ts"
export * from "./wire.ts"

interface Turn {
  id: string
  ac: AbortController
  taskId?: string
  done: boolean
  interrupted: boolean
  texts: Set<string>
  artifacts: Map<string, { messageId: string; text: string; done: boolean; streamed: boolean }>
}

const MAX_SEEN = 2000

function describePart(p: Exclude<Part, { kind: "text" }>): string {
  if (p.kind === "data") return JSON.stringify(p.data, null, 2)
  const f = p.file
  const label = [f.name, f.mimeType].filter(Boolean).join(" · ") || "file"
  if (f.uri) return `${label}: ${f.uri}`
  return `${label} (${f.bytes ? Math.floor((f.bytes.length * 3) / 4) : 0} bytes inline)`
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

  constructor(
    private cfg: SessionConfig,
    private ctx: AdapterContext,
  ) {
    this.contextId = cfg.resumeId
  }

  private get opt() {
    return this.cfg.options ?? {}
  }

  async start(): Promise<void> {
    const o = this.opt
    const url = (typeof o.url === "string" && o.url) || this.cfg.args?.[0]
    if (!url) throw new Error('a2a: no agent URL — set options.url (e.g. [agents.remote.options] url = "https://agent.example.com")')
    const tokenEnv = typeof o.tokenEnv === "string" ? (this.cfg.env?.[o.tokenEnv] ?? process.env[o.tokenEnv]) : undefined
    const headers: Record<string, string> = {}
    if (o.headers && typeof o.headers === "object") for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) headers[k] = String(v)
    const dialect = o.protocolVersion === undefined ? undefined : String(o.protocolVersion).startsWith("0.") ? "0.3" : "1.0"
    this.client = await A2AClient.connect(
      {
        url,
        endpoint: typeof o.endpoint === "string" ? o.endpoint : undefined,
        headers,
        token: (typeof o.token === "string" && o.token) || tokenEnv || undefined,
        dialect: dialect as Dialect | undefined,
        timeoutMs: typeof o.timeoutMs === "number" ? o.timeoutMs : undefined,
      },
      this.ctx.signal,
    )
    this.streaming = this.client.card.streaming && o.streaming !== false
    this.ctx.log("info", `a2a: ${this.client.card.name} at ${this.client.endpoint} (A2A ${this.client.dialect}, ${this.streaming ? "streaming" : "blocking"})`)
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

  async respondPermission(): Promise<void> {}

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
    const message = textMessage("user", input.text, {
      contextId: this.contextId,
      taskId: this.pendingTaskId,
      metadata: input.from && input.from !== "user" ? { baton: { from: input.from } } : undefined,
    })
    t.taskId = this.pendingTaskId
    try {
      if (this.streaming) {
        for await (const ev of this.client.sendStream(message, t.ac.signal)) if (this.handle(t, ev) || t.done) break
      } else {
        // non-blocking by default: we learn the task id at once (so interrupt can cancel it), then poll
        this.handle(t, await this.client.send(message, t.ac.signal, this.opt.blocking === true))
      }
      // the stream closed early or a non-blocking server answered before the task finished
      if (!t.done && t.taskId) await this.poll(t)
      if (!t.done) throw new Error("the remote agent closed the response without a final task state")
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
      this.turn = undefined
      if (!this.closed) {
        this.emit({ type: "agent.status", data: { status: "ready", detail: this.pendingTaskId ? "input required" : undefined } })
        const next = this.queue.shift()
        if (next) void this.run(next)
      }
    }
  }

  private async poll(t: Turn): Promise<void> {
    const every = typeof this.opt.pollIntervalMs === "number" ? this.opt.pollIntervalMs : 1_000
    while (!t.done && t.taskId && !t.ac.signal.aborted && !this.closed) {
      await Bun.sleep(every)
      if (t.done || t.ac.signal.aborted) return
      this.handle(t, await this.client.getTask(t.taskId, undefined, t.ac.signal))
    }
  }

  /** Apply one A2A event to the turn; true when the turn is over. */
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
      case "task":
        t.taskId = ev.id
        for (const m of ev.history ?? []) if (m.role === "agent") this.emitMessage(t, m)
        for (const a of ev.artifacts ?? []) this.artifact(t, ev.id, a, false, true)
        return this.status(t, ev.id, ev.status)
      case "status-update":
        t.taskId = ev.taskId || t.taskId
        return this.status(t, t.taskId ?? ev.taskId, ev.status) || (ev.final && !t.done ? this.finishUnknown(t, ev.status.state) : false)
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
    if (s.message && s.message.role === "agent") this.emitMessage(t, s.message)
    const why = s.message ? textOf(s.message.parts).trim() : ""
    switch (s.state) {
      case "input-required":
      case "auth-required":
        this.pendingTaskId = taskId
        this.pendingStatusKey = key
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

  private finish(t: Turn, stop: string): void {
    if (t.done) return
    // close artifacts that never got their last chunk
    for (const a of t.artifacts.values()) if (!a.done) this.completeArtifact(t, a)
    t.done = true
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
    } else st.text = chunk
    st.done = false
    for (const p of a.parts) if (p.kind !== "text") this.emitPart(p, "Artifact", a.name)
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
    return { steer: false, interrupt: true, resume: true, fork: false, diff: false, usage: false, cost: false, permissions: false, mcp: false, models: [] }
  },
  async start(cfg: SessionConfig, ctx: AdapterContext): Promise<AgentSession> {
    const s = new A2ASession(cfg, ctx)
    await s.start()
    return s
  },
})

export default a2aAdapter
