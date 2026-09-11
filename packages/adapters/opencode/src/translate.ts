/**
 * OpenCode SSE (`GET /event`) → BEP translator. Pure and synchronous: feed it native events,
 * get BEP events back. The session layer owns transport; this owns all mapping state, so it
 * can be driven from recorded JSONL fixtures in tests.
 */
import { realpathSync } from "node:fs"
import type { AgentEvent, AgentStatus, PermissionOption, PermissionOptionKind, ToolContent, ToolStatus } from "@batonsh/protocol"
import { newId } from "@batonsh/protocol"
import type { AssistantMessage, Message, Session as OcSession, Part, PermissionRequest, SessionStatus, Todo, ToolPart } from "@opencode-ai/sdk/v2"
import { editDiffs, isEditTool, toolKind, toolLocations, toolSummary, toolTitle, truncate } from "./tools.ts"

/** Loose shape of an SSE payload (`{type, properties}`); unknown types are ignored. */
export interface OcEvent {
  id?: string
  type: string
  properties?: Record<string, unknown>
}

export interface TranslatorOptions {
  cwd?: string
  /** Attach the native event as `raw` on every emitted BEP event. */
  includeRaw?: boolean
}

export type OcReply = "once" | "always" | "reject"

export const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: "once", name: "Allow once", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
]

/** BEP option id / kind → OpenCode permission reply. null (no answer) rejects. */
export function replyFor(optionId: string | null): OcReply {
  switch (optionId) {
    case "once":
    case "allow_once":
      return "once"
    case "always":
    case "allow_always":
      return "always"
    default:
      return "reject"
  }
}

export function optionKindFor(reply: OcReply): PermissionOptionKind {
  return reply === "once" ? "allow_once" : reply === "always" ? "allow_always" : "reject_once"
}

/** OpenCode / AI-SDK finish reason → ACP-style stop reason. */
export function stopReasonFor(finish: string | undefined): string {
  switch (finish) {
    case undefined:
    case "":
    case "stop":
    case "end_turn":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "content-filter":
      return "refusal"
    case "tool-calls":
      // the loop stopped while the model still wanted tools → step limit hit
      return "max_turn_requests"
    case "error":
      return "error"
    default:
      return finish
  }
}

interface TextState {
  role: "assistant" | "thought"
  messageId: string
  emitted: string
  completed: boolean
}

interface ToolState {
  announced: boolean
  status?: ToolStatus
  title?: string
  terminalOutput?: string
  planKey?: string
}

interface Turn {
  turnId: string
  interrupting: boolean
  /** Server confirmed it is working on this turn (guards against a stale duplicate `idle`). */
  active: boolean
  finish?: string
  error?: string
  aborted?: boolean
}

export class OpencodeTranslator {
  sessionId: string | undefined
  private readonly cwd: string | undefined
  private readonly includeRaw: boolean
  private roles = new Map<string, Message["role"]>()
  private texts = new Map<string, TextState>()
  private tools = new Map<string, ToolState>()
  private usageSeen = new Set<string>()
  /** child session id → task tool callID that spawned it. */
  private children = new Map<string, string | undefined>()
  /** task callID → child session id (from the task tool's metadata). */
  private taskSessions = new Map<string, string>()
  /** permission request id → BEP toolCallId. */
  private pending = new Map<string, string | undefined>()
  private replies = new Map<string, string | null>()
  /** diffs captured from permission requests, keyed by callID (fallback for tool diffs). */
  private permissionDiffs = new Map<string, string>()
  private lastPlanKey: string | undefined
  private statusKey: string | undefined
  private turn: Turn | undefined
  private raw: unknown

  constructor(opts: TranslatorOptions = {}) {
    // OpenCode reports real paths (macOS: /var → /private/var), so relativize against the real cwd.
    let cwd = opts.cwd
    try {
      if (cwd) cwd = realpathSync(cwd)
    } catch {
      // keep as given (tests / not yet created)
    }
    this.cwd = cwd
    this.includeRaw = opts.includeRaw ?? false
  }

  get turnActive(): boolean {
    return this.turn !== undefined
  }

  get currentTurnId(): string | undefined {
    return this.turn?.turnId
  }

  get pendingPermissionIds(): string[] {
    return [...this.pending.keys()]
  }

  setSession(id: string): void {
    this.sessionId = id
  }

  // ───────────────────────────── session-driven hooks ─────────────────────────────

  beginTurn(prompt?: string, turnId = newId("turn")): AgentEvent[] {
    this.raw = undefined
    const out: AgentEvent[] = []
    if (this.turn) return out
    this.turn = { turnId, interrupting: false, active: false }
    out.push(this.ev({ type: "turn.started", data: prompt !== undefined ? { turnId, prompt } : { turnId } }))
    this.status(out, "busy")
    return out
  }

  markInterrupting(): void {
    if (this.turn) this.turn.interrupting = true
  }

  /** Remember who answered a permission so `permission.replied` can be attributed. */
  noteReply(requestId: string, optionId: string | null): void {
    this.replies.set(requestId, optionId)
  }

  /** Close the current turn (on idle, or forced by the session after abort / disconnect). */
  endTurn(reason?: { interrupted?: boolean; stopReason?: string }): AgentEvent[] {
    const out: AgentEvent[] = []
    const t = this.turn
    if (!t) {
      this.status(out, "ready")
      return out
    }
    this.turn = undefined
    for (const [requestId] of this.pending) {
      out.push(this.ev({ type: "permission.resolved", data: { requestId, optionId: null, kind: null, by: "cancelled" } }))
    }
    this.pending.clear()
    // finalize streaming text that never got an end timestamp
    for (const [, s] of this.texts) {
      if (!s.completed && s.emitted) {
        s.completed = true
        out.push(this.ev({ type: "message.completed", data: { messageId: s.messageId, role: s.role, text: s.emitted } }))
      }
    }
    if (reason?.interrupted || t.interrupting || t.aborted) out.push(this.ev({ type: "turn.interrupted", data: { turnId: t.turnId } }))
    else {
      const stopReason = reason?.stopReason ?? (t.error ? "error" : stopReasonFor(t.finish))
      out.push(this.ev({ type: "turn.completed", data: { turnId: t.turnId, stopReason } }))
    }
    this.status(out, "ready")
    return out
  }

  // ───────────────────────────── native events ─────────────────────────────

  handle(ev: OcEvent): AgentEvent[] {
    this.raw = ev
    const out: AgentEvent[] = []
    const p = (ev.properties ?? {}) as Record<string, any>
    const sid: string | undefined = typeof p.sessionID === "string" ? p.sessionID : undefined
    const own = sid !== undefined && sid === this.sessionId
    const child = sid !== undefined && this.children.has(sid)

    switch (ev.type) {
      case "session.created":
      case "session.updated": {
        const info = p.info as OcSession | undefined
        if (info?.parentID && (info.parentID === this.sessionId || this.children.has(info.parentID)) && !this.children.has(info.id)) {
          this.children.set(info.id, this.taskCallFor(info.id))
        }
        break
      }
      case "session.status": {
        if (!own) break
        const st = p.status as SessionStatus
        if (st.type === "busy") {
          if (!this.turn) out.push(...this.beginTurn())
          else if (this.pending.size === 0) this.status(out, "busy")
          this.activity()
        } else if (st.type === "retry") {
          if (!this.turn) out.push(...this.beginTurn())
          this.activity()
          this.status(out, "busy", `retrying (attempt ${st.attempt}): ${st.message}`)
        } else if (st.type === "idle") this.idle(out)
        break
      }
      case "session.idle":
        if (own) this.idle(out)
        break
      case "session.error": {
        if (!own && sid !== undefined) break
        const err = p.error as { name?: string; data?: { message?: string } } | undefined
        if (err?.name === "MessageAbortedError") {
          if (this.turn) this.turn.aborted = true
          break
        }
        const message = err?.data?.message ?? err?.name ?? "unknown error"
        this.activity()
        if (this.turn) this.turn.error = message
        out.push(this.ev({ type: "error", data: { message, detail: err?.name, fatal: false } }))
        break
      }
      case "message.updated": {
        if (!own && !child) break
        const info = p.info as Message
        if (!info?.id) break
        if (own && !this.roles.has(info.id)) this.activity()
        this.roles.set(info.id, info.role)
        if (own && info.role === "assistant" && this.turn) {
          const a = info as AssistantMessage
          if (a.finish) this.turn.finish = a.finish
          if (a.error?.name === "MessageAbortedError") this.turn.aborted = true
          else if (a.error) this.turn.error = (a.error.data as { message?: string })?.message ?? a.error.name
        }
        break
      }
      case "message.part.updated": {
        if (!own && !child) break
        const part = p.part as Part
        if (part) this.part(out, part, own, typeof p.delta === "string" ? p.delta : undefined)
        break
      }
      case "message.part.delta": {
        if (!own) break
        const s = this.texts.get(p.partID)
        if (!s || s.completed || p.field !== "text" || typeof p.delta !== "string" || !p.delta) break
        s.emitted += p.delta
        out.push(this.ev({ type: "message.delta", data: { messageId: s.messageId, role: s.role, text: p.delta } }))
        break
      }
      case "todo.updated":
        if (own) this.plan(out, p.todos as Todo[])
        break
      case "permission.asked":
        if (own || child) this.permissionAsked(out, p as unknown as PermissionRequest)
        break
      case "permission.replied": {
        const requestId: string = p.requestID ?? p.permissionID
        if (!requestId || !this.pending.has(requestId)) break
        this.pending.delete(requestId)
        const reply = (p.reply ?? p.response) as OcReply
        const ours = this.replies.has(requestId)
        const optionId = ours ? (this.replies.get(requestId) ?? null) : reply
        this.replies.delete(requestId)
        out.push(
          this.ev({
            type: "permission.resolved",
            data: { requestId, optionId, kind: optionKindFor(reply), by: ours ? "user" : "policy" },
          }),
        )
        if (this.pending.size === 0 && this.turn) this.status(out, "busy")
        break
      }
      default:
        break
    }
    return out
  }

  private activity(): void {
    if (this.turn) this.turn.active = true
  }

  private idle(out: AgentEvent[]): void {
    // A turn that the server never acknowledged ignores idles (OpenCode can emit a duplicate
    // `session.idle` for the previous turn after we already started the next one).
    if (this.turn && !this.turn.active) return
    out.push(...this.endTurn())
  }

  // ───────────────────────────── parts ─────────────────────────────

  private part(out: AgentEvent[], part: Part, own: boolean, delta: string | undefined): void {
    switch (part.type) {
      case "text":
      case "reasoning": {
        if (!own) return // subagent chatter stays inside its tool call
        if (this.roles.get(part.messageID) === "user") return
        if (part.type === "text" && (part.synthetic || part.ignored)) return
        const role = part.type === "reasoning" ? "thought" : "assistant"
        let s = this.texts.get(part.id)
        if (!s) {
          s = { role, messageId: part.id, emitted: "", completed: false }
          this.texts.set(part.id, s)
        }
        if (s.completed) return
        const full = part.text ?? ""
        let add = ""
        if (full.startsWith(s.emitted)) add = full.slice(s.emitted.length)
        else if (delta && !s.emitted.endsWith(delta)) add = delta
        if (add) {
          s.emitted += add
          out.push(this.ev({ type: "message.delta", data: { messageId: s.messageId, role, text: add } }))
        }
        if (part.time?.end !== undefined) {
          s.completed = true
          const text = full.length >= s.emitted.length ? full : s.emitted
          if (text.trim()) out.push(this.ev({ type: "message.completed", data: { messageId: s.messageId, role, text } }))
        }
        return
      }
      case "tool":
        this.tool(out, part, own)
        return
      case "step-finish": {
        if (this.usageSeen.has(part.id)) return
        this.usageSeen.add(part.id)
        const t = part.tokens
        if (own && this.turn) this.turn.finish = part.reason
        out.push(
          this.ev({
            type: "usage.updated",
            data: {
              input: (t?.input ?? 0) + (t?.cache?.write ?? 0),
              cachedInput: t?.cache?.read ?? 0,
              output: t?.output ?? 0,
              reasoning: t?.reasoning ?? 0,
              costUsd: typeof part.cost === "number" ? part.cost : undefined,
              source: "reported",
              mode: "delta",
            },
          }),
        )
        return
      }
      case "retry":
        if (own) this.status(out, "busy", `retrying (attempt ${part.attempt}): ${part.error?.data?.message ?? "provider error"}`)
        return
      default:
        return
    }
  }

  private taskCallFor(childSessionId: string): string | undefined {
    for (const [callID, sid] of this.taskSessions) if (sid === childSessionId) return callID
    return undefined
  }

  private tool(out: AgentEvent[], part: ToolPart, own: boolean): void {
    const state = part.state
    const input = (state.input ?? {}) as Record<string, unknown>
    const meta = ("metadata" in state ? state.metadata : undefined) as Record<string, unknown> | undefined
    const toolCallId = part.callID
    const parentToolCallId = own ? undefined : this.children.get(part.sessionID)

    if (part.tool === "task" && typeof meta?.sessionId === "string") {
      this.taskSessions.set(toolCallId, meta.sessionId)
      this.children.set(meta.sessionId, toolCallId)
    }

    let st = this.tools.get(toolCallId)
    if (!st) {
      st = { announced: false }
      this.tools.set(toolCallId, st)
    }
    const status: ToolStatus =
      state.status === "pending" ? "pending" : state.status === "running" ? "in_progress" : state.status === "completed" ? "completed" : "failed"
    const hasInput = Object.keys(input).length > 0
    const title = toolTitle(part.tool, input, this.cwd)

    if (!st.announced) {
      if (state.status === "pending" && !hasInput) return // wait until the input is known
      st.announced = true
      st.status = status === "completed" || status === "failed" ? "in_progress" : status
      st.title = title
      const locations = toolLocations(part.tool, input, this.cwd)
      out.push(
        this.ev({
          type: "tool.call",
          data: {
            toolCallId,
            ...(parentToolCallId ? { parentToolCallId } : {}),
            kind: toolKind(part.tool),
            name: part.tool,
            title,
            status: st.status,
            ...(locations ? { locations } : {}),
            rawInput: input,
          },
        }),
      )
    }

    if (part.tool === "todowrite" && own && Array.isArray(input.todos)) this.plan(out, input.todos as Todo[])

    const titleChanged = title !== st.title && hasInput
    if (titleChanged) st.title = title

    if (state.status === "pending" || state.status === "running") {
      const update: Extract<AgentEvent, { type: "tool.update" }>["data"] = { toolCallId }
      let changed = false
      if (st.status !== status) {
        st.status = status
        update.status = status
        changed = true
      }
      if (titleChanged) {
        update.title = title
        changed = true
      }
      const live = typeof meta?.output === "string" ? meta.output : undefined
      if (live !== undefined && live !== (st.terminalOutput ?? "") && toolKind(part.tool) === "execute") {
        st.terminalOutput = live
        update.content = [this.terminal(toolCallId, input, live, undefined)]
        changed = true
      }
      if (changed) out.push(this.ev({ type: "tool.update", data: update }))
      return
    }

    if (st.status === "completed" || st.status === "failed") return
    st.status = status

    if (state.status === "completed") {
      const output = state.output ?? ""
      const content = this.completedContent(part, input, meta, output)
      const summary = toolSummary(part.tool, input, output, meta, content)
      out.push(
        this.ev({
          type: "tool.update",
          data: {
            toolCallId,
            status: "completed",
            ...(titleChanged ? { title } : {}),
            ...(content.length ? { content } : {}),
            ...(summary ? { summary } : {}),
            rawOutput: truncate(output),
          },
        }),
      )
      return
    }

    // error
    const error = state.status === "error" ? state.error : "tool failed"
    const content: ToolContent[] = [{ type: "text", text: error }]
    if (toolKind(part.tool) === "execute" && typeof meta?.output === "string" && meta.output) {
      content.unshift(this.terminal(toolCallId, input, meta.output, typeof meta.exit === "number" ? meta.exit : null))
    }
    out.push(
      this.ev({
        type: "tool.update",
        data: { toolCallId, status: "failed", ...(titleChanged ? { title } : {}), content, summary: error.split("\n")[0]?.slice(0, 120) },
      }),
    )
  }

  private completedContent(part: ToolPart, input: Record<string, unknown>, meta: Record<string, unknown> | undefined, output: string): ToolContent[] {
    const kind = toolKind(part.tool)
    if (isEditTool(part.tool)) return editDiffs(part.tool, input, meta, this.cwd, this.permissionDiffs.get(part.callID))
    if (kind === "execute") {
      const live = typeof meta?.output === "string" ? meta.output : output
      return [this.terminal(part.callID, input, live, typeof meta?.exit === "number" ? meta.exit : null)]
    }
    if (kind === "read" || kind === "search" || part.tool === "todowrite" || part.tool === "todoread") return []
    return output ? [{ type: "text", text: truncate(output, 4000) }] : []
  }

  private terminal(toolCallId: string, input: Record<string, unknown>, output: string, exitCode: number | null | undefined): ToolContent {
    return {
      type: "terminal",
      terminalId: toolCallId,
      ...(typeof input.command === "string" ? { command: input.command } : {}),
      output: truncate(output, 64_000),
      ...(exitCode !== undefined ? { exitCode } : {}),
    }
  }

  // ───────────────────────────── permissions / plan / status ─────────────────────────────

  private permissionAsked(out: AgentEvent[], req: PermissionRequest): void {
    if (!req?.id || this.pending.has(req.id)) return
    const callID = req.tool?.callID
    this.pending.set(req.id, callID)
    const meta = (req.metadata ?? {}) as Record<string, unknown>
    if (callID && typeof meta.diff === "string") this.permissionDiffs.set(callID, meta.diff)
    const toolTitleKnown = callID ? this.tools.get(callID)?.title : undefined
    const patterns = (req.patterns ?? []).filter(Boolean)
    const title = toolTitleKnown ?? permissionTitle(req.permission, patterns, meta)
    const detail =
      typeof meta.diff === "string" ? meta.diff : typeof meta.command === "string" ? meta.command : patterns.length ? patterns.join("\n") : undefined
    const always = (req.always ?? []).filter(Boolean)
    const options = PERMISSION_OPTIONS.map((o) =>
      o.optionId === "always" && always.length && !(always.length === 1 && always[0] === "*") ? { ...o, name: `Always allow ${always.join(", ")}` } : o,
    )
    out.push(
      this.ev({
        type: "permission.requested",
        data: {
          requestId: req.id,
          ...(callID ? { toolCallId: callID } : {}),
          title,
          kind: toolKind(req.permission),
          ...(detail ? { detail } : {}),
          options,
        },
      }),
    )
    this.status(out, "awaiting_approval", title)
  }

  private plan(out: AgentEvent[], todos: Todo[] | undefined): void {
    if (!Array.isArray(todos)) return
    type Entry = Extract<AgentEvent, { type: "plan.updated" }>["data"]["entries"][number]
    const entries = todos
      .filter((t) => t && typeof t.content === "string")
      .map((t): Entry => {
        const status: Entry["status"] =
          t.status === "in_progress" ? "in_progress" : t.status === "completed" || t.status === "cancelled" ? "completed" : "pending"
        const priority = t.priority === "high" || t.priority === "medium" || t.priority === "low" ? t.priority : undefined
        return priority ? { content: t.content, status, priority } : { content: t.content, status }
      })
    const key = JSON.stringify(entries)
    if (key === this.lastPlanKey) return
    this.lastPlanKey = key
    out.push(this.ev({ type: "plan.updated", data: { entries } }))
  }

  private status(out: AgentEvent[], status: AgentStatus, detail?: string): void {
    const key = `${status}|${detail ?? ""}`
    if (key === this.statusKey) return
    this.statusKey = key
    out.push(this.ev({ type: "agent.status", data: detail ? { status, detail } : { status } }))
  }

  private ev(e: AgentEvent): AgentEvent {
    if (this.includeRaw && this.raw !== undefined) return { ...e, raw: this.raw }
    return e
  }
}

function permissionTitle(permission: string, patterns: string[], meta: Record<string, unknown>): string {
  switch (permission) {
    case "bash":
      return `Bash(${typeof meta.command === "string" ? meta.command : patterns.join(" ")})`
    case "edit":
      return `Update(${patterns.join(", ")})`
    case "webfetch":
      return `Fetch(${typeof meta.url === "string" ? meta.url : patterns.join(", ")})`
    case "external_directory":
      return `Access outside workspace(${patterns.join(", ")})`
    case "doom_loop":
      return "Repeated tool call (doom loop)"
    default:
      return patterns.length && !(patterns.length === 1 && patterns[0] === "*") ? `${permission}(${patterns.join(", ")})` : permission
  }
}
