/**
 * Codex app-server → BEP translation.
 *
 * `CodexTranslator` is fed decoded JSON-RPC traffic (notifications and server→client requests)
 * and emits BEP events. It owns no I/O: permission requests are recorded as pending and the
 * session writes the JSON-RPC response that `resolvePermission()` computes. This keeps the whole
 * mapping replayable from recorded fixtures.
 */
import {
  type AgentEvent,
  type AgentStatus,
  DEFAULT_PERMISSION_OPTIONS,
  diffLines,
  diffStat,
  newId,
  type PermissionOption,
  type PermissionOptionKind,
  parseUnifiedDiff,
  type ToolContent,
  type ToolKind,
} from "@batonsh/protocol"
import type { ReviewDecision } from "./generated/ReviewDecision.ts"
import type { ServerNotification } from "./generated/ServerNotification.ts"
import type { ServerRequest } from "./generated/ServerRequest.ts"
import type { CommandExecutionApprovalDecision } from "./generated/v2/CommandExecutionApprovalDecision.ts"
import type { CommandExecutionRequestApprovalParams } from "./generated/v2/CommandExecutionRequestApprovalParams.ts"
import type { FileChangeApprovalDecision } from "./generated/v2/FileChangeApprovalDecision.ts"
import type { FileChangeRequestApprovalParams } from "./generated/v2/FileChangeRequestApprovalParams.ts"
import type { FileUpdateChange } from "./generated/v2/FileUpdateChange.ts"
import type { McpServerElicitationRequestParams } from "./generated/v2/McpServerElicitationRequestParams.ts"
import type { McpServerElicitationRequestResponse } from "./generated/v2/McpServerElicitationRequestResponse.ts"
import type { PermissionsRequestApprovalParams } from "./generated/v2/PermissionsRequestApprovalParams.ts"
import type { PermissionsRequestApprovalResponse } from "./generated/v2/PermissionsRequestApprovalResponse.ts"
import type { ThreadItem } from "./generated/v2/ThreadItem.ts"
import type { ToolRequestUserInputParams } from "./generated/v2/ToolRequestUserInputParams.ts"
import type { ToolRequestUserInputResponse } from "./generated/v2/ToolRequestUserInputResponse.ts"
import type { Turn } from "./generated/v2/Turn.ts"

type RpcId = number | string
type ToolCallData = Extract<AgentEvent, { type: "tool.call" }>["data"]
type DiffContent = Extract<ToolContent, { type: "diff" }>
type Role = "assistant" | "thought"

/** Notification params keyed by method, straight from the generated protocol types. */
type NotificationParams<M extends ServerNotification["method"]> = Extract<ServerNotification, { method: M }>["params"]

interface PendingPermission {
  requestId: string
  rpcId: RpcId
  method: ServerRequest["method"]
  params: unknown
  options: PermissionOption[]
}

interface OpenMessage {
  role: Role
  text: string
}

interface OpenTool {
  name: string
  kind: ToolKind
  title: string
  command?: string
  output: string
}

/** Keep only the tail of very long command output in events. */
const MAX_OUTPUT = 64 * 1024

export interface TranslatorOptions {
  /** Attach the native message to every emitted event (`AgentEvent.raw`). */
  keepRaw?: boolean
  log?: (level: "debug" | "info" | "warn" | "error", message: string) => void
}

export class CodexTranslator {
  threadId: string | undefined
  /** Turn currently running (from `turn/started` until `turn/completed`). */
  activeTurnId: string | undefined
  /** Called after a turn has fully ended (any status). */
  onTurnEnded?: (turnId: string, status: Turn["status"]) => void

  private status: AgentStatus | undefined
  private nextPrompt: string | undefined
  private messages = new Map<string, OpenMessage>()
  private tools = new Map<string, OpenTool>()
  private pending = new Map<string, PendingPermission>()
  private byRpcId = new Map<RpcId, string>()
  private currentRaw: unknown
  /** True once one of our turns has started (usage before that belongs to earlier sessions). */
  private sawTurn = false
  /**
   * Thread token totals that predate this session (resume/fork report the thread's lifetime
   * totals): subtracted so `usage.updated` only counts what this session spent.
   */
  private usageOffset: TokenTotals | undefined

  constructor(
    private readonly sink: (e: AgentEvent) => void,
    private readonly opts: TranslatorOptions = {},
  ) {}

  // ───────────────────────────── outward helpers ─────────────────────────────

  private emit(e: AgentEvent): void {
    if (this.opts.keepRaw && this.currentRaw !== undefined) e.raw = this.currentRaw
    this.sink(e)
  }

  private log(level: "debug" | "info" | "warn" | "error", message: string): void {
    this.opts.log?.(level, message)
  }

  setStatus(status: AgentStatus, detail?: string): void {
    if (this.status === status && !detail) return
    this.status = status
    this.emit({ type: "agent.status", data: detail ? { status, detail } : { status } })
  }

  /** Record the native thread id (emits `agent.session` once per id). */
  setThread(threadId: string): void {
    if (this.threadId === threadId) return
    this.threadId = threadId
    this.emit({ type: "agent.session", data: { sessionId: threadId } })
  }

  /** Text of the prompt that will start the next turn (shown on `turn.started`). */
  notePrompt(text: string): void {
    this.nextPrompt = text
  }

  get pendingPermissionCount(): number {
    return this.pending.size
  }

  // ───────────────────────────── notifications ─────────────────────────────

  /**
   * True when a notification belongs to a different thread than ours (e.g. a sub-agent's child
   * thread): those must not drive our turn state.
   */
  isForeign(params: unknown): boolean {
    if (!this.threadId || !params || typeof params !== "object") return false
    const tid = (params as { threadId?: unknown }).threadId
    return typeof tid === "string" && tid !== this.threadId
  }

  notification(method: string, params: unknown, raw?: unknown): void {
    if (this.isForeign(params)) {
      this.log("debug", `codex: ignored ${method} for another thread`)
      return
    }
    this.currentRaw = raw
    try {
      this.dispatch(method, params)
    } finally {
      this.currentRaw = undefined
    }
  }

  private dispatch(method: string, params: unknown) {
    switch (method) {
      case "thread/started": {
        // Only the first thread is ours; later ones are sub-agent / child threads.
        const id = (params as NotificationParams<"thread/started">).thread.id
        if (this.threadId && id !== this.threadId) {
          this.log("debug", `codex: child thread ${id} started`)
          return
        }
        return this.setThread(id)
      }
      case "thread/status/changed": {
        const p = params as NotificationParams<"thread/status/changed">
        if (p.status.type === "systemError") this.setStatus("error", "codex thread entered systemError")
        return
      }
      case "turn/started":
        return this.turnStarted((params as NotificationParams<"turn/started">).turn)
      case "turn/completed":
        return this.turnCompleted((params as NotificationParams<"turn/completed">).turn)
      case "item/started":
        return this.itemStarted((params as NotificationParams<"item/started">).item)
      case "item/completed":
        return this.itemCompleted((params as NotificationParams<"item/completed">).item)
      case "item/agentMessage/delta": {
        const p = params as NotificationParams<"item/agentMessage/delta">
        return this.messageDelta(p.itemId, "assistant", p.delta)
      }
      case "item/plan/delta": {
        const p = params as NotificationParams<"item/plan/delta">
        return this.messageDelta(p.itemId, "assistant", p.delta)
      }
      case "item/reasoning/summaryTextDelta": {
        const p = params as NotificationParams<"item/reasoning/summaryTextDelta">
        return this.messageDelta(p.itemId, "thought", p.delta)
      }
      case "item/reasoning/summaryPartAdded": {
        // Separate consecutive summary sections like the TUI does.
        const p = params as NotificationParams<"item/reasoning/summaryPartAdded">
        if (p.summaryIndex > 0 && this.messages.get(p.itemId)?.text) this.messageDelta(p.itemId, "thought", "\n\n")
        return
      }
      case "item/reasoning/textDelta": {
        // Raw reasoning content (only some providers send it): its own thought stream.
        const p = params as NotificationParams<"item/reasoning/textDelta">
        return this.messageDelta(`${p.itemId}:raw`, "thought", p.delta)
      }
      case "item/commandExecution/outputDelta": {
        const p = params as NotificationParams<"item/commandExecution/outputDelta">
        return this.commandOutput(p.itemId, p.delta)
      }
      case "item/fileChange/patchUpdated": {
        const p = params as NotificationParams<"item/fileChange/patchUpdated">
        if (!this.tools.has(p.itemId)) return
        return this.emit({ type: "tool.update", data: { toolCallId: p.itemId, content: p.changes.map(changeContent) } })
      }
      case "item/mcpToolCall/progress": {
        const p = params as NotificationParams<"item/mcpToolCall/progress">
        return this.emit({ type: "tool.update", data: { toolCallId: p.itemId, summary: p.message } })
      }
      case "turn/plan/updated": {
        const p = params as NotificationParams<"turn/plan/updated">
        return this.emit({
          type: "plan.updated",
          data: {
            entries: p.plan.map((s) => ({
              content: s.step,
              status: s.status === "inProgress" ? ("in_progress" as const) : s.status,
            })),
          },
        })
      }
      case "thread/tokenUsage/updated": {
        // Codex reports OpenAI-style counts where inputTokens *includes* cached tokens. BEP keeps
        // them disjoint (input = uncached input) so totals add up and cache pricing can apply.
        const usage = (params as NotificationParams<"thread/tokenUsage/updated">).tokenUsage
        const total = totals(usage.total)
        if (!this.sawTurn) {
          // Replayed lifetime totals of a resumed/forked thread: remember them as the baseline.
          this.usageOffset = total
          return
        }
        // No baseline seen before our first turn: the thread's prior total is this total minus
        // the call that produced it.
        if (!this.usageOffset) this.usageOffset = subTotals(total, totals(usage.last))
        const t = subTotals(total, this.usageOffset)
        return this.emit({
          type: "usage.updated",
          data: {
            input: Math.max(0, t.input - t.cached),
            cachedInput: t.cached,
            output: t.output,
            reasoning: t.reasoning,
            source: "reported",
            mode: "cumulative",
          },
        })
      }
      case "error": {
        const p = params as NotificationParams<"error">
        if (p.willRetry) {
          this.log("warn", `codex will retry: ${p.error.message}`)
          return
        }
        return this.emit({
          type: "error",
          data: { message: p.error.message, detail: p.error.additionalDetails ?? undefined },
        })
      }
      case "serverRequest/resolved": {
        // Codex resolved one of its own requests (e.g. the turn was interrupted).
        const p = params as NotificationParams<"serverRequest/resolved">
        const requestId = this.byRpcId.get(p.requestId)
        if (requestId) this.dropPending(requestId, "cancelled")
        return
      }
      case "warning":
      case "configWarning":
      case "deprecationNotice":
      case "guardianWarning": {
        const msg = (params as { message?: string; summary?: string })?.message ?? (params as { summary?: string })?.summary
        this.log("warn", `codex ${method}: ${msg ?? JSON.stringify(params)}`)
        return
      }
      case "thread/compacted":
        this.log("info", "codex compacted the thread context")
        return
      default:
        this.log("debug", `codex: ignored notification ${method}`)
    }
  }

  // ───────────────────────────── turns ─────────────────────────────

  private turnStarted(turn: Turn): void {
    this.sawTurn = true
    this.activeTurnId = turn.id
    const prompt = this.nextPrompt
    this.nextPrompt = undefined
    this.emit({ type: "turn.started", data: prompt === undefined ? { turnId: turn.id } : { turnId: turn.id, prompt } })
    this.setStatus("busy")
  }

  private turnCompleted(turn: Turn): void {
    // Close anything codex left open (it may skip item/completed on interrupt).
    for (const [id, m] of this.messages) this.emit({ type: "message.completed", data: { messageId: id, role: m.role, text: m.text } })
    this.messages.clear()
    for (const id of this.tools.keys()) this.emit({ type: "tool.update", data: { toolCallId: id, status: "failed", summary: "Interrupted" } })
    this.tools.clear()
    for (const id of [...this.pending.keys()]) this.dropPending(id, "cancelled")

    // an interrupted turn ends with turn.interrupted alone (it is the terminal event, as in every adapter)
    if (turn.status === "interrupted") {
      this.emit({ type: "turn.interrupted", data: { turnId: turn.id } })
    } else if (turn.status === "failed") {
      this.emit({
        type: "error",
        data: { message: turn.error?.message ?? "turn failed", detail: turn.error?.additionalDetails ?? undefined },
      })
      this.emit({ type: "turn.completed", data: { turnId: turn.id, stopReason: "error" } })
    } else {
      this.emit({ type: "turn.completed", data: { turnId: turn.id, stopReason: "end_turn" } })
    }
    if (this.activeTurnId === turn.id) this.activeTurnId = undefined
    this.setStatus("ready")
    this.onTurnEnded?.(turn.id, turn.status)
  }

  /**
   * The app-server went away mid-turn: close what is open and report the turn as ended
   * (no status change / onTurnEnded — the session is going down).
   */
  failTurn(stopReason: "error" | "cancelled"): void {
    const turnId = this.activeTurnId
    if (!turnId) return
    for (const [id, m] of this.messages) this.emit({ type: "message.completed", data: { messageId: id, role: m.role, text: m.text } })
    this.messages.clear()
    for (const id of this.tools.keys()) this.emit({ type: "tool.update", data: { toolCallId: id, status: "failed", summary: "Agent exited" } })
    this.tools.clear()
    for (const id of [...this.pending.keys()]) this.dropPending(id, "cancelled")
    if (stopReason === "cancelled") this.emit({ type: "turn.interrupted", data: { turnId } })
    else this.emit({ type: "turn.completed", data: { turnId, stopReason } })
    this.activeTurnId = undefined
  }

  // ───────────────────────────── items ─────────────────────────────

  private messageDelta(id: string, role: Role, delta: string): void {
    if (!delta) return
    let m = this.messages.get(id)
    if (!m) {
      m = { role, text: "" }
      this.messages.set(id, m)
    }
    m.text += delta
    this.emit({ type: "message.delta", data: { messageId: id, role, text: delta } })
  }

  private completeMessage(id: string, role: Role, finalText: string): void {
    const open = this.messages.get(id)
    this.messages.delete(id)
    const text = finalText || open?.text || ""
    if (!text && !open) return
    this.emit({ type: "message.completed", data: { messageId: id, role, text } })
  }

  private itemStarted(item: ThreadItem): void {
    const call = toolCall(item)
    if (!call) return
    this.tools.set(item.id, {
      name: call.name,
      kind: call.kind,
      title: call.title,
      command: item.type === "commandExecution" ? call.title : undefined,
      output: "",
    })
    this.emit({ type: "tool.call", data: call })
    if (item.type === "fileChange" && item.changes.length) {
      this.emit({ type: "tool.update", data: { toolCallId: item.id, content: item.changes.map(changeContent) } })
    }
  }

  private itemCompleted(item: ThreadItem) {
    switch (item.type) {
      case "agentMessage":
      case "plan":
        return this.completeMessage(item.id, "assistant", item.text)
      case "reasoning": {
        if (this.messages.has(`${item.id}:raw`) || item.content.length) this.completeMessage(`${item.id}:raw`, "thought", item.content.join("\n\n"))
        return this.completeMessage(item.id, "thought", item.summary.join("\n\n"))
      }
      case "userMessage":
      case "hookPrompt":
      case "contextCompaction":
      case "enteredReviewMode":
      case "exitedReviewMode":
        return
    }
    // Tool-like items: make sure a tool.call exists (some only arrive completed), then finish it.
    if (!this.tools.has(item.id)) {
      const call = toolCall(item)
      if (!call) {
        this.log("debug", `codex: ignored item type ${item.type}`)
        return
      }
      this.emit({ type: "tool.call", data: call })
    }
    this.tools.delete(item.id)
    const update = toolResult(item)
    if (update) this.emit({ type: "tool.update", data: update })
  }

  private commandOutput(itemId: string, delta: string): void {
    const t = this.tools.get(itemId)
    if (!t) return
    t.output += delta
    if (t.output.length > MAX_OUTPUT * 2) t.output = t.output.slice(-MAX_OUTPUT)
    this.emit({
      type: "tool.update",
      data: {
        toolCallId: itemId,
        status: "in_progress",
        content: [{ type: "terminal", terminalId: itemId, command: t.command, output: tail(t.output) }],
      },
    })
  }

  // ───────────────────────────── permissions ─────────────────────────────

  /**
   * Handle a server→client request. Returns `{ requestId }` when it became a pending BEP
   * permission (answer later via `resolvePermission`), or undefined when unsupported.
   */
  serverRequest(rpcId: RpcId, method: string, params: unknown, raw?: unknown): { requestId: string } | undefined {
    this.currentRaw = raw
    try {
      const req = this.describeRequest(method, params)
      if (!req) return undefined
      // unique across agents: every Codex process numbers its requests from 1, and the inbox holds
      // all agents' requests together (a per-process counter let one agent's request replace another's)
      const requestId = newId("codex-perm")
      this.pending.set(requestId, { requestId, rpcId, method: method as ServerRequest["method"], params, options: req.options })
      this.byRpcId.set(rpcId, requestId)
      this.emit({
        type: "permission.requested",
        data: {
          requestId,
          toolCallId: req.toolCallId,
          title: req.title,
          kind: req.kind,
          detail: req.detail,
          options: req.options,
        },
      })
      this.setStatus("awaiting_approval")
      return { requestId }
    } finally {
      this.currentRaw = undefined
    }
  }

  private describeRequest(
    method: string,
    params: unknown,
  ): { title: string; kind?: ToolKind; toolCallId?: string; detail?: string; options: PermissionOption[] } | undefined {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const p = params as CommandExecutionRequestApprovalParams
        const cmd = p.command ? unwrapShell(p.command) : (this.tools.get(p.itemId)?.title ?? "command")
        const detail = [
          p.reason,
          p.networkApprovalContext ? `network access: ${p.networkApprovalContext.host}` : undefined,
          p.cwd ? `cwd: ${p.cwd}` : undefined,
        ]
          .filter(Boolean)
          .join("\n")
        return {
          title: p.kind === "writeStdin" ? `Send input to ${cmd}` : `Run ${cmd}`,
          kind: "execute",
          toolCallId: p.itemId,
          detail: detail || undefined,
          options: DEFAULT_PERMISSION_OPTIONS,
        }
      }
      case "item/fileChange/requestApproval": {
        const p = params as FileChangeRequestApprovalParams
        const t = this.tools.get(p.itemId)
        const detail = [p.reason, p.grantRoot ? `grant write access to ${p.grantRoot}` : undefined].filter(Boolean).join("\n")
        return {
          title: t?.title ?? "Apply file changes",
          kind: "edit",
          toolCallId: p.itemId,
          detail: detail || undefined,
          options: DEFAULT_PERMISSION_OPTIONS,
        }
      }
      case "item/permissions/requestApproval": {
        const p = params as PermissionsRequestApprovalParams
        const parts: string[] = []
        if (p.permissions.network?.enabled) parts.push("network access")
        const fs = p.permissions.fileSystem
        if (fs?.write?.length) parts.push(`write ${fs.write.join(", ")}`)
        if (fs?.read?.length) parts.push(`read ${fs.read.join(", ")}`)
        return {
          title: `Grant ${parts.length ? parts.join("; ") : "additional permissions"}`,
          kind: "other",
          toolCallId: p.itemId,
          detail: p.reason ?? undefined,
          options: [
            { optionId: "allow_once", name: "Allow for this turn", kind: "allow_once" },
            { optionId: "allow_always", name: "Allow for session", kind: "allow_always" },
            { optionId: "reject_once", name: "Deny", kind: "reject_once" },
          ],
        }
      }
      case "mcpServer/elicitation/request": {
        const p = params as McpServerElicitationRequestParams
        return {
          title: `${p.serverName}: ${p.message}`,
          kind: "other",
          detail: p.mode === "url" ? p.url : undefined,
          options: [
            { optionId: "allow_once", name: "Accept", kind: "allow_once" },
            { optionId: "reject_once", name: "Decline", kind: "reject_once" },
          ],
        }
      }
      case "item/tool/requestUserInput": {
        // Questions become a permission prompt: the first question's choices are the options.
        const p = params as ToolRequestUserInputParams
        const q = p.questions[0]
        const choices = q?.options ?? []
        const options: PermissionOption[] = choices.length
          ? choices.map((o, i) => ({ optionId: `choice:${i}`, name: o.label, kind: "allow_once" as const }))
          : [{ optionId: "allow_once", name: "Continue", kind: "allow_once" }]
        options.push({ optionId: "reject_once", name: "Skip", kind: "reject_once" })
        return {
          title: q ? (q.header ? `${q.header}: ${q.question}` : q.question) : "Agent asks for input",
          kind: "other",
          toolCallId: p.itemId,
          detail: p.questions.length > 1 ? p.questions.map((x) => x.question).join("\n") : undefined,
          options,
        }
      }
      // Legacy v1 approval requests (older servers / conversations).
      case "execCommandApproval": {
        const p = params as { callId: string; command: string[]; cwd: string; reason: string | null }
        return {
          title: `Run ${p.command.join(" ")}`,
          kind: "execute",
          toolCallId: p.callId,
          detail: p.reason ?? undefined,
          options: DEFAULT_PERMISSION_OPTIONS,
        }
      }
      case "applyPatchApproval": {
        const p = params as { callId: string; fileChanges: Record<string, unknown>; reason: string | null }
        return {
          title: `Edit ${Object.keys(p.fileChanges).join(", ")}`,
          kind: "edit",
          toolCallId: p.callId,
          detail: p.reason ?? undefined,
          options: DEFAULT_PERMISSION_OPTIONS,
        }
      }
      default:
        return undefined
    }
  }

  /**
   * Answer a pending permission. `optionId` null means cancelled. Returns the JSON-RPC response
   * the session must send back to codex, or undefined if the request is unknown / already done.
   */
  resolvePermission(
    requestId: string,
    optionId: string | null,
    by: "user" | "policy" | "timeout" | "cancelled" = "user",
  ): { rpcId: RpcId; result: unknown } | undefined {
    const p = this.pending.get(requestId)
    if (!p) return undefined
    const opt = optionId === null ? undefined : p.options.find((o) => o.optionId === optionId)
    if (optionId !== null && !opt) this.log("warn", `codex: unknown permission option ${optionId}; treating as cancel`)
    this.pending.delete(requestId)
    this.byRpcId.delete(p.rpcId)
    this.emit({
      type: "permission.resolved",
      data: { requestId, optionId: opt?.optionId ?? null, kind: opt?.kind ?? null, by: opt ? by : by === "user" ? "cancelled" : by },
    })
    if (this.activeTurnId) this.setStatus(this.pending.size ? "awaiting_approval" : "busy")
    return { rpcId: p.rpcId, result: permissionResult(p, opt) }
  }

  /** Resolve every pending permission as cancelled; returns the responses to send. */
  cancelAll(by: "cancelled" | "timeout" = "cancelled"): { rpcId: RpcId; result: unknown }[] {
    const out: { rpcId: RpcId; result: unknown }[] = []
    for (const id of [...this.pending.keys()]) {
      const r = this.resolvePermission(id, null, by)
      if (r) out.push(r)
    }
    return out
  }

  /** Codex no longer waits for this request; mark it resolved without answering. */
  private dropPending(requestId: string, by: "cancelled"): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    this.byRpcId.delete(p.rpcId)
    this.emit({ type: "permission.resolved", data: { requestId, optionId: null, kind: null, by } })
    if (this.activeTurnId) this.setStatus(this.pending.size ? "awaiting_approval" : "busy")
  }

  // ───────────────────────────── shell edits ─────────────────────────────

  /**
   * Files a shell command changed (found by the session's workspace snapshots). Emitted as a
   * completed `edit` tool call nested under the command so diffs show up like apply_patch edits.
   */
  shellEdits(commandItemId: string, files: ShellEditFile[]): void {
    if (!files.length) return
    const toolCallId = `${commandItemId}:edit`
    const first = files[0] as ShellEditFile
    const title = files.length === 1 ? `${first.deleted ? "Delete" : first.created ? "Write" : "Edit"} ${first.path}` : `Edit ${files.length} files`
    const kind: ToolKind = files.length === 1 && first.deleted ? "delete" : "edit"
    this.emit({
      type: "tool.call",
      data: {
        toolCallId,
        parentToolCallId: commandItemId,
        kind,
        name: "shell_edit",
        title,
        status: "in_progress",
        locations: files.map((f) => ({ path: f.path })),
      },
    })
    const content: DiffContent[] = files.map((f) => ({
      type: "diff",
      path: f.path,
      ...(f.created ? { oldText: null } : {}),
      lines: f.lines,
      added: f.added,
      removed: f.removed,
    }))
    this.emit({
      type: "tool.update",
      data: { toolCallId, status: "completed", content, summary: fileChangeSummary(content) },
    })
  }
}

/** A file changed by a shell command (see snapshot.ts). */
export interface ShellEditFile {
  path: string
  lines: DiffContent["lines"] & {}
  added: number
  removed: number
  created: boolean
  deleted: boolean
}

/** Commands whose parsed actions are all read-only can't have edited files. */
export function isReadOnlyCommand(item: ThreadItem): boolean {
  return (
    item.type === "commandExecution" &&
    item.commandActions.length > 0 &&
    item.commandActions.every((a) => a.type === "read" || a.type === "listFiles" || a.type === "search")
  )
}

// ───────────────────────────── permission responses ─────────────────────────────

function permissionResult(p: PendingPermission, opt: PermissionOption | undefined): unknown {
  const kind: PermissionOptionKind | undefined = opt?.kind
  const allow = kind === "allow_once" || kind === "allow_always"
  switch (p.method) {
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval": {
      const decision: CommandExecutionApprovalDecision & FileChangeApprovalDecision =
        kind === "allow_once" ? "accept" : kind === "allow_always" ? "acceptForSession" : kind ? "decline" : "cancel"
      return { decision }
    }
    case "item/permissions/requestApproval": {
      const params = p.params as PermissionsRequestApprovalParams
      const res: PermissionsRequestApprovalResponse = allow
        ? {
            permissions: {
              ...(params.permissions.network ? { network: params.permissions.network } : {}),
              ...(params.permissions.fileSystem ? { fileSystem: params.permissions.fileSystem } : {}),
            },
            scope: kind === "allow_always" ? "session" : "turn",
          }
        : { permissions: {}, scope: "turn" }
      return res
    }
    case "mcpServer/elicitation/request": {
      const params = p.params as McpServerElicitationRequestParams
      const res: McpServerElicitationRequestResponse = allow
        ? { action: "accept", content: params.mode === "url" ? null : {}, _meta: null }
        : { action: kind ? "decline" : "cancel", content: null, _meta: null }
      return res
    }
    case "item/tool/requestUserInput": {
      const params = p.params as ToolRequestUserInputParams
      const answers: ToolRequestUserInputResponse["answers"] = {}
      if (allow) {
        const idx = opt?.optionId.startsWith("choice:") ? Number(opt.optionId.slice(7)) : -1
        params.questions.forEach((q, qi) => {
          const label = qi === 0 && idx >= 0 ? q.options?.[idx]?.label : q.options?.[0]?.label
          answers[q.id] = { answers: label ? [label] : [] }
        })
      }
      return { answers } satisfies ToolRequestUserInputResponse
    }
    case "execCommandApproval":
    case "applyPatchApproval": {
      const decision: ReviewDecision =
        kind === "allow_once"
          ? "approved"
          : kind === "allow_always"
            ? "approved_for_session"
            : kind
              ? { denied: { rejection: "Denied by the user via baton" } }
              : "abort"
      return { decision }
    }
    default:
      return {}
  }
}

// ───────────────────────────── item → tool mapping ─────────────────────────────

/** Strip the `/bin/zsh -lc '…'` wrapper codex puts around shell commands. */
export function unwrapShell(command: string): string {
  const m = /^(?:\S*\/)?(?:ba|z|da)?sh\s+-l?c\s+([\s\S]+)$/.exec(command.trim())
  if (!m) return command
  const arg = (m[1] ?? "").trim()
  if (arg.startsWith("'") && arg.endsWith("'") && arg.length >= 2) return arg.slice(1, -1).replace(/'\\''/g, "'")
  if (arg.startsWith('"') && arg.endsWith('"') && arg.length >= 2) return arg.slice(1, -1).replace(/\\(["\\$`])/g, "$1")
  return arg
}

function tail(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(-MAX_OUTPUT) : s
}

function basename(p: string): string {
  const parts = p.split("/")
  return parts[parts.length - 1] || p
}

/** One file change → BEP diff content. `add`/`delete` carry file content, `update` a unified diff. */
export function changeContent(c: FileUpdateChange): DiffContent {
  if (c.kind.type === "add") {
    const lines = diffLines("", c.diff, Number.POSITIVE_INFINITY)
    return { type: "diff", path: c.path, oldText: null, newText: c.diff, lines, ...diffStat(lines) }
  }
  if (c.kind.type === "delete") {
    const lines = diffLines(c.diff, "", Number.POSITIVE_INFINITY)
    return { type: "diff", path: c.path, oldText: c.diff, newText: "", lines, ...diffStat(lines) }
  }
  const lines = parseUnifiedDiff(c.diff).flatMap((f) => f.lines)
  return { type: "diff", path: c.kind.move_path ?? c.path, lines, ...diffStat(lines) }
}

function fileChangeTitle(changes: FileUpdateChange[]): { kind: ToolKind; title: string } {
  if (changes.length === 1) {
    const c = changes[0] as FileUpdateChange
    if (c.kind.type === "add") return { kind: "edit", title: `Write ${c.path}` }
    if (c.kind.type === "delete") return { kind: "delete", title: `Delete ${c.path}` }
    if (c.kind.move_path) return { kind: "move", title: `Move ${c.path} → ${c.kind.move_path}` }
    return { kind: "edit", title: `Edit ${c.path}` }
  }
  return { kind: "edit", title: changes.length ? `Edit ${changes.length} files` : "Edit files" }
}

function fileChangeSummary(contents: DiffContent[]): string {
  let added = 0
  let removed = 0
  for (const c of contents) {
    added += c.added ?? 0
    removed += c.removed ?? 0
  }
  if (contents.length === 1) {
    const c = contents[0] as DiffContent
    if (c.oldText === null) return `Created ${basename(c.path)} (${added} lines)`
    if (c.newText === "" && c.oldText) return `Deleted ${basename(c.path)}`
    return `Updated ${added + removed} line${added + removed === 1 ? "" : "s"} (+${added} -${removed})`
  }
  return `${contents.length} files +${added} -${removed}`
}

function commandSummary(output: string, exitCode: number | null, status: string): string {
  if (status === "declined") return "Declined"
  if (exitCode !== null && exitCode !== 0) return `exit ${exitCode}`
  const first = output.split("\n").find((l) => l.trim().length)
  if (!first) return exitCode === 0 ? "No output" : status === "failed" ? "Failed" : "Done"
  return first.length > 120 ? `${first.slice(0, 117)}…` : first
}

function mcpText(content: unknown[]): string {
  return content
    .map((c) => {
      const x = c as { type?: string; text?: string }
      return x?.type === "text" && typeof x.text === "string" ? x.text : JSON.stringify(c)
    })
    .join("\n")
}

/** `tool.call` for a tool-like thread item, or undefined for messages/reasoning/etc. */
export function toolCall(item: ThreadItem): ToolCallData | undefined {
  switch (item.type) {
    case "commandExecution": {
      const cmd = unwrapShell(item.command)
      const locations = item.commandActions.flatMap((a) => (a.type === "read" ? [{ path: a.path }] : []))
      return {
        toolCallId: item.id,
        kind: "execute",
        name: "Bash",
        title: cmd,
        status: "in_progress",
        ...(locations.length ? { locations } : {}),
        rawInput: { command: cmd, cwd: item.cwd, actions: item.commandActions },
      }
    }
    case "fileChange": {
      const { kind, title } = fileChangeTitle(item.changes)
      return {
        toolCallId: item.id,
        kind,
        name: "apply_patch",
        title,
        status: "in_progress",
        locations: item.changes.map((c) => ({ path: c.path })),
        rawInput: { changes: item.changes.map((c) => ({ path: c.path, kind: c.kind.type })) },
      }
    }
    case "mcpToolCall":
      return {
        toolCallId: item.id,
        kind: "other",
        name: `mcp__${item.server}__${item.tool}`,
        title: `${item.server}.${item.tool}`,
        status: "in_progress",
        rawInput: item.arguments,
      }
    case "dynamicToolCall":
      return {
        toolCallId: item.id,
        kind: "other",
        name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        title: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        status: "in_progress",
        rawInput: item.arguments,
      }
    case "collabAgentToolCall": {
      const prompt = item.prompt ? `: ${item.prompt.split("\n")[0]?.slice(0, 80)}` : ""
      return {
        toolCallId: item.id,
        kind: "delegate",
        name: item.tool,
        title: `${item.tool}${prompt}`,
        status: "in_progress",
        rawInput: { prompt: item.prompt, model: item.model, receivers: item.receiverThreadIds },
      }
    }
    case "webSearch": {
      const a = item.action
      let title = item.query ? `Search "${item.query}"` : "Web search"
      if (a?.type === "search" && (a.query || a.queries?.length)) title = `Search "${a.query ?? a.queries?.join(" | ")}"`
      else if (a?.type === "openPage" && a.url) title = `Open ${a.url}`
      else if (a?.type === "findInPage") title = `Find "${a.pattern ?? ""}" in ${a.url ?? "page"}`
      return { toolCallId: item.id, kind: "fetch", name: "web_search", title, status: "in_progress", rawInput: { query: item.query, action: a } }
    }
    case "imageView":
      return {
        toolCallId: item.id,
        kind: "read",
        name: "view_image",
        title: `View ${item.path}`,
        status: "in_progress",
        locations: [{ path: item.path }],
      }
    case "imageGeneration":
      return { toolCallId: item.id, kind: "other", name: "image_generation", title: "Generate image", status: "in_progress" }
    case "subAgentActivity":
      return {
        toolCallId: item.id,
        kind: "delegate",
        name: "subagent",
        title: `Sub-agent ${item.agentPath} (${item.kind})`,
        status: "in_progress",
        rawInput: { agentThreadId: item.agentThreadId, model: item.model },
      }
    default:
      return undefined
  }
}

/** Final `tool.update` for a completed tool-like item. */
export function toolResult(item: ThreadItem): Extract<AgentEvent, { type: "tool.update" }>["data"] | undefined {
  switch (item.type) {
    case "commandExecution": {
      const output = item.aggregatedOutput ?? ""
      const ok = item.status === "completed" && (item.exitCode === null || item.exitCode === 0)
      return {
        toolCallId: item.id,
        status: ok ? "completed" : "failed",
        content: [{ type: "terminal", terminalId: item.id, command: unwrapShell(item.command), output: tail(output), exitCode: item.exitCode }],
        summary: commandSummary(output, item.exitCode, item.status),
        rawOutput: { exitCode: item.exitCode, durationMs: item.durationMs },
      }
    }
    case "fileChange": {
      const content = item.changes.map(changeContent)
      return {
        toolCallId: item.id,
        status: item.status === "completed" ? "completed" : "failed",
        content,
        summary: item.status === "declined" ? "Declined" : item.status === "failed" ? "Patch failed" : fileChangeSummary(content),
      }
    }
    case "mcpToolCall": {
      const text = item.error ? item.error.message : item.result ? mcpText(item.result.content) : ""
      return {
        toolCallId: item.id,
        status: item.status === "completed" && !item.error ? "completed" : "failed",
        content: text ? [{ type: "text", text }] : undefined,
        summary: item.error ? item.error.message.split("\n")[0] : undefined,
        rawOutput: item.result?.structuredContent ?? undefined,
      }
    }
    case "dynamicToolCall": {
      const text = (item.contentItems ?? []).map((c) => ("text" in c ? c.text : JSON.stringify(c))).join("\n")
      return {
        toolCallId: item.id,
        status: item.status === "completed" && item.success !== false ? "completed" : "failed",
        content: text ? [{ type: "text", text }] : undefined,
      }
    }
    case "collabAgentToolCall":
      return { toolCallId: item.id, status: item.status === "failed" ? "failed" : "completed" }
    case "webSearch":
      return {
        toolCallId: item.id,
        status: "completed",
        summary: item.results ? `${item.results.length} results` : undefined,
      }
    case "imageGeneration":
      return { toolCallId: item.id, status: item.status === "failed" ? "failed" : "completed" }
    case "imageView":
    case "subAgentActivity":
      return { toolCallId: item.id, status: "completed" }
    default:
      return undefined
  }
}

interface TokenTotals {
  input: number
  cached: number
  output: number
  reasoning: number
}

function totals(b: Partial<Record<"inputTokens" | "cachedInputTokens" | "outputTokens" | "reasoningOutputTokens", number>> | undefined): TokenTotals {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0)
  return { input: n(b?.inputTokens), cached: n(b?.cachedInputTokens), output: n(b?.outputTokens), reasoning: n(b?.reasoningOutputTokens) }
}

function subTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: Math.max(0, a.input - b.input),
    cached: Math.max(0, a.cached - b.cached),
    output: Math.max(0, a.output - b.output),
    reasoning: Math.max(0, a.reasoning - b.reasoning),
  }
}
