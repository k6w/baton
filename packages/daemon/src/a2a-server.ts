/**
 * A2A server: exposes the whole Baton team as one Agent2Agent agent.
 *
 * Speaks the JSON-RPC binding of A2A v1.0 (`SendMessage`, `SendStreamingMessage`, `GetTask`,
 * `ListTasks`, `CancelTask`, `SubscribeToTask`) and, for older clients, v0.3 (`message/send`,
 * `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`) on the same endpoint — the
 * dialect of every response follows the method name of its request. The agent card
 * (`/.well-known/agent-card.json`, also `/.well-known/agent.json`) is public and lists both.
 *
 * A new task hands the message to the lead (orchestrator). It stays `working` — streaming the
 * lead's messages as status updates — until the lead's turn is over and the whole team has been
 * idle for `idleMs`; then it completes with the lead's final message (status message + `response`
 * artifact) and a `changes` artifact listing each agent's unmerged changes. While any agent waits
 * for a human approval the task is `input-required` (the question is the status message); a
 * follow-up message on that task saying "allow" / "deny" answers the oldest pending approval.
 * Tasks run one at a time (the team has one lead); later ones wait in `submitted`. Every task of
 * a context talks to the same lead, so a contextId naturally continues the conversation.
 *
 * Bound to 127.0.0.1 unless a host is given. With a token, every JSON-RPC call needs
 * `Authorization: Bearer <token>`.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  A2A_LEGACY_VERSION,
  A2AError,
  type Artifact,
  classifyMethod,
  type Dialect,
  decodeMessage,
  ErrorCode,
  encodeEvent,
  encodeTask,
  isFinalState,
  type Message,
  normalizeState,
  type Part,
  type StreamEvent,
  type Task,
  type TaskState,
  TERMINAL_STATES,
  textMessage,
} from "@batonsh/adapter-a2a/wire"
import { stateDir } from "@batonsh/kernel"
import type { BatonEvent, PendingApproval } from "@batonsh/protocol"
import { DAEMON_VERSION } from "./control.ts"
import type { Runtime } from "./runtime.ts"

export interface A2AServerOptions {
  port?: number
  host?: string
  /** Require `Authorization: Bearer <token>` on JSON-RPC calls (the card stays public). */
  token?: string
  /** Externally reachable base URL (tunnel / reverse proxy) advertised in the agent card. */
  publicUrl?: string
  /** How long the team must be quiet before a task completes (default 2000 ms). */
  idleMs?: number
  /** Grace period before a new approval request flips the task to input-required (default 300 ms; policy may answer first). */
  approvalGraceMs?: number
}

export interface A2AServer {
  url: string
  port: number
  stop(): void
}

type Listener = (e: StreamEvent) => void

interface TaskRec {
  task: Task
  text: string
  phase: "queued" | "running" | "done"
  startSeq: number
  leadTurnSeen: boolean
  leadTurnEnded: boolean
  leadFailed: boolean
  lastError?: string
  lastLeadText: string
  /** The approval that put the task into input-required. */
  approvalId?: string
  listeners: Set<Listener>
}

const now = () => new Date().toISOString()
const MAX_TASKS = 500

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

function withHistory(t: Task, historyLength: unknown): Task {
  if (typeof historyLength !== "number" || historyLength < 0) return t
  return { ...t, history: historyLength === 0 ? [] : (t.history ?? []).slice(-historyLength) }
}

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

  // ───────────────────────────── task state ─────────────────────────────

  const publish = (rec: TaskRec, e: StreamEvent) => {
    for (const l of [...rec.listeners]) l(e)
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

  const finish = (rec: TaskRec, state: TaskState, text?: string) => {
    if (rec.phase === "done") return
    rec.phase = "done"
    setStatus(rec, state, text ? agentMessage(rec, text) : undefined)
    rec.listeners.clear()
    if (active === rec) {
      active = undefined
      clearTimeout(idleTimer)
      clearTimeout(approvalTimer)
      const next = queue.shift()
      if (next) void begin(next)
    }
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
      if (!rec.leadTurnEnded || !teamIdle()) return scheduleIdle()
      complete(rec)
    }, idleMs)
    idleTimer.unref?.()
  }

  const complete = (rec: TaskRec) => {
    const lead = rt.orchestrator()
    const text = rec.lastLeadText || lead?.lastAssistantText || ""
    if (rec.leadFailed) {
      finish(rec, "failed", rec.lastError ?? (text || "the lead's turn failed"))
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

  const onEvent = (e: BatonEvent) => {
    const rec = active
    if (rec?.phase !== "running" || e.seq <= rec.startSeq) return
    if (e.agentId && e.agentId === leadId()) {
      switch (e.type) {
        case "turn.started":
          rec.leadTurnSeen = true
          rec.leadTurnEnded = false
          rec.leadFailed = false
          break
        case "turn.completed":
        case "turn.interrupted":
          if (rec.leadTurnSeen) {
            rec.leadTurnEnded = true
            rec.leadFailed = e.type === "turn.completed" && e.data.stopReason === "error"
          }
          break
        case "error":
          rec.lastError = e.data.message
          break
        case "message.completed":
          if (e.data.role === "assistant" && e.data.text.trim()) {
            rec.lastLeadText = e.data.text
            if (rec.task.status.state === "working") setStatus(rec, "working", agentMessage(rec, e.data.text))
            else rec.task.history?.push(agentMessage(rec, e.data.text))
          }
          break
        case "agent.exited":
          finish(rec, "failed", `the lead agent exited${e.data.reason ? ` (${e.data.reason})` : ""}`)
          return
      }
    }
    if (e.type === "permission.requested") {
      clearTimeout(approvalTimer)
      approvalTimer = setTimeout(checkApprovals, graceMs)
      approvalTimer.unref?.()
    } else if (e.type === "permission.resolved" || e.type === "agent.exited") queueMicrotask(checkApprovals)
    scheduleIdle()
  }
  const unsubscribe = rt.store.subscribe(onEvent)

  // ───────────────────────────── JSON-RPC methods ─────────────────────────────

  const getRec = (params: Record<string, unknown>): TaskRec => {
    const id = params.id
    if (typeof id !== "string") throw new A2AError(ErrorCode.InvalidParams, "params.id (task id) is required")
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
      if (lead) await rt.promptAgent(lead.info.agentId, text, { from: "a2a", delivery: lead.busy && lead.caps.steer ? "steer" : "queue" })
      return rec
    }
    const contextId = msg.contextId || crypto.randomUUID()
    const id = crypto.randomUUID()
    msg.contextId = contextId
    msg.taskId = id
    const rec: TaskRec = {
      task: { kind: "task", id, contextId, status: { state: "submitted", timestamp: now() }, history: [msg], artifacts: [] },
      text,
      phase: "queued",
      startSeq: 0,
      leadTurnSeen: false,
      leadTurnEnded: false,
      leadFailed: false,
      lastLeadText: "",
      listeners: new Set(),
    }
    tasks.set(id, rec)
    if (active) queue.push(rec)
    else void begin(rec)
    return rec
  }

  const cancel = async (rec: TaskRec): Promise<Task> => {
    if (rec.phase === "done" || TERMINAL_STATES.has(rec.task.status.state))
      throw new A2AError(ErrorCode.TaskNotCancelable, `task ${rec.task.id} is already ${rec.task.status.state}`)
    if (rec.phase === "queued") {
      const i = queue.indexOf(rec)
      if (i >= 0) queue.splice(i, 1)
      finish(rec, "canceled")
      return rec.task
    }
    const targets = [...rt.agents.values()].filter((a) => !a.closing && (a.busy || a.info.isOrchestrator))
    finish(rec, "canceled", "Canceled — the lead and every busy agent were interrupted.")
    await Promise.all(targets.map((a) => rt.interrupt(a.info.agentId).catch(() => {})))
    return rec.task
  }

  const card = (base: string) => {
    const rpc = `${base}/`
    const bearerDesc = "Baton A2A token (`Authorization: Bearer <token>`)"
    return {
      name: `Baton · ${rt.state.projectName || "project"}`,
      description: `A Baton team of coding agents working on ${rt.state.projectName || "this project"}: a lead plans and delegates to workers (Claude Code, Codex, OpenCode, …) in their own workspaces. Send a coding task; the task completes with the lead's summary and the unmerged changes per agent.`,
      supportedInterfaces: [
        { url: rpc, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url: rpc, protocolBinding: "JSONRPC", protocolVersion: "0.3" },
      ],
      version: DAEMON_VERSION,
      capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, stateTransitionHistory: false },
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
      skills: [
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
      ],
      // A2A v0.3 card fields, for clients that predate v1.0
      protocolVersion: A2A_LEGACY_VERSION,
      url: rpc,
      preferredTransport: "JSONRPC",
    }
  }

  // ───────────────────────────── HTTP ─────────────────────────────

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } })
  const rpcError = (id: unknown, code: number, message: string, data?: unknown) =>
    json({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } })
  const rpcResult = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id: id ?? null, result })

  /** SSE: the task snapshot first, then its events until a final one (or the client leaves). */
  const sse = (rec: TaskRec, id: unknown, dialect: Dialect, signal: AbortSignal): Response => {
    const enc = new TextEncoder()
    let close = () => {}
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        let open = true
        const send = (e: StreamEvent) => {
          if (!open) return
          try {
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result: encodeEvent(e, dialect) })}\n\n`))
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

  const server = Bun.serve({
    hostname: host,
    port: opts.port ?? 0,
    idleTimeout: 120,
    fetch: async (req, srv) => {
      const url = new URL(req.url)
      const cors = { "access-control-allow-origin": "*" }
      if (req.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            ...cors,
            "access-control-allow-methods": "GET, POST",
            "access-control-allow-headers": "authorization, content-type, a2a-version, a2a-extensions",
          },
        })
      if (req.method === "GET" && (url.pathname === "/.well-known/agent-card.json" || url.pathname === "/.well-known/agent.json"))
        return json(card(opts.publicUrl?.replace(/\/+$/, "") ?? local), 200, cors)
      if (req.method !== "POST" || (url.pathname !== "/" && url.pathname !== "/a2a")) return json({ error: "not found" }, 404)
      if (!authed(req)) return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer realm="baton"' })

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
      const version = req.headers.get("a2a-version") ?? url.searchParams.get("A2A-Version") ?? ""
      if (version && !/^(0\.3|1|1\.0)(\.\d+)?$/.test(version.trim()))
        return rpcError(id, ErrorCode.VersionNotSupported, `A2A version ${version} is not supported`, [
          { "@type": "VersionNotSupported", supportedVersions: ["1.0", "0.3"] },
        ])
      const m = classifyMethod(method)
      if (!m) return rpcError(id, ErrorCode.MethodNotFound, `method not found: ${method}`)
      const params = (rawParams && typeof rawParams === "object" ? rawParams : {}) as Record<string, unknown>
      const cfg = (params.configuration ?? {}) as Record<string, unknown>
      try {
        switch (m.kind) {
          case "send": {
            const rec = await accept(params)
            const blocking = m.dialect === "1.0" ? cfg.returnImmediately !== true : cfg.blocking !== false
            if (blocking) {
              srv.timeout(req, 0)
              await settled(rec, req.signal)
            }
            return rpcResult(id, encodeEvent(withHistory(rec.task, cfg.historyLength), m.dialect))
          }
          case "stream": {
            const rec = await accept(params)
            srv.timeout(req, 0)
            return sse(rec, id, m.dialect, req.signal)
          }
          case "get":
            return rpcResult(id, encodeTask(withHistory(getRec(params).task, params.historyLength), m.dialect))
          case "cancel":
            return rpcResult(id, encodeTask(await cancel(getRec(params)), m.dialect))
          case "subscribe": {
            const rec = getRec(params)
            if (TERMINAL_STATES.has(rec.task.status.state))
              throw new A2AError(ErrorCode.UnsupportedOperation, `task ${rec.task.id} is ${rec.task.status.state}; nothing to subscribe to`)
            srv.timeout(req, 0)
            return sse(rec, id, m.dialect, req.signal)
          }
          case "list": {
            const ctx = typeof params.contextId === "string" ? params.contextId : undefined
            const st = params.status ? normalizeState(params.status) : undefined
            const all = [...tasks.values()].map((r) => r.task).filter((t) => (!ctx || t.contextId === ctx) && (!st || t.status.state === st))
            all.reverse() // newest first
            const size = Math.min(100, Math.max(1, typeof params.pageSize === "number" ? params.pageSize : 50))
            const offset = typeof params.pageToken === "string" && /^\d+$/.test(params.pageToken) ? Number(params.pageToken) : 0
            const page = all.slice(offset, offset + size).map((t) => {
              const h = withHistory(t, typeof params.historyLength === "number" ? params.historyLength : 0)
              return encodeTask(params.includeArtifacts === true ? h : { ...h, artifacts: undefined }, m.dialect)
            })
            return rpcResult(id, { tasks: page, nextPageToken: offset + size < all.length ? String(offset + size) : "", pageSize: size, totalSize: all.length })
          }
          case "extendedCard":
            throw new A2AError(ErrorCode.ExtendedCardNotConfigured, "no extended agent card")
          case "push":
            throw new A2AError(ErrorCode.PushNotificationNotSupported, "push notifications are not supported")
        }
      } catch (e) {
        if (e instanceof A2AError) return rpcError(id, e.code, e.message, e.data)
        return rpcError(id, ErrorCode.Internal, e instanceof Error ? e.message : String(e))
      }
    },
  })

  const port = server.port as number
  const local = `http://${host.includes(":") ? `[${host}]` : host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`

  return {
    url: opts.publicUrl?.replace(/\/+$/, "") ?? local,
    port,
    stop: () => {
      if (stopped) return
      stopped = true
      unsubscribe()
      clearTimeout(idleTimer)
      clearTimeout(approvalTimer)
      for (const close of [...streams]) close()
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
  opts: { port?: number; host?: string; publicUrl?: string; noToken?: boolean; rotate?: boolean } = {},
): A2AServer & { token?: string } {
  const cfg = rt.config.a2a
  const cur = servers.get(rt)
  const host = opts.host ?? cfg.host
  if (cur && !opts.rotate && !opts.port && !opts.host && opts.noToken === undefined) return cur
  cur?.stop()
  const token = opts.noToken || !cfg.token ? undefined : a2aToken(rt.projectRoot, opts.rotate)
  const s = startA2AServer(rt, {
    port: opts.port ?? (cfg.port || cur?.port || 0),
    host,
    publicUrl: opts.publicUrl ?? cfg.public_url,
    token,
    idleMs: cfg.idle_ms,
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
