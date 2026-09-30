/**
 * Claude Agent SDK message stream → BEP events.
 *
 * Pure (no I/O): the session feeds it SDK messages plus host-side actions (prompts, interrupts,
 * permission decisions) and forwards the returned events. Replay tests drive it from JSONL
 * fixtures recorded with scripts/record.ts.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import type { AgentEvent, AgentStatus, PermissionOption, ToolContent, ToolKind } from "@batonsh/protocol"
import { newId } from "@batonsh/protocol"
import { bashContent, editDiff, resultText, todosToPlan, toolKind, toolLocations, toolSummary, toolTitle } from "./tools.ts"

type Input = Record<string, unknown>
type Block = { type: string } & Input

interface ToolState {
  name: string
  input: Input
  title: string
  kind: ToolKind
  parent?: string
  started: boolean
  done: boolean
}

interface Turn {
  turnId: string
  /** Client uuids of the user messages this turn has consumed (or was started for). */
  uuids: Set<string>
}

export interface TranslatorOptions {
  cwd: string
  /** id generator (overridable for deterministic tests). */
  id?: (prefix: string) => string
  /** File content captured before a Write/Edit ran (PreToolUse snapshot). */
  snapshot?: (toolUseId: string) => string | null | undefined
}

const TEXT_TRUNCATE = 4000

export class ClaudeTranslator {
  sessionId?: string
  model?: string
  version?: string
  status: AgentStatus = "starting"
  private turn?: Turn
  /** Sent user messages not yet consumed by a turn: uuid → text, in send order. */
  private pending = new Map<string, string>()
  private interrupting = false
  private tools = new Map<string, ToolState>()
  /** Stream block index → BEP message id, for the message currently streaming. */
  private streamBlocks = new Map<number, { messageId: string; role: "assistant" | "thought" }>()
  private streamCounters = new Map<string, { t: number; r: number }>()
  private fullCounters = new Map<string, { t: number; r: number }>()
  private streamMsgId?: string
  /** Fallback accumulation when results carry no modelUsage. */
  private usageAcc = { input: 0, cachedInput: 0, output: 0, reasoning: 0 }
  private readonly id: (prefix: string) => string

  constructor(private opts: TranslatorOptions) {
    this.id = opts.id ?? newId
  }

  get busy(): boolean {
    return this.turn !== undefined
  }

  get currentTurnId(): string | undefined {
    return this.turn?.turnId
  }

  tool(toolUseId: string): Readonly<ToolState> | undefined {
    return this.tools.get(toolUseId)
  }

  setStatus(status: AgentStatus, detail?: string): AgentEvent[] {
    if (this.status === status) return []
    this.status = status
    return [{ type: "agent.status", data: detail ? { status, detail } : { status } }]
  }

  // ───────────────────────── host-side actions ─────────────────────────

  /** A user message was pushed into the SDK input stream. Starts a turn when idle. */
  userPrompt(uuid: string, text: string): AgentEvent[] {
    const out: AgentEvent[] = [{ type: "message.completed", data: { messageId: uuid, role: "user", text } }]
    if (this.turn) {
      // Claude Code queues it: either folded into the running turn or run as the next one.
      this.pending.set(uuid, text)
      return out
    }
    return [...out, ...this.startTurn(uuid, text)]
  }

  private startTurn(uuid: string, text: string): AgentEvent[] {
    this.turn = { turnId: this.id("turn"), uuids: new Set([uuid]) }
    this.pending.delete(uuid)
    return [{ type: "turn.started", data: { turnId: this.turn.turnId, prompt: text } }, ...this.setStatus("busy")]
  }

  markInterrupting(): void {
    if (this.turn) this.interrupting = true
  }

  get isInterrupting(): boolean {
    return this.interrupting
  }

  /** Interrupt acknowledged but no result arrived: close the turn ourselves. */
  forceInterrupted(): AgentEvent[] {
    if (!this.turn || !this.interrupting) return []
    return this.endTurn(undefined)
  }

  /**
   * The CLI died: end the running turn as failed (`turn.interrupted` when an interrupt was
   * in flight) without starting queued prompts or reporting ready.
   */
  failTurn(): AgentEvent[] {
    if (!this.turn) return []
    this.pending.clear()
    return this.endTurn("error").filter((e) => e.type !== "agent.status")
  }

  toolStarted(toolUseId: string): AgentEvent[] {
    const t = this.tools.get(toolUseId)
    if (!t || t.started || t.done) return []
    t.started = true
    return [{ type: "tool.update", data: { toolCallId: toolUseId, status: "in_progress" } }]
  }

  permissionRequested(
    requestId: string,
    toolName: string,
    input: Input,
    toolUseId: string | undefined,
    options: PermissionOption[],
    detail?: string,
  ): AgentEvent[] {
    const known = toolUseId ? this.tools.get(toolUseId) : undefined
    return [
      {
        type: "permission.requested",
        data: {
          requestId,
          ...(toolUseId ? { toolCallId: toolUseId } : {}),
          title: known?.title ?? toolTitle(toolName, input, this.opts.cwd),
          kind: known?.kind ?? toolKind(toolName),
          ...(detail ? { detail } : {}),
          options,
        },
      },
      ...this.setStatus("awaiting_approval"),
    ]
  }

  // ───────────────────────── SDK messages ─────────────────────────

  handle(msg: SDKMessage | { type: string; [k: string]: unknown }): AgentEvent[] {
    const m = msg as Input & { type: string }
    switch (m.type) {
      case "system":
        return this.onSystem(m)
      case "stream_event":
        return this.onStream(m)
      case "assistant":
        return this.onAssistant(m)
      case "user":
        return this.onUser(m)
      case "result":
        return this.onResult(m)
      case "tool_progress":
        return typeof m.tool_use_id === "string" ? this.toolStarted(m.tool_use_id) : []
      case "command_lifecycle":
        return this.onLifecycle(m)
      default:
        return []
    }
  }

  private consume(uuids: unknown): void {
    if (!this.turn || !Array.isArray(uuids)) return
    for (const u of uuids)
      if (typeof u === "string") {
        this.turn.uuids.add(u)
        this.pending.delete(u)
      }
  }

  private onLifecycle(m: Input): AgentEvent[] {
    const uuid = typeof m.command_uuid === "string" ? m.command_uuid : undefined
    if (!uuid) return []
    if (m.state === "cancelled") {
      this.pending.delete(uuid)
      return []
    }
    // A queued send started executing while we thought we were idle (race with a result).
    if (m.state === "started" && !this.turn && this.pending.has(uuid)) return this.startTurn(uuid, this.pending.get(uuid) ?? "")
    return []
  }

  private onSystem(m: Input): AgentEvent[] {
    const out: AgentEvent[] = []
    if (m.subtype === "init") {
      const sid = String(m.session_id ?? "")
      if (sid && sid !== this.sessionId) {
        this.sessionId = sid
        out.push({ type: "agent.session", data: { sessionId: sid } })
      }
      const model = typeof m.model === "string" ? m.model : undefined
      const version = typeof m.claude_code_version === "string" ? m.claude_code_version : undefined
      if (model !== this.model || version !== this.version) {
        this.model = model
        this.version = version
        out.push({ type: "agent.updated", data: { ...(model ? { model } : {}), ...(version ? { version } : {}) } })
      }
      if (this.status === "starting") out.push(...this.setStatus(this.turn ? "busy" : "ready"))
    } else if (m.subtype === "status") {
      if (m.status === "compacting") out.push({ type: "log", data: { level: "info", message: "compacting context" } })
    } else if (m.subtype === "compact_boundary") {
      out.push({ type: "log", data: { level: "info", message: "context compacted" } })
    } else if (m.subtype === "api_retry") {
      out.push({
        type: "log",
        data: { level: "warn", message: `API retry ${m.attempt ?? "?"}/${m.max_retries ?? "?"}${m.error ? `: ${String(m.error)}` : ""}` },
      })
    }
    // session_state_changed / task_* / hook_* frames: turn state is tracked from prompts and results.
    if (Array.isArray(m.user_message_uuids)) this.consume(m.user_message_uuids)
    return out
  }

  private counters(map: Map<string, { t: number; r: number }>, id: string) {
    let c = map.get(id)
    if (!c) {
      c = { t: 0, r: 0 }
      map.set(id, c)
    }
    return c
  }

  private onStream(m: Input): AgentEvent[] {
    // Subagent text stays inside the subagent; only its tool calls are surfaced (nested).
    if (m.parent_tool_use_id) return []
    this.consume(m.user_message_uuids)
    const ev = m.event as Input & { type: string }
    switch (ev.type) {
      case "message_start": {
        const msg = ev.message as Input
        this.streamMsgId = String(msg.id ?? this.id("msg"))
        this.streamBlocks.clear()
        return []
      }
      case "content_block_start": {
        const block = ev.content_block as Block
        const idx = Number(ev.index)
        const msgId = this.streamMsgId ?? "msg"
        const c = this.counters(this.streamCounters, msgId)
        if (block.type === "text") this.streamBlocks.set(idx, { messageId: `${msgId}:t${c.t++}`, role: "assistant" })
        else if (block.type === "thinking") this.streamBlocks.set(idx, { messageId: `${msgId}:r${c.r++}`, role: "thought" })
        return []
      }
      case "content_block_delta": {
        const target = this.streamBlocks.get(Number(ev.index))
        const delta = ev.delta as Input
        if (!target) return []
        const text = delta.type === "text_delta" ? delta.text : delta.type === "thinking_delta" ? delta.thinking : undefined
        if (typeof text !== "string" || text === "") return []
        return [{ type: "message.delta", data: { messageId: target.messageId, role: target.role, text } }]
      }
      default:
        return []
    }
  }

  private onAssistant(m: Input): AgentEvent[] {
    const out: AgentEvent[] = []
    const msg = m.message as Input
    const parent = typeof m.parent_tool_use_id === "string" ? m.parent_tool_use_id : undefined
    if (!parent) this.consume(m.user_message_uuids)
    const msgId = String(msg.id ?? this.id("msg"))
    const c = this.counters(this.fullCounters, msgId)
    const content = Array.isArray(msg.content) ? (msg.content as Block[]) : []
    for (const block of content) {
      if (block.type === "text" && !parent) {
        out.push({ type: "message.completed", data: { messageId: `${msgId}:t${c.t++}`, role: "assistant", text: String(block.text ?? "") } })
      } else if (block.type === "thinking" && !parent) {
        const text = String(block.thinking ?? "")
        const messageId = `${msgId}:r${c.r++}`
        if (text) out.push({ type: "message.completed", data: { messageId, role: "thought", text } })
      } else if (block.type === "tool_use") {
        out.push(...this.onToolUse(block, parent))
      }
    }
    if (typeof m.error === "string" && !parent) {
      const text = content
        .filter((b) => b.type === "text")
        .map((b) => String(b.text ?? ""))
        .join("\n")
      out.push({ type: "error", data: { message: text || `Claude API error: ${m.error}`, detail: m.error } })
    }
    return out
  }

  private onToolUse(block: Block, parent: string | undefined): AgentEvent[] {
    const id = String(block.id)
    if (this.tools.has(id)) return []
    const name = String(block.name ?? "tool")
    const input = (block.input && typeof block.input === "object" ? block.input : {}) as Input
    const t: ToolState = {
      name,
      input,
      title: toolTitle(name, input, this.opts.cwd),
      kind: toolKind(name),
      ...(parent ? { parent } : {}),
      started: false,
      done: false,
    }
    this.tools.set(id, t)
    const locations = toolLocations(input)
    const out: AgentEvent[] = [
      {
        type: "tool.call",
        data: {
          toolCallId: id,
          ...(parent ? { parentToolCallId: parent } : {}),
          kind: t.kind,
          name,
          title: t.title,
          status: "pending",
          ...(locations ? { locations } : {}),
          rawInput: input,
        },
      },
    ]
    if (name === "TodoWrite" && !parent) {
      const entries = todosToPlan(input)
      if (entries) out.push({ type: "plan.updated", data: { entries } })
    }
    return out
  }

  private onUser(m: Input): AgentEvent[] {
    if (m.isReplay) return []
    const msg = m.message as Input
    if (!Array.isArray(msg?.content)) return []
    const results = (msg.content as Block[]).filter((b) => b.type === "tool_result")
    const out: AgentEvent[] = []
    for (const r of results) {
      const id = String(r.tool_use_id)
      const t = this.tools.get(id)
      if (!t || t.done) continue
      t.done = true
      const info = {
        name: t.name,
        input: t.input,
        content: r.content,
        isError: r.is_error === true,
        // tool_use_result belongs to the message's (single) tool result.
        structured: results.length === 1 ? m.tool_use_result : undefined,
        before: this.opts.snapshot?.(id),
      }
      const content: ToolContent[] = []
      const diff = info.isError ? undefined : editDiff(info)
      if (diff) content.push(diff)
      const term = bashContent(info)
      if (term) {
        if (info.isError) {
          const code = /^Exit code (\d+)/m.exec(term.type === "terminal" ? term.output : "")
          if (term.type === "terminal") term.exitCode = code ? Number(code[1]) : null
        }
        content.push(term)
      }
      if (!diff && !term && t.kind !== "read" && t.kind !== "search" && t.name !== "TodoWrite") {
        const text = resultText(r.content)
        if (text) content.push({ type: "text", text: text.length > TEXT_TRUNCATE ? `${text.slice(0, TEXT_TRUNCATE)}…` : text })
      }
      out.push({
        type: "tool.update",
        data: {
          toolCallId: id,
          status: info.isError ? "failed" : "completed",
          summary: toolSummary(info, diff),
          ...(content.length ? { content } : {}),
          rawOutput: info.structured ?? r.content,
        },
      })
    }
    return out
  }

  private onResult(m: Input): AgentEvent[] {
    const out: AgentEvent[] = []
    const usage = this.usageFrom(m)
    if (usage) out.push({ type: "usage.updated", data: usage })
    if (!this.turn) {
      // A result with no turn we know of (e.g. a turn started by the CLI itself): still settle.
      this.pending.clear()
      return [...out, ...this.setStatus("ready")]
    }
    this.consume(m.user_message_uuids)
    if (typeof m.user_message_uuid === "string") this.consume([m.user_message_uuid])
    // queued_turn_count is authoritative for "more turns follow" when present.
    if (m.queued_turn_count === 0) this.pending.clear()
    return [...out, ...this.endTurn(stopReason(m))]
  }

  private endTurn(reason: string | undefined): AgentEvent[] {
    const out: AgentEvent[] = []
    const turn = this.turn
    if (!turn) return out
    // Close tool calls that never got a result (interrupt, denial + abort, crash).
    for (const [id, t] of this.tools)
      if (!t.done) {
        t.done = true
        out.push({ type: "tool.update", data: { toolCallId: id, status: "failed", summary: this.interrupting ? "Interrupted" : "No result" } })
      }
    if (this.interrupting) out.push({ type: "turn.interrupted", data: { turnId: turn.turnId } })
    else out.push({ type: "turn.completed", data: { turnId: turn.turnId, ...(reason ? { stopReason: reason } : {}) } })
    for (const [id, t] of this.tools) if (t.done) this.tools.delete(id)
    this.interrupting = false
    this.turn = undefined
    this.streamBlocks.clear()
    const next = this.pending.entries().next()
    if (!next.done) out.push(...this.startTurn(next.value[0], next.value[1]))
    else out.push(...this.setStatus("ready"))
    return out
  }

  private usageFrom(m: Input): Extract<AgentEvent, { type: "usage.updated" }>["data"] | undefined {
    const cost = typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined
    const mu = (m.modelUsage ?? {}) as Record<string, Input>
    const models = Object.values(mu)
    const n = (v: unknown) => (typeof v === "number" ? v : 0)
    if (models.length) {
      // modelUsage is cumulative for the whole query() (all models, incl. subagents).
      let input = 0
      let cached = 0
      let output = 0
      let reasoning = 0
      for (const u of models) {
        cached += n(u.cacheReadInputTokens)
        input += n(u.inputTokens) + n(u.cacheCreationInputTokens) + n(u.cacheReadInputTokens)
        output += n(u.outputTokens)
        reasoning += n(u.thinkingTokens)
      }
      return { input, cachedInput: cached, output, reasoning, ...(cost !== undefined ? { costUsd: cost } : {}), source: "reported", mode: "cumulative" }
    }
    // Older CLIs: per-turn main-loop usage only; accumulate ourselves.
    const u = m.usage as Input | undefined
    if (!u) return undefined
    const turnIn = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens)
    if (turnIn === 0 && n(u.output_tokens) === 0 && !cost) return undefined
    this.usageAcc.input += turnIn
    this.usageAcc.cachedInput += n(u.cache_read_input_tokens)
    this.usageAcc.output += n(u.output_tokens)
    return { ...this.usageAcc, ...(cost !== undefined ? { costUsd: cost } : {}), source: "reported", mode: "cumulative" }
  }
}

function stopReason(m: Input): string {
  switch (m.subtype) {
    case "success":
      if (m.is_error) return "error"
      return typeof m.stop_reason === "string" && m.stop_reason ? m.stop_reason : "end_turn"
    case "error_max_turns":
      return "max_turns"
    case "error_max_budget_usd":
      return "max_budget"
    case "error_max_structured_output_retries":
      return "structured_output_retries"
    default:
      return "error"
  }
}
