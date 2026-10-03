/**
 * A2A server: exposes the whole Baton team as one Agent2Agent agent.
 *
 * Bindings (one port):
 *   - JSON-RPC at `POST /` (and `/a2a`), v1.0 (`SendMessage`, `SendStreamingMessage`, `GetTask`,
 *     `ListTasks`, `CancelTask`, `SubscribeToTask`, `*TaskPushNotificationConfig*`,
 *     `GetExtendedAgentCard`) and v0.3 (`message/send`, `message/stream`, `tasks/*`,
 *     `tasks/pushNotificationConfig/*`) — each response follows its request's dialect;
 *   - HTTP+JSON/REST (v1.0): `POST /message:send`, `POST /message:stream` (SSE), `GET /tasks`,
 *     `GET /tasks/{id}`, `POST /tasks/{id}:cancel`, `GET|POST /tasks/{id}:subscribe` (SSE),
 *     `POST|GET /tasks/{id}/pushNotificationConfigs`, `GET|DELETE …/pushNotificationConfigs/{cid}`,
 *     `GET /extendedAgentCard` — also under `/v1/…`.
 * The agent card (`/.well-known/agent-card.json`, also `/.well-known/agent.json`) is public, lists
 * every interface and is signed (JWS, Ed25519; public key at `/.well-known/jwks.json`).
 *
 * A new task hands the message to the lead (orchestrator). It stays `working` — streaming the
 * lead's messages as status updates — until the lead's turn is over and the whole team has been
 * idle for `idleMs`; then it completes with the lead's final message (status message + `response`
 * artifact) and a `changes` artifact listing each agent's unmerged changes. If that final message
 * is a question to the requester (ends with "?") and nothing changed during the task, the task
 * becomes `input-required` instead; a message on the same task continues it. Only the lead's
 * turns started by the task's own prompts (and turns that carry results of work it delegated)
 * count, so a human typing into the TUI at the same time doesn't leak into the task.
 *
 * While any agent waits for a human approval the task is `input-required` (the question is the
 * status message); a follow-up saying "allow" / "deny" answers the oldest pending approval.
 * Tasks run one at a time (the team has one lead); later ones wait in `submitted`. Every task of
 * a context talks to the same lead, so a contextId naturally continues the conversation.
 *
 * Push notifications: webhooks per task (with SSRF guard, retries); tasks persist across daemon
 * restarts (tasks that were running when the daemon died come back as `failed`).
 *
 * Bound to 127.0.0.1 unless a host is given. With a token, every JSON-RPC / REST call needs
 * `Authorization: Bearer <token>`.
 */
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  A2A_LEGACY_VERSION,
  A2AError,
  type Artifact,
  classifyMethod,
  type Dialect,
  decodeMessage,
  decodePushConfig,
  ErrorCode,
  encodeEvent,
  encodePushConfig,
  encodeTask,
  encodeV1Event,
  isFinalState,
  type Message,
  type MethodKind,
  normalizeState,
  type Part,
  publicJwk,
  restErrorBody,
  type StreamEvent,
  signCard,
  type Task,
  type TaskState,
  TERMINAL_STATES,
  textMessage,
} from "@batonsh/adapter-a2a/wire"
import { stateDir } from "@batonsh/kernel"
import type { BatonEvent, PendingApproval } from "@batonsh/protocol"
import { checkPushUrl, PushDispatcher, type PushOptions, type PushTarget } from "./a2a-push.ts"
import { a2aSigningKey, loadTasks, type StoredTask, TaskStore, tasksFile } from "./a2a-store.ts"
import { DAEMON_VERSION } from "./control.ts"
import type { Runtime } from "./runtime.ts"

export interface A2AServerOptions {
  port?: number
  host?: string
  /** Require `Authorization: Bearer <token>` on JSON-RPC / REST calls (the card stays public). */
  token?: string
  /** Externally reachable base URL (tunnel / reverse proxy) advertised in the agent card. */
  publicUrl?: string
  /** How long the team must be quiet before a task completes (default 2000 ms). */
  idleMs?: number
  /** Grace period before a new approval request flips the task to input-required (default 300 ms; policy may answer first). */
  approvalGraceMs?: number
  /** Persist tasks to this file (and reload them on start). Default: memory only. */
  persist?: string
  persistDebounceMs?: number
  /** Allow push-notification webhooks on loopback / private addresses (default false). */
  allowPrivatePush?: boolean
  /** Push delivery tuning (attempts, backoff, timeout). */
  push?: Omit<PushOptions, "allowPrivate" | "log">
  /** Card signing key (Ed25519). Default: a fresh in-memory key; `false` = unsigned card. */
  signingKey?: KeyObject | false
  /** A final lead message that asks the requester something → input-required (default true). */
  questionsAsInput?: boolean
}

export interface A2AServer {
  url: string
  port: number
  /** Push deliveries (for diagnostics / tests). */
  push: PushDispatcher
  /** Write pending task state now. */
  flush(): void
  stop(): void
}

type Listener = (e: StreamEvent) => void

interface TaskRec {
  task: Task
  /** What goes to the lead when the task (re)starts. */
  text: string
  /** queued → running → done; `waiting` = input-required on a question from the lead (not holding the team). */
  phase: "queued" | "running" | "waiting" | "done"
  startSeq: number
  leadTurnSeen: boolean
  leadTurnEnded: boolean
  leadFailed: boolean
  lastError?: string
  lastLeadText: string
  /** The approval that put the task into input-required. */
  approvalId?: string
  listeners: Set<Listener>
  /** Prompts sent to the lead for this task whose turn hasn't started yet. */
  pending: string[]
  /** The lead's current turn belongs to this task. */
  inTurn: boolean
  /** The task's lead turns delegated work (spawned / messaged agents): their results belong to it. */
  delegated: boolean
  /** Files changed or merged during the task. */
  changed: boolean
  push: Map<string, PushTarget>
}

const now = () => new Date().toISOString()
const MAX_TASKS = 500
const MAX_PUSH_PER_TASK = 10

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** What the team is asked: text parts as-is, data parts as JSON, files by name / URI. */
function promptText(parts: Part[]): string {
  return parts
    .map((p) =>
      p.kind === "text"
        ? p.text
        : p.kind === "data"
          ? `\`\`\`json\n${JSON.stringify(p.data, null, 2)}\n\`\`\``
          : `[file: ${p.file.name ?? "unnamed"}${p.file.uri ? ` ${p.file.uri}` : p.file.bytes ? " (inline content omitted)" : ""}]`,
    )
    .join("\n")
    .trim()
}

function decision(text: string): "allow" | "deny" | undefined {
  const t = text.trim().toLowerCase()
  if (/^(allow|approve|approved|yes|y|ok|accept|go ahead)\b/.test(t)) return "allow"
  if (/^(deny|denied|reject|no|n|decline|refuse)\b/.test(t)) return "deny"
  return undefined
}

/** Does the lead's final message end with a question to the requester? */
export function asksQuestion(text: string): boolean {
  const last =
    text
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .at(-1) ?? ""
  return /\?\s*[*_`)"'»”\]]*\s*$/.test(last)
}

function withHistory(t: Task, historyLength: unknown): Task {
  if (typeof historyLength !== "number" || historyLength < 0) return t
  return { ...t, history: historyLength === 0 ? [] : (t.history ?? []).slice(-historyLength) }
}

const numParam = (v: unknown): number | undefined => (typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined)

export function startA2AServer(rt: Runtime, opts: A2AServerOptions = {}): A2AServer {
  const idleMs = opts.idleMs ?? 2_000
  const graceMs = opts.approvalGraceMs ?? 300
  const host = opts.host ?? "127.0.0.1"
  const tasks = new Map<string, TaskRec>()
  const queue: TaskRec[] = []
  let active: TaskRec | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let approvalTimer: ReturnType<typeof setTimeout> | undefined
  const streams = new Set<() => void>()
  let stopped = false
  const log = (level: "info" | "warn", message: string) => rt.emit({ type: "log", data: { level, message } })
  const push = new PushDispatcher({ ...opts.push, allowPrivate: opts.allowPrivatePush === true, log })
  const signingKey = opts.signingKey === false ? undefined : (opts.signingKey ?? generateKeyPairSync("ed25519").privateKey)

  // ───────────────────────────── persistence ─────────────────────────────

  const snapshot = (): StoredTask[] =>
    [...tasks.values()].map((r) => ({
      task: r.task,
      push: r.push.size ? [...r.push.values()] : undefined,
      waiting: r.phase === "waiting" ? "question" : r.approvalId && r.task.status.state === "input-required" ? "approval" : undefined,
    }))
  const store = opts.persist
    ? new TaskStore(opts.persist, snapshot, opts.persistDebounceMs ?? 250, (e) =>
        log("warn", `A2A: could not save tasks: ${e instanceof Error ? e.message : e}`),
      )
    : undefined
  const persist = () => store?.schedule()

  // ───────────────────────────── task state ─────────────────────────────

  const newRec = (task: Task, text: string): TaskRec => ({
    task,
    text,
    phase: "queued",
    startSeq: 0,
    leadTurnSeen: false,
    leadTurnEnded: false,
    leadFailed: false,
    lastLeadText: "",
    listeners: new Set(),
    pending: [],
    inTurn: false,
    delegated: false,
    changed: false,
    push: new Map(),
  })

  const publish = (rec: TaskRec, e: StreamEvent) => {
    for (const l of [...rec.listeners]) l(e)
    for (const p of rec.push.values()) {
      // v1.0 webhooks get each StreamResponse; v0.3 ones the task snapshot on status changes
      if (p.dialect === "1.0") push.deliver(p, encodeV1Event(e))
      else if (e.kind === "status-update") push.deliver(p, structuredClone(rec.task))
    }
    persist()
  }

  const setStatus = (rec: TaskRec, state: TaskState, message?: Message) => {
    rec.task.status = { state, message, timestamp: now() }
    if (message) rec.task.history?.push(message)
    publish(rec, {
      kind: "status-update",
      taskId: rec.task.id,
      contextId: rec.task.contextId,
      status: rec.task.status,
      final: isFinalState(state),
    })
  }

  const agentMessage = (rec: TaskRec, text: string): Message => textMessage("agent", text, { taskId: rec.task.id, contextId: rec.task.contextId })

  const addArtifact = (rec: TaskRec, artifact: Artifact) => {
    rec.task.artifacts = [...(rec.task.artifacts ?? []).filter((a) => a.artifactId !== artifact.artifactId), artifact]
    publish(rec, { kind: "artifact-update", taskId: rec.task.id, contextId: rec.task.contextId, artifact, append: false, lastChunk: true })
  }

  /** The task stops holding the team: start the next queued one. */
  const release = (rec: TaskRec) => {
    if (active !== rec) return
    active = undefined
    clearTimeout(idleTimer)
    clearTimeout(approvalTimer)
    const next = queue.shift()
    if (next) void begin(next)
  }

  const finish = (rec: TaskRec, state: TaskState, text?: string) => {
    if (rec.phase === "done") return
    rec.phase = "done"
    rec.inTurn = false
    rec.pending = []
    setStatus(rec, state, text ? agentMessage(rec, text) : undefined)
    rec.listeners.clear()
    release(rec)
    // keep memory bounded: forget the oldest finished tasks
    for (const [id, r] of tasks) {
      if (tasks.size <= MAX_TASKS) break
      if (r.phase === "done") tasks.delete(id)
    }
  }

  const begin = async (rec: TaskRec) => {
    active = rec
    rec.phase = "running"
    rec.startSeq = rt.state.lastSeq
    rec.leadTurnSeen = false
    rec.leadTurnEnded = false
    rec.leadFailed = false
    rec.inTurn = false
    rec.pending = [rec.text]
    setStatus(rec, "working")
    try {
      const lead = await rt.ensureOrchestrator()
      if (rec.phase !== "running") return
      await rt.promptAgent(lead.info.agentId, rec.text, { from: "a2a", delivery: "queue" })
      checkApprovals()
    } catch (e) {
      finish(rec, "failed", `Baton could not start the task: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const leadId = () => rt.orchestrator()?.info.agentId ?? rt.state.orchestratorId

  const oldestApproval = (): PendingApproval | undefined => {
    let best: PendingApproval | undefined
    for (const p of rt.state.approvals.values()) if (!best || p.ts < best.ts) best = p
    return best
  }

  /** Waiting approvals flip the task to input-required (and back once they're answered). */
  const checkApprovals = () => {
    const rec = active
    if (rec?.phase !== "running") return
    const p = oldestApproval()
    const state = rec.task.status.state
    if (p) {
      if (state === "input-required" && rec.approvalId === p.requestId) return
      rec.approvalId = p.requestId
      clearTimeout(idleTimer)
      const who = rt.state.agents.get(p.agentId)?.name ?? "an agent"
      const more = rt.state.approvals.size > 1 ? ` (${rt.state.approvals.size - 1} more waiting)` : ""
      setStatus(
        rec,
        "input-required",
        agentMessage(rec, `${who} needs approval: ${p.title}${p.detail ? `\n${p.detail}` : ""}${more}\nReply "allow" or "deny".`),
      )
    } else if (state === "input-required") {
      rec.approvalId = undefined
      setStatus(rec, "working")
      scheduleIdle()
    }
  }

  const teamIdle = (): boolean => {
    for (const a of rt.agents.values()) if (!a.closing && (a.busy || (a.info.isOrchestrator && a.inbox.length > 0))) return false
    return rt.state.approvals.size === 0
  }

  const scheduleIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = undefined
    const rec = active
    if (rec?.phase !== "running" || rec.task.status.state !== "working" || !rec.leadTurnEnded) return
    idleTimer = setTimeout(() => {
      if (active !== rec || rec.phase !== "running" || rec.task.status.state !== "working") return
      if (!rec.leadTurnEnded || rec.inTurn || !teamIdle()) return scheduleIdle()
      complete(rec)
    }, idleMs)
    idleTimer.unref?.()
  }

  const complete = (rec: TaskRec) => {
    const text = rec.lastLeadText
    if (rec.leadFailed) {
      finish(rec, "failed", rec.lastError ?? (text || "the lead's turn failed"))
      return
    }
    if (opts.questionsAsInput !== false && text && asksQuestion(text) && !rec.changed) {
      // the lead asks the requester something: wait for the answer without holding the team
      rec.phase = "waiting"
      rec.pending = []
      setStatus(rec, "input-required", agentMessage(rec, text))
      release(rec)
      return
    }
    const response = text || "Done."
    addArtifact(rec, { artifactId: "response", name: "response", description: "The lead's final answer", parts: [{ kind: "text", text: response }] })
    const changes = changesArtifact()
    if (changes) addArtifact(rec, changes)
    finish(rec, "completed", response)
  }

  /** Unmerged changes per agent (worktrees not merged yet; shared workspaces as they stand). */
  const changesArtifact = (): Artifact | undefined => {
    const rows: {
      agent: string
      mode: string
      branch?: string
      path: string
      added: number
      removed: number
      files: { path: string; added: number; removed: number }[]
    }[] = []
    for (const [agentId, w] of rt.state.workspaces) {
      if (!w.files.length || w.merge?.status === "merged") continue
      rows.push({
        agent: rt.state.agents.get(agentId)?.name ?? agentId,
        mode: w.mode,
        branch: w.branch,
        path: w.path,
        added: w.added,
        removed: w.removed,
        files: w.files,
      })
    }
    if (!rows.length) return undefined
    const lines = rows.map(
      (r) =>
        `${r.agent}${r.branch ? ` (${r.branch})` : ""}: +${r.added} −${r.removed}${r.mode === "worktree" ? " — not merged yet" : ""}\n${r.files
          .slice(0, 50)
          .map((f) => `  ${f.path} (+${f.added} −${f.removed})`)
          .join("\n")}`,
    )
    return {
      artifactId: "changes",
      name: "changes",
      description: "Changes per agent that are not merged into the project yet",
      parts: [
        { kind: "text", text: lines.join("\n") },
        { kind: "data", data: { changes: rows } },
      ],
    }
  }

  /** Does a lead turn that starts with `prompt` belong to the task? */
  const claimTurn = (rec: TaskRec, prompt: string | undefined): boolean => {
    if (prompt?.trim()) {
      const p = prompt.trim()
      const i = rec.pending.findIndex((x) => p === x.trim() || p.includes(x.trim()) || (p.length >= 20 && x.includes(p)))
      if (i >= 0) {
        rec.pending.splice(i, 1)
        return true
      }
      // results / messages from agents the task's turns put to work
      return p.startsWith("[baton]") && rec.delegated
    }
    // adapters that don't report the prompt: the task's prompts start in order
    if (rec.pending.length) {
      rec.pending.shift()
      return true
    }
    return rec.delegated
  }

  const onEvent = (e: BatonEvent) => {
    const rec = active
    if (rec?.phase !== "running" || e.seq <= rec.startSeq) return
    const lead = leadId()
    if (e.agentId && e.agentId === lead) {
      switch (e.type) {
        case "turn.started":
          rec.inTurn = claimTurn(rec, e.data.prompt)
          if (rec.inTurn) {
            rec.leadTurnSeen = true
            rec.leadTurnEnded = false
            rec.leadFailed = false
          }
          break
        case "turn.completed":
        case "turn.interrupted":
          if (rec.inTurn) {
            rec.inTurn = false
            rec.leadTurnEnded = true
            rec.leadFailed = e.type === "turn.completed" && e.data.stopReason === "error"
          }
          break
        case "error":
          if (rec.inTurn) rec.lastError = e.data.message
          break
        case "message.completed":
          if (rec.inTurn && e.data.role === "assistant" && e.data.text.trim()) {
            rec.lastLeadText = e.data.text
            if (rec.task.status.state === "working") setStatus(rec, "working", agentMessage(rec, e.data.text))
            else {
              rec.task.history?.push(agentMessage(rec, e.data.text))
              persist()
            }
          }
          break
        case "agent.exited":
          finish(rec, "failed", `the lead agent exited${e.data.reason ? ` (${e.data.reason})` : ""}`)
          return
      }
    }
    switch (e.type) {
      case "agent.spawned":
        if (rec.inTurn && lead && e.data.parentId === lead) rec.delegated = true
        break
      case "bus.message":
        if (rec.inTurn && lead && e.data.from === lead && e.data.kind !== "heartbeat" && e.data.kind !== "progress") rec.delegated = true
        break
      case "workspace.changed":
        if (e.data.files.length) rec.changed = true
        break
      case "workspace.merge":
        if (e.data.status === "merged") rec.changed = true
        break
      case "tool.update":
        if (e.data.content?.some((c) => c.type === "diff")) rec.changed = true
        break
    }
    if (e.type === "permission.requested") {
      clearTimeout(approvalTimer)
      approvalTimer = setTimeout(checkApprovals, graceMs)
      approvalTimer.unref?.()
    } else if (e.type === "permission.resolved" || e.type === "agent.exited") queueMicrotask(checkApprovals)
    scheduleIdle()
  }
  const unsubscribe = rt.store.subscribe(onEvent)

  // ───────────────────────────── operations (binding-neutral) ─────────────────────────────

  const getRec = (id: unknown): TaskRec => {
    if (typeof id !== "string" || !id) throw new A2AError(ErrorCode.InvalidParams, "task id is required")
    const rec = tasks.get(id)
    if (!rec) throw new A2AError(ErrorCode.TaskNotFound, `task not found: ${id}`)
    return rec
  }

  /** Apply an incoming message: a new task, or a follow-up on an existing one. */
  const accept = async (params: Record<string, unknown>): Promise<TaskRec> => {
    const msg = decodeMessage(params.message)
    if (!msg) throw new A2AError(ErrorCode.InvalidParams, "params.message is required (with parts)")
    const text = promptText(msg.parts)
    if (!text) throw new A2AError(ErrorCode.ContentTypeNotSupported, "the message has no usable content (send text, data or file parts)")
    msg.role = "user"
    if (msg.taskId) {
      const rec = tasks.get(msg.taskId)
      if (!rec) throw new A2AError(ErrorCode.TaskNotFound, `task not found: ${msg.taskId}`)
      if (TERMINAL_STATES.has(rec.task.status.state))
        throw new A2AError(ErrorCode.UnsupportedOperation, `task ${rec.task.id} is ${rec.task.status.state}; send a new message (same contextId) to continue`)
      msg.contextId = rec.task.contextId
      rec.task.history?.push(msg)
      persist()
      if (rec.phase === "waiting") {
        // the answer to the lead's question: the task runs again
        rec.text = text
        if (active) {
          rec.phase = "queued"
          setStatus(rec, "submitted")
          queue.push(rec)
        } else void begin(rec)
        return rec
      }
      if (rec.task.status.state === "input-required" && rec.approvalId) {
        const d = decision(text)
        const p = rt.state.approvals.get(rec.approvalId) ?? oldestApproval()
        if (!d || !p) {
          if (!p) checkApprovals()
          else setStatus(rec, "input-required", agentMessage(rec, `Please reply "allow" or "deny" to: ${p.title}`))
          return rec
        }
        const want = d === "allow" ? "allow" : "reject"
        const opt = p.options.find((o) => o.kind === `${want}_once`) ?? p.options.find((o) => o.kind.startsWith(want))
        rec.approvalId = undefined
        await rt.resolvePermission(p.agentId, p.requestId, opt?.optionId ?? null, "user")
        checkApprovals()
        scheduleIdle()
        return rec
      }
      if (rec.phase === "queued") {
        rec.text = `${rec.text}\n\n${text}`
        return rec
      }
      // more input for a running task goes to the lead
      const lead = rt.orchestrator()
      if (lead) {
        const steer = lead.busy && lead.caps.steer
        if (!steer) rec.pending.push(text)
        await rt.promptAgent(lead.info.agentId, text, { from: "a2a", delivery: steer ? "steer" : "queue" })
      }
      return rec
    }
    const contextId = msg.contextId || crypto.randomUUID()
    const id = crypto.randomUUID()
    msg.contextId = contextId
    msg.taskId = id
    const rec = newRec({ kind: "task", id, contextId, status: { state: "submitted", timestamp: now() }, history: [msg], artifacts: [] }, text)
    tasks.set(id, rec)
    persist()
    if (active) queue.push(rec)
    else void begin(rec)
    return rec
  }

  /** SendMessage / SendStreamingMessage: optional push config in the request's configuration. */
  const send = async (params: Record<string, unknown>, dialect: Dialect): Promise<TaskRec> => {
    const cfg = (params.configuration ?? {}) as Record<string, unknown>
    const rawPush = cfg.taskPushNotificationConfig ?? cfg.pushNotificationConfig
    let pending: ReturnType<typeof decodePushConfig> | undefined
    if (rawPush) {
      pending = decodePushConfig(rawPush, "pending")
      await checkPushUrl(pending.url, opts.allowPrivatePush === true)
    }
    const rec = await accept(params)
    if (pending) addPush(rec, { ...pending, taskId: rec.task.id }, dialect)
    return rec
  }

  const addPush = (rec: TaskRec, c: Omit<PushTarget, "id" | "dialect"> & { id?: string }, dialect: Dialect): PushTarget => {
    const id = c.id || crypto.randomUUID()
    if (!rec.push.has(id) && rec.push.size >= MAX_PUSH_PER_TASK)
      throw new A2AError(ErrorCode.InvalidParams, `at most ${MAX_PUSH_PER_TASK} push configs per task`)
    const target: PushTarget = { id, taskId: rec.task.id, url: c.url, token: c.token, authentication: c.authentication, dialect }
    rec.push.set(id, target)
    persist()
    return target
  }

  const pushSet = async (params: Record<string, unknown>, dialect: Dialect, taskId?: string): Promise<PushTarget> => {
    const c = decodePushConfig(params, taskId)
    const rec = getRec(taskId ?? c.taskId)
    await checkPushUrl(c.url, opts.allowPrivatePush === true)
    return addPush(rec, c, dialect)
  }

  const pushGet = (taskId: unknown, id: unknown): PushTarget => {
    const rec = getRec(taskId)
    const p = typeof id === "string" && id ? rec.push.get(id) : rec.push.values().next().value
    if (!p)
      throw new A2AError(ErrorCode.TaskNotFound, `no push notification config ${typeof id === "string" ? id : ""} on task ${rec.task.id}`.replace("  ", " "))
    return p
  }

  const pushDelete = (taskId: unknown, id: unknown) => {
    const rec = getRec(taskId)
    if (typeof id !== "string" || !rec.push.delete(id))
      throw new A2AError(ErrorCode.TaskNotFound, `no push notification config ${String(id)} on task ${rec.task.id}`)
    persist()
  }

  const list = (params: Record<string, unknown>, dialect: Dialect) => {
    const ctx = typeof params.contextId === "string" && params.contextId ? params.contextId : undefined
    const st = params.status ? normalizeState(params.status) : undefined
    const after = typeof params.statusTimestampAfter === "string" ? params.statusTimestampAfter : undefined
    const all = [...tasks.values()]
      .map((r) => r.task)
      .filter((t) => (!ctx || t.contextId === ctx) && (!st || t.status.state === st) && (!after || (t.status.timestamp ?? "") > after))
    all.reverse() // newest first
    const size = Math.min(100, Math.max(1, numParam(params.pageSize) ?? 50))
    const offset = numParam(params.pageToken) ?? 0
    const historyLength = numParam(params.historyLength) ?? 0
    const withArtifacts = params.includeArtifacts === true || params.includeArtifacts === "true"
    const page = all.slice(offset, offset + size).map((t) => {
      const h = withHistory(t, historyLength)
      return encodeTask(withArtifacts ? h : { ...h, artifacts: undefined }, dialect)
    })
    return { tasks: page, nextPageToken: offset + size < all.length ? String(offset + size) : "", pageSize: size, totalSize: all.length }
  }

  const cancel = async (rec: TaskRec): Promise<Task> => {
    if (rec.phase === "done" || TERMINAL_STATES.has(rec.task.status.state))
      throw new A2AError(ErrorCode.TaskNotCancelable, `task ${rec.task.id} is already ${rec.task.status.state}`)
    if (rec.phase === "queued" || rec.phase === "waiting") {
      const i = queue.indexOf(rec)
      if (i >= 0) queue.splice(i, 1)
      finish(rec, "canceled")
      return rec.task
    }
    const targets = [...rt.agents.values()].filter((a) => !a.closing && (a.busy || a.info.isOrchestrator))
    const approvals = [...rt.state.approvals.values()]
    finish(rec, "canceled", "Canceled — the lead and every busy agent were interrupted; pending approvals were denied.")
    // deny what the team waits on first, so nothing proceeds while the interrupts land
    for (const p of approvals) {
      const deny = p.options.find((o) => o.kind === "reject_once") ?? p.options.find((o) => o.kind.startsWith("reject"))
      await rt.resolvePermission(p.agentId, p.requestId, deny?.optionId ?? null, "cancelled").catch(() => {})
    }
    await Promise.all(targets.map((a) => rt.interrupt(a.info.agentId).catch(() => {})))
    return rec.task
  }

  // ───────────────────────────── agent card ─────────────────────────────

  const skills = [
    {
      id: "code",
      name: "Write & change code",
      description: "Implement features, fix bugs and refactor in this repository; the lead splits the work across agents.",
      tags: ["coding", "multi-agent", "implementation"],
      examples: ["Add a --json flag to the export command", "Fix the flaky login test"],
    },
    {
      id: "review",
      name: "Review changes",
      description: "Cross-agent code review of a change or branch, with concrete findings.",
      tags: ["review", "quality"],
      examples: ["Review the changes on branch feature/auth"],
    },
    {
      id: "investigate",
      name: "Investigate & plan",
      description: "Read the codebase to answer questions, find root causes or draft an implementation plan.",
      tags: ["research", "planning"],
      examples: ["Why does the build fail on Windows?", "Plan a migration from REST to gRPC"],
    },
  ]

  const card = (base: string, extended = false): Record<string, unknown> => {
    const rpc = `${base}/`
    const bearerDesc = "Baton A2A token (`Authorization: Bearer <token>`)"
    const team = extended
      ? [...rt.agents.values()]
          .filter((a) => !a.closing)
          .map((a) => ({
            id: `agent:${a.info.name}`,
            name: a.info.isOrchestrator ? `${a.info.name} (lead)` : a.info.name,
            description: `${a.info.adapter}${a.info.model ? ` · ${a.info.model}` : ""}${a.info.label ? ` — ${a.info.label}` : ""}`,
            tags: ["agent", a.info.adapter],
          }))
      : []
    return {
      name: `Baton · ${rt.state.projectName || "project"}`,
      description: `A Baton team of coding agents working on ${rt.state.projectName || "this project"}: a lead plans and delegates to workers (Claude Code, Codex, OpenCode, …) in their own workspaces. Send a coding task; the task completes with the lead's summary and the unmerged changes per agent.`,
      supportedInterfaces: [
        { url: rpc, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: base, protocolBinding: "HTTP+JSON", protocolVersion: "1.0" },
        { url: rpc, protocolBinding: "JSONRPC", protocolVersion: "0.3" },
      ],
      version: DAEMON_VERSION,
      capabilities: { streaming: true, pushNotifications: true, extendedAgentCard: !!opts.token },
      ...(opts.token
        ? {
            securitySchemes: {
              bearer: { httpAuthSecurityScheme: { scheme: "Bearer", description: bearerDesc }, type: "http", scheme: "bearer", description: bearerDesc },
            },
            securityRequirements: [{ schemes: { bearer: { list: [] } } }],
            security: [{ bearer: [] }],
          }
        : {}),
      defaultInputModes: ["text/plain", "application/json"],
      defaultOutputModes: ["text/plain", "application/json"],
      skills: [...skills, ...team],
      // A2A v0.3 card fields, for clients that predate v1.0
      protocolVersion: A2A_LEGACY_VERSION,
      url: rpc,
      preferredTransport: "JSONRPC",
      ...(opts.token ? { supportsAuthenticatedExtendedCard: true } : {}),
    }
  }

  const signedCards = new Map<string, Record<string, unknown>>()
  const jwk = signingKey ? publicJwk(signingKey) : undefined
  const publicCard = (base: string) => {
    let c = signedCards.get(base)
    if (!c) {
      c = signingKey ? signCard(card(base), signingKey, { kid: jwk?.kid, jku: `${base}/.well-known/jwks.json` }) : card(base)
      signedCards.set(base, c)
    }
    return c
  }
  const extendedCard = (base: string) => {
    if (!opts.token) throw new A2AError(ErrorCode.UnsupportedOperation, "this agent has no extended card (it is served without a token)")
    const c = card(base, true)
    return signingKey ? signCard(c, signingKey, { kid: jwk?.kid, jku: `${base}/.well-known/jwks.json` }) : c
  }

  // ───────────────────────────── HTTP ─────────────────────────────

  const cors = { "access-control-allow-origin": "*" }
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } })
  const rpcError = (id: unknown, code: number, message: string, data?: unknown) =>
    json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } })
  const rpcResult = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id: id ?? null, result })
  const restJson = (body: unknown, status = 200) => json(body, status, { "content-type": "application/a2a+json" })
  const restFail = (e: unknown) => {
    const err = e instanceof A2AError ? e : new A2AError(ErrorCode.Internal, e instanceof Error ? e.message : String(e))
    const r = restErrorBody(err.code, err.message)
    return restJson(r.body, r.status)
  }

  /** SSE: the task snapshot first, then its events until a final one (or the client leaves). */
  const sse = (rec: TaskRec, frame: (e: StreamEvent) => unknown, signal: AbortSignal): Response => {
    const enc = new TextEncoder()
    let close = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        let open = true
        const send = (e: StreamEvent) => {
          if (!open) return
          try {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify(frame(e))}\n\n`))
          } catch {}
        }
        const ping = setInterval(() => {
          try {
            if (open) ctrl.enqueue(enc.encode(": keep-alive\n\n"))
          } catch {}
        }, 15_000)
        close = () => {
          if (!open) return
          open = false
          clearInterval(ping)
          rec.listeners.delete(listener)
          streams.delete(close)
          try {
            ctrl.close()
          } catch {}
        }
        const listener: Listener = (e) => {
          send(e)
          if ((e.kind === "status-update" && e.final) || e.kind === "message") queueMicrotask(close)
        }
        streams.add(close)
        send(structuredClone(rec.task))
        if (isFinalState(rec.task.status.state)) queueMicrotask(close)
        else rec.listeners.add(listener)
        signal.addEventListener("abort", close, { once: true })
      },
      cancel() {
        close()
      },
    })
    return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } })
  }

  /** Blocking SendMessage: wait until the task is final (terminal or waiting for input). */
  const settled = (rec: TaskRec, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (isFinalState(rec.task.status.state)) return resolve()
      const done = () => {
        rec.listeners.delete(l)
        streams.delete(done)
        resolve()
      }
      const l: Listener = (e) => {
        if (e.kind === "status-update" && e.final) done()
      }
      rec.listeners.add(l)
      streams.add(done)
      signal.addEventListener("abort", done, { once: true })
    })

  const authed = (req: Request): boolean => {
    if (!opts.token) return true
    const h = req.headers.get("authorization") ?? ""
    const m = /^Bearer\s+(.+)$/i.exec(h)
    return !!m && same(m[1]!.trim(), opts.token)
  }

  const badVersion = (req: Request, url: URL): string | undefined => {
    const version = req.headers.get("a2a-version") ?? url.searchParams.get("A2A-Version") ?? ""
    return version && !/^(0\.3|1|1\.0)(\.\d+)?$/.test(version.trim()) ? version : undefined
  }

  const isBlocking = (dialect: Dialect, cfg: Record<string, unknown>) => (dialect === "1.0" ? cfg.returnImmediately !== true : cfg.blocking !== false)

  // ── JSON-RPC ──
  const handleRpc = async (req: Request, url: URL, srv: Bun.Server<undefined>): Promise<Response> => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return rpcError(null, ErrorCode.ParseError, "invalid JSON")
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) return rpcError(null, ErrorCode.InvalidRequest, "expected a JSON-RPC 2.0 request object")
    const { id, method, params: rawParams, jsonrpc } = body as { id?: unknown; method?: unknown; params?: unknown; jsonrpc?: unknown }
    if (jsonrpc !== "2.0" || typeof method !== "string" || (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number"))
      return rpcError(id, ErrorCode.InvalidRequest, "invalid JSON-RPC 2.0 request")
    const version = badVersion(req, url)
    if (version)
      return rpcError(id, ErrorCode.VersionNotSupported, `A2A version ${version} is not supported`, [
        { "@type": "VersionNotSupported", supportedVersions: ["1.0", "0.3"] },
      ])
    const m = classifyMethod(method)
    if (!m) return rpcError(id, ErrorCode.MethodNotFound, `method not found: ${method}`)
    const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>
    const cfg = (params.configuration ?? {}) as Record<string, unknown>
    const d = m.dialect
    // v0.3 push methods name the task `id`; v1.0 ones `taskId` (+ config `id`)
    const pushTask = d === "1.0" ? params.taskId : (params.id ?? params.taskId)
    const pushCfgId = d === "1.0" ? params.id : params.pushNotificationConfigId
    try {
      switch (m.kind) {
        case "send": {
          const rec = await send(params, d)
          if (isBlocking(d, cfg)) {
            srv.timeout(req, 0)
            await settled(rec, req.signal)
          }
          return rpcResult(id, encodeEvent(withHistory(rec.task, cfg.historyLength), d))
        }
        case "stream": {
          const rec = await send(params, d)
          srv.timeout(req, 0)
          return sse(rec, (e) => ({ jsonrpc: "2.0", id: id ?? null, result: encodeEvent(e, d) }), req.signal)
        }
        case "get":
          return rpcResult(id, encodeTask(withHistory(getRec(params.id).task, params.historyLength), d))
        case "cancel":
          return rpcResult(id, encodeTask(await cancel(getRec(params.id)), d))
        case "subscribe": {
          const rec = getRec(params.id)
          if (TERMINAL_STATES.has(rec.task.status.state))
            throw new A2AError(ErrorCode.UnsupportedOperation, `task ${rec.task.id} is ${rec.task.status.state}; nothing to subscribe to`)
          srv.timeout(req, 0)
          return sse(rec, (e) => ({ jsonrpc: "2.0", id: id ?? null, result: encodeEvent(e, d) }), req.signal)
        }
        case "list":
          return rpcResult(id, list(params, d))
        case "extendedCard":
          return rpcResult(id, extendedCard(base()))
        case "pushSet":
          return rpcResult(id, encodePushConfig(await pushSet(params, d, typeof pushTask === "string" ? pushTask : undefined), d))
        case "pushGet":
          return rpcResult(id, encodePushConfig(pushGet(pushTask, pushCfgId), d))
        case "pushList": {
          const configs = [...getRec(pushTask).push.values()].map((p) => encodePushConfig(p, d))
          return rpcResult(id, d === "1.0" ? { configs, nextPageToken: "" } : configs)
        }
        case "pushDelete":
          pushDelete(pushTask, pushCfgId)
          return rpcResult(id, d === "1.0" ? {} : null)
      }
    } catch (e) {
      if (e instanceof A2AError) return rpcError(id, e.code, e.message, e.data)
      return rpcError(id, ErrorCode.Internal, e instanceof Error ? e.message : String(e))
    }
  }

  // ── HTTP+JSON / REST ──
  type Route = { kind: MethodKind; taskId?: string; configId?: string }
  const matchRest = (method: string, rawPath: string): Route | "method" | undefined => {
    const path = rawPath.replace(/^\/v1(?=\/)/, "")
    const dec = (s: string | undefined) => (s === undefined ? undefined : decodeURIComponent(s))
    const want = (verbs: string[], r: Route): Route | "method" => (verbs.includes(method) ? r : "method")
    if (path === "/message:send") return want(["POST"], { kind: "send" })
    if (path === "/message:stream") return want(["POST"], { kind: "stream" })
    if (path === "/tasks") return want(["GET"], { kind: "list" })
    if (path === "/extendedAgentCard" || path === "/card") return want(["GET"], { kind: "extendedCard" })
    let m = /^\/tasks\/([^/:]+)$/.exec(path)
    if (m) return want(["GET"], { kind: "get", taskId: dec(m[1]) })
    m = /^\/tasks\/([^/:]+):cancel$/.exec(path)
    if (m) return want(["POST"], { kind: "cancel", taskId: dec(m[1]) })
    m = /^\/tasks\/([^/:]+):subscribe$/.exec(path)
    if (m) return want(["GET", "POST"], { kind: "subscribe", taskId: dec(m[1]) })
    m = /^\/tasks\/([^/:]+)\/pushNotificationConfigs$/.exec(path)
    if (m) return method === "POST" ? { kind: "pushSet", taskId: dec(m[1]) } : want(["GET"], { kind: "pushList", taskId: dec(m[1]) })
    m = /^\/tasks\/([^/:]+)\/pushNotificationConfigs\/([^/]+)$/.exec(path)
    if (m)
      return method === "DELETE"
        ? { kind: "pushDelete", taskId: dec(m[1]), configId: dec(m[2]) }
        : want(["GET"], { kind: "pushGet", taskId: dec(m[1]), configId: dec(m[2]) })
    return undefined
  }

  const handleRest = async (req: Request, url: URL, route: Route, srv: Bun.Server<undefined>): Promise<Response> => {
    const version = badVersion(req, url)
    if (version) return restFail(new A2AError(ErrorCode.VersionNotSupported, `A2A version ${version} is not supported (supported: 1.0, 0.3)`))
    try {
      let body: Record<string, unknown> = {}
      if (req.method === "POST") {
        const text = await req.text()
        if (text.trim()) {
          try {
            const j = JSON.parse(text)
            if (j && typeof j === "object" && !Array.isArray(j)) body = j
            else throw new Error()
          } catch {
            throw new A2AError(ErrorCode.InvalidParams, "request body must be a JSON object")
          }
        }
      }
      const q = Object.fromEntries(url.searchParams)
      switch (route.kind) {
        case "send": {
          const rec = await send(body, "1.0")
          const cfg = (body.configuration ?? {}) as Record<string, unknown>
          if (isBlocking("1.0", cfg)) {
            srv.timeout(req, 0)
            await settled(rec, req.signal)
          }
          return restJson(encodeV1Event(withHistory(rec.task, cfg.historyLength)))
        }
        case "stream": {
          const rec = await send(body, "1.0")
          srv.timeout(req, 0)
          return sse(rec, encodeV1Event, req.signal)
        }
        case "get":
          return restJson(encodeTask(withHistory(getRec(route.taskId).task, numParam(q.historyLength)), "1.0"))
        case "list":
          return restJson(list(q, "1.0"))
        case "cancel":
          return restJson(encodeTask(await cancel(getRec(route.taskId)), "1.0"))
        case "subscribe": {
          const rec = getRec(route.taskId)
          if (TERMINAL_STATES.has(rec.task.status.state))
            throw new A2AError(ErrorCode.UnsupportedOperation, `task ${rec.task.id} is ${rec.task.status.state}; nothing to subscribe to`)
          srv.timeout(req, 0)
          return sse(rec, encodeV1Event, req.signal)
        }
        case "pushSet":
          return restJson(encodePushConfig(await pushSet(body, "1.0", route.taskId), "1.0"))
        case "pushGet":
          return restJson(encodePushConfig(pushGet(route.taskId, route.configId), "1.0"))
        case "pushList":
          return restJson({ configs: [...getRec(route.taskId).push.values()].map((p) => encodePushConfig(p, "1.0")), nextPageToken: "" })
        case "pushDelete":
          pushDelete(route.taskId, route.configId)
          return restJson({})
        case "extendedCard":
          return restJson(extendedCard(base()))
      }
    } catch (e) {
      return restFail(e)
    }
  }

  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? 0,
    idleTimeout: 120,
    fetch: async (req, srv) => {
      const url = new URL(req.url)
      if (req.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            ...cors,
            "access-control-allow-methods": "GET, POST, DELETE",
            "access-control-allow-headers": "authorization, content-type, a2a-version, a2a-extensions",
          },
        })
      if (req.method === "GET" && (url.pathname === "/.well-known/agent-card.json" || url.pathname === "/.well-known/agent.json"))
        return json(publicCard(base()), 200, cors)
      if (req.method === "GET" && url.pathname === "/.well-known/jwks.json") return json({ keys: jwk ? [jwk] : [] }, 200, cors)
      const isRpc = req.method === "POST" && (url.pathname === "/" || url.pathname === "/a2a")
      const route = isRpc ? undefined : matchRest(req.method, url.pathname)
      if (!isRpc && !route) return json({ error: "not found" }, 404)
      if (!authed(req)) return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="baton"' })
      if (isRpc) return handleRpc(req, url, srv)
      if (route === "method") return restJson(restErrorBody(ErrorCode.MethodNotFound, `${req.method} is not allowed on ${url.pathname}`).body, 405)
      return handleRest(req, url, route as Route, srv)
    },
  })

  const port = server.port as number
  const local = `http://${host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`
  const base = () => opts.publicUrl?.replace(/\/+$/, "") ?? local

  // ───────────────────────────── reload ─────────────────────────────

  if (opts.persist) {
    for (const s of loadTasks(opts.persist)) {
      const rec = newRec(s.task, "")
      for (const p of s.push ?? []) rec.push.set(p.id, p)
      tasks.set(s.task.id, rec)
      const st = s.task.status.state
      if (TERMINAL_STATES.has(st)) rec.phase = "done"
      else if (st === "input-required" && s.waiting === "question") rec.phase = "waiting"
      else {
        // it was running (or waiting on an approval that died with the daemon)
        finish(
          rec,
          "failed",
          "Baton restarted while this task was in progress, so it did not finish. Send a new message with the same contextId to pick it up again.",
        )
      }
    }
  }

  return {
    url: base(),
    port,
    push,
    flush: () => store?.flush(),
    stop: () => {
      if (stopped) return
      stopped = true
      unsubscribe()
      clearTimeout(idleTimer)
      clearTimeout(approvalTimer)
      for (const close of [...streams]) close()
      store?.flush()
      push.stop()
      server.stop(true)
    },
  }
}

// ───────────────────────────── lifecycle ─────────────────────────────

const servers = new WeakMap<Runtime, A2AServer & { token?: string }>()

/** Per-project bearer token for the A2A endpoint, kept across restarts (separate from the web view's). */
export function a2aToken(projectRoot: string, rotate = false): string {
  const dir = join(stateDir(), "a2a")
  const file = join(dir, `${createHash("sha1").update(projectRoot).digest("hex").slice(0, 16)}.token`)
  if (!rotate && existsSync(file)) {
    const t = readFileSync(file, "utf8").trim()
    if (t) return t
  }
  const t = randomBytes(24).toString("base64url")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, t, { mode: 0o600 })
  return t
}

export function a2aServer(rt: Runtime): (A2AServer & { token?: string }) | undefined {
  return servers.get(rt)
}

/** Start the A2A endpoint (or return the running one). `noToken` serves without auth (local experiments only). */
export function ensureA2A(
  rt: Runtime,
  opts: { port?: number; host?: string; publicUrl?: string; noToken?: boolean; rotate?: boolean; allowPrivatePush?: boolean } = {},
): A2AServer & { token?: string } {
  const cfg = rt.config.a2a
  const cur = servers.get(rt)
  const host = opts.host ?? cfg.host
  if (cur && !opts.rotate && !opts.port && !opts.host && opts.noToken === undefined) return cur
  cur?.stop()
  const token = opts.noToken || !cfg.token ? undefined : a2aToken(rt.projectRoot, opts.rotate)
  let signingKey: KeyObject | undefined
  try {
    signingKey = a2aSigningKey(rt.projectRoot)
  } catch (e) {
    rt.emit({
      type: "log",
      data: { level: "warn", message: `A2A: card signing key unavailable (${e instanceof Error ? e.message : e}); using a temporary one` },
    })
  }
  const s = startA2AServer(rt, {
    port: opts.port ?? (cfg.port || cur?.port || 0),
    host,
    publicUrl: opts.publicUrl ?? cfg.public_url,
    token,
    idleMs: cfg.idle_ms,
    persist: tasksFile(rt.projectRoot),
    allowPrivatePush: opts.allowPrivatePush ?? cfg.allow_private_push === true,
    questionsAsInput: cfg.questions_as_input,
    signingKey,
  })
  const withToken = Object.assign(s, { token })
  servers.set(rt, withToken)
  rt.emit({ type: "log", data: { level: "info", message: `A2A endpoint at ${s.url}` } })
  return withToken
}

export function stopA2A(rt: Runtime): void {
  servers.get(rt)?.stop()
  servers.delete(rt)
}
