/**
 * Stream-JSON session runtime: one long-lived CLI process with stdin kept open. User messages
 * (and control requests) go in as NDJSON; stdout NDJSON is normalized to Claude Code's shapes
 * and translated to BEP by the Claude adapter's translator.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import type { AdapterContext, AgentEvent, AgentSession, PermissionOptionKind, PromptInput, SessionConfig } from "../../../protocol/src/index.ts"
import { augmentedPath, DEFAULT_PERMISSION_OPTIONS, deferred, killProcessTree, newId, readLines } from "../../../protocol/src/index.ts"
import { ClaudeTranslator } from "../../claude/src/translator.ts"
import { frameError, type NormalizedTool, normalizeMessage, normalizeTool } from "./dialect.ts"
import { removePrivateConfig } from "./presets.ts"
import type { StreamJsonPreset } from "./types.ts"

type Input = Record<string, unknown>

const DENY_MESSAGE = "Denied by user via baton"
/** How long to wait for the `initialize` control response before reporting ready anyway. */
const INIT_TIMEOUT_MS = 30_000
const CONTROL_TIMEOUT_MS = 15_000
/** After interrupt(), close the turn ourselves if no result frame arrives in time. */
const INTERRUPT_GRACE_MS = 10_000
/** close(): time for an interrupted turn to settle, then for the CLI to exit after stdin EOF. */
const CLOSE_SETTLE_MS = 3_000
const CLOSE_TIMEOUT_MS = 5_000
const KILL_TIMEOUT_MS = 2_000
const STDERR_TAIL = 20

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const obj = (v: unknown): Input => (v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {})

export interface Timings {
  initTimeoutMs?: number
  interruptGraceMs?: number
  closeTimeoutMs?: number
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => res(undefined), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        res(v)
      },
      (e) => {
        clearTimeout(t)
        rej(e)
      },
    )
  })
}

export function promptText(input: PromptInput): string {
  if (!input.from || input.from === "user") return input.text
  return `[message from ${input.from}]\n${input.text}`
}

export function childEnv(preset: StreamJsonPreset, cfg: SessionConfig): Record<string, string> {
  const base = preset.buildEnv ? preset.buildEnv(cfg) : { ...process.env }
  const merged: Record<string, string | undefined> = { ...base, PATH: augmentedPath(), ...(cfg.env ?? {}) }
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(merged)) if (v !== undefined) out[k] = v
  return out
}

export function launchArgv(preset: StreamJsonPreset, cfg: SessionConfig, binary: string, resumeId: string | undefined): string[] {
  return [binary, ...(preset.prefixArgs ?? []), ...preset.buildArgs(cfg, { binary, ...(resumeId ? { resumeId } : {}) }), ...(cfg.args ?? [])]
}

export async function startSession(
  preset: StreamJsonPreset,
  binary: string,
  cfg: SessionConfig,
  ctx: AdapterContext,
  timings: Timings = {},
): Promise<AgentSession> {
  const graceMs = timings.interruptGraceMs ?? INTERRUPT_GRACE_MS
  const closeMs = timings.closeTimeoutMs ?? CLOSE_TIMEOUT_MS
  const env = childEnv(preset, cfg)

  // File contents captured when an edit tool_use is first seen (fallback diff base).
  const snapshots = new Map<string, string | null>()
  /** tool_use id → native name/input, restored on BEP tool.call events. */
  const natives = new Map<string, NormalizedTool>()
  // CLIs report paths under their real cwd (e.g. /private/var/… for /var/… on macOS).
  let realCwd = cfg.cwd
  try {
    realCwd = realpathSync(cfg.cwd)
  } catch {}
  // Each snapshot is read once, when the tool's result arrives, then freed.
  const takeSnapshot = (id: string) => {
    const v = snapshots.get(id)
    snapshots.delete(id)
    return v
  }
  const tr = new ClaudeTranslator({ cwd: realCwd, snapshot: takeSnapshot })

  type Proc = ReturnType<typeof spawnProc>
  let proc!: Proc
  let gen = 0
  let closing = false
  let exited = false
  /** Set once startSession() returns; before that an exit makes it throw instead of emitting. */
  let started = false
  let exitReason = ""
  let sentFirst = Boolean(cfg.resumeId)
  let signalInterrupt = false
  let interruptTimer: ReturnType<typeof setTimeout> | undefined
  const exitedD = deferred<void>()
  /** Prompts held by baton until their turn starts (queue: "host"). */
  const hostQueue: { uuid: string; text: string }[] = []
  const pendingControl = new Map<string, ReturnType<typeof deferred<Input>>>()
  const pendingPerms = new Map<string, { d: ReturnType<typeof deferred<string | null>>; cliRequestId: string }>()
  const allowAlways = new Set<string>()
  const denyAlways = new Set<string>()

  const onCtxAbort = () => void session.close()
  ctx.signal.addEventListener("abort", onCtxAbort, { once: true })

  // ───────────────────────── output side ─────────────────────────

  const emit = (events: AgentEvent[]) => {
    for (const e of events) {
      if (e.type === "tool.call") {
        const n = natives.get(e.data.toolCallId)
        if (n && n.name !== e.data.name) e.data = { ...e.data, name: n.name, rawInput: n.input }
      }
      ctx.emit(e)
      if (e.type === "turn.started" && preset.queue === "host") {
        const next = hostQueue.shift()
        if (next) writeUser(next.text, false, next.uuid)
      }
    }
  }

  const write = (msg: unknown): boolean => {
    if (exited) return false
    try {
      proc.stdin.write(`${JSON.stringify(msg)}\n`)
      const r = proc.stdin.flush() as unknown
      // A large write to a dying process flushes asynchronously; never leave that rejection unhandled.
      if (r instanceof Promise) r.catch((e) => ctx.log("warn", `${preset.id}: stdin flush failed: ${e instanceof Error ? e.message : String(e)}`))
      return true
    } catch (e) {
      ctx.log("warn", `${preset.id}: stdin write failed: ${e instanceof Error ? e.message : String(e)}`)
      return false
    }
  }

  const writeUser = (text: string, steer: boolean, uuid: string) => {
    let body = text
    if (!sentFirst && preset.systemPrompt === "first-message" && cfg.systemPrompt)
      body = `<system-instructions>\n${cfg.systemPrompt}\n</system-instructions>\n\n${text}`
    sentFirst = true
    write(preset.encodeUser(body, { steer, uuid, ...(tr.sessionId ? { sessionId: tr.sessionId } : {}) }))
  }

  const controlRequest = (request: Input, timeoutMs = CONTROL_TIMEOUT_MS): Promise<Input> => {
    const requestId = newId("req")
    const d = deferred<Input>()
    pendingControl.set(requestId, d)
    if (!write({ type: "control_request", request_id: requestId, request })) {
      pendingControl.delete(requestId)
      return Promise.reject(new Error("process not running"))
    }
    const t = setTimeout(() => {
      if (pendingControl.delete(requestId)) d.reject(new Error(`control request timed out: ${String(request.subtype)}`))
    }, timeoutMs)
    return d.promise.finally(() => clearTimeout(t))
  }

  // ───────────────────────── permissions (can_use_tool) ─────────────────────────

  const onControlRequest = async (m: Input) => {
    const cliRequestId = str(m.request_id) ?? ""
    const req = obj(m.request)
    const reply = (response: Input) => write({ type: "control_response", response: { subtype: "success", request_id: cliRequestId, response } })
    if (req.subtype !== "can_use_tool") {
      write({
        type: "control_response",
        response: { subtype: "error", request_id: cliRequestId, error: `unsupported control request: ${String(req.subtype)}` },
      })
      return
    }
    const toolName = str(req.tool_name) ?? "tool"
    const input = obj(req.input)
    const toolUseId = str(req.tool_use_id)
    const allow = (extra: Input = {}): Input => ({ behavior: "allow", updatedInput: input, ...(toolUseId ? { toolUseID: toolUseId } : {}), ...extra })
    const deny = (interrupt = false): Input => ({
      behavior: "deny",
      message: DENY_MESSAGE,
      ...(interrupt ? { interrupt: true } : {}),
      ...(toolUseId ? { toolUseID: toolUseId } : {}),
    })
    if (denyAlways.has(toolName)) {
      reply(deny())
      return
    }
    if (allowAlways.has(toolName)) {
      if (toolUseId) emit(tr.toolStarted(toolUseId))
      reply(allow())
      return
    }

    const requestId = newId("perm")
    const d = deferred<string | null>()
    pendingPerms.set(requestId, { d, cliRequestId })
    const norm = normalizeTool(preset.dialect, toolName, input)
    emit(
      tr.permissionRequested(
        requestId,
        norm.name,
        norm.input,
        toolUseId,
        DEFAULT_PERMISSION_OPTIONS,
        str(req.title) ?? str(req.description) ?? str(req.decision_reason),
      ),
    )
    const optionId = await d.promise
    pendingPerms.delete(requestId)
    const kind: PermissionOptionKind | null = DEFAULT_PERMISSION_OPTIONS.find((o) => o.optionId === optionId)?.kind ?? null
    emit([{ type: "permission.resolved", data: { requestId, optionId: kind ? optionId : null, kind, by: kind ? "user" : "cancelled" } }])
    if (tr.status === "awaiting_approval" && pendingPerms.size === 0) emit(tr.setStatus(tr.busy ? "busy" : "ready"))
    if (exited) return
    switch (kind) {
      case "allow_once":
        if (toolUseId) emit(tr.toolStarted(toolUseId))
        reply(allow())
        return
      case "allow_always": {
        if (toolUseId) emit(tr.toolStarted(toolUseId))
        // Claude Code's scoped rule suggestions (e.g. `Bash(npm test:*)`), kept for this session only.
        const suggestions = Array.isArray(req.permission_suggestions)
          ? (req.permission_suggestions as Input[]).filter((s) => s && typeof s === "object").map((s) => ({ ...s, destination: "session" }))
          : []
        if (suggestions.length && preset.dialect === "claude") reply(allow({ updatedPermissions: suggestions }))
        else {
          allowAlways.add(toolName)
          reply(allow())
        }
        return
      }
      case "reject_always":
        denyAlways.add(toolName)
        reply(deny())
        return
      case "reject_once":
        reply(deny())
        return
      default:
        // Unanswered (cancelled / interrupt / close): deny and stop the turn.
        if (!closing) tr.markInterrupting()
        reply(deny(true))
    }
  }

  // ───────────────────────── stdout handling ─────────────────────────

  const handleLine = (line: string) => {
    let m: Input & { type?: unknown }
    try {
      m = JSON.parse(line)
    } catch {
      ctx.log("debug", `${preset.id} stdout (non-JSON): ${line.slice(0, 300)}`)
      return
    }
    if (!m || typeof m !== "object" || typeof m.type !== "string") return
    const type = m.type
    if (type === "control_response") {
      const r = obj(m.response)
      const id = str(r.request_id)
      const d = id ? pendingControl.get(id) : undefined
      if (!d || !id) return
      pendingControl.delete(id)
      if (r.subtype === "error") d.reject(new Error(frameError(r) ?? "control request failed"))
      else d.resolve(obj(r.response))
      return
    }
    if (type === "control_request") {
      void onControlRequest(m).catch((e) => ctx.log("warn", `${preset.id}: control request failed: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    if (type === "control_cancel_request") {
      for (const p of pendingPerms.values()) if (p.cliRequestId === m.request_id) p.d.resolve(null)
      return
    }
    if (type === "keep_alive") return

    const msg = normalizeMessage(preset.dialect, m as Input & { type: string }, {
      onToolUse(id, native, normalized) {
        if (native.name !== normalized.name || native.input !== normalized.input) natives.set(id, native)
        if (normalized.name === "Edit" || normalized.name === "Write" || normalized.name === "MultiEdit") snapshot(id, normalized.input)
      },
    })
    const pre: AgentEvent[] = []
    const err = (type === "result" && m.is_error === true) || (type === "system" && String(m.subtype ?? "").startsWith("error")) ? frameError(m) : undefined
    if (err) pre.push({ type: "error", data: { message: err } })
    const events = [...pre, ...tr.handle(msg as Parameters<ClaudeTranslator["handle"]>[0])]
    if (interruptTimer && !tr.isInterrupting) {
      clearTimeout(interruptTimer)
      interruptTimer = undefined
      signalInterrupt = false
    }
    emit(events)
    // Tools that never got a result (interrupt / denial) keep no snapshot past the turn.
    if (!tr.busy) snapshots.clear()
  }

  const snapshot = (id: string, input: Input) => {
    if (snapshots.has(id)) return
    const fp = str(input.file_path)
    if (!fp) return
    const p = isAbsolute(fp) ? fp : resolve(cfg.cwd, fp)
    try {
      snapshots.set(id, existsSync(p) ? readFileSync(p, "utf8") : null)
    } catch {}
  }

  // ───────────────────────── process lifecycle ─────────────────────────

  function spawnProc(resumeId: string | undefined) {
    const argv = launchArgv(preset, cfg, binary, resumeId)
    ctx.log("debug", `${preset.id}: spawn ${argv.map((a) => (a.length > 80 ? `${a.slice(0, 77)}...` : a)).join(" ")}`)
    // Own process group, so close() can take down the CLI's whole tree (shells, MCP servers…).
    return Bun.spawn(argv, { cwd: cfg.cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true })
  }

  /** Signal the CLI's process group (falls back to the pid alone). */
  const killTree = (p: Proc, sig: NodeJS.Signals) => killProcessTree(p.pid, sig, p)

  const launch = (resumeId: string | undefined) => {
    const myGen = ++gen
    const p = spawnProc(resumeId)
    proc = p
    const tail: string[] = []
    const errDone = (async () => {
      for await (const l of readLines(p.stderr)) {
        tail.push(l)
        if (tail.length > STDERR_TAIL) tail.shift()
        ctx.log("debug", `${preset.id} stderr: ${l}`)
      }
    })().catch(() => {})
    void (async () => {
      try {
        for await (const line of readLines(p.stdout)) handleLine(line)
      } catch (e) {
        ctx.log("warn", `${preset.id}: stdout read failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      await p.exited
      await withTimeout(errDone, 1_000)
      // Children left in the group (e.g. a tool's shell) must not outlive the CLI.
      if (myGen === gen && !signalInterrupt) killTree(p, "SIGTERM")
      onExit(myGen, p.exitCode ?? null, p.signalCode ?? undefined, tail)
    })()
  }

  const onExit = (myGen: number, code: number | null, signal: string | undefined, tail: string[]) => {
    if (myGen !== gen) return
    for (const d of pendingControl.values()) d.reject(new Error("process exited"))
    pendingControl.clear()
    for (const p of pendingPerms.values()) p.d.resolve(null)
    // SIGINT-interrupted CLI exited: resume the same native session in a fresh process.
    const sid = tr.sessionId ?? cfg.resumeId
    if (!closing && signalInterrupt && preset.capabilities.resume && sid) {
      signalInterrupt = false
      if (interruptTimer) clearTimeout(interruptTimer)
      interruptTimer = undefined
      ctx.log("info", `${preset.id}: process exited after interrupt; resuming session ${sid}`)
      try {
        launch(sid)
        emit(tr.forceInterrupted())
        if (!tr.busy) emit(tr.setStatus("ready"))
        return
      } catch (e) {
        ctx.log("error", `${preset.id}: respawn failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    exited = true
    if (interruptTimer) clearTimeout(interruptTimer)
    interruptTimer = undefined
    hostQueue.length = 0
    snapshots.clear()
    let reason = "closed"
    if (!closing) {
      reason = code !== null ? `${preset.displayName} exited with code ${code}` : `${preset.displayName} killed by ${signal ?? "signal"}`
      if (tail.length && code !== 0) exitReason = `${reason}: ${tail.slice(-3).join(" | ")}`
      else exitReason = reason
      if (code !== 0 && started) {
        ctx.log("error", `${preset.id}: ${reason}`)
        emit([{ type: "error", data: { message: reason, ...(tail.length ? { detail: tail.join("\n") } : {}), fatal: true } }])
        emit(tr.setStatus("error"))
      }
    } else exitReason = reason
    // A failed start throws from startSession() instead of reporting the exit as events.
    if (started) {
      if (tr.busy) {
        // Closing ends the turn as interrupted; an unexpected exit fails it (host reports an error result).
        if (closing) emit([{ type: "turn.interrupted", data: { turnId: tr.currentTurnId } }])
        else emit(tr.failTurn())
      }
      emit(tr.setStatus("exited"))
      emit([{ type: "agent.exited", data: { code, reason } }])
    }
    ctx.signal.removeEventListener("abort", onCtxAbort)
    exitedD.resolve()
  }

  // ───────────────────────── session API ─────────────────────────

  const send = (text: string) => {
    const uuid = crypto.randomUUID()
    if (preset.queue === "host") hostQueue.push({ uuid, text })
    else writeUser(text, false, uuid)
    emit(tr.userPrompt(uuid, text))
  }

  const ensureOpen = () => {
    if (exited && !closing && exitReason) throw new Error(`${preset.displayName} is not running (${exitReason})`)
    if (closing || exited) throw new Error("session closed")
    // The process is gone but its pipes have not drained yet: fail fast rather than write into the void.
    if (!signalInterrupt && (proc.exitCode !== null || proc.signalCode !== null)) throw new Error(`${preset.displayName} is not running`)
  }

  const doInterrupt = async () => {
    if (!tr.busy || exited) return
    tr.markInterrupting()
    for (const p of pendingPerms.values()) p.d.resolve(null)
    if (preset.interrupt === "control") {
      try {
        await controlRequest({ subtype: "interrupt" })
      } catch (e) {
        ctx.log("warn", `${preset.id}: interrupt failed: ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      signalInterrupt = true
      // SIGINT the CLI only: its tool children are handled by the CLI's own interrupt logic.
      proc.kill("SIGINT")
    }
    if (tr.isInterrupting && !interruptTimer)
      interruptTimer = setTimeout(() => {
        interruptTimer = undefined
        signalInterrupt = false
        emit(tr.forceInterrupted())
      }, graceMs)
  }

  const session: AgentSession = {
    async prompt(p) {
      ensureOpen()
      send(promptText(p))
    },
    ...(preset.steer === "native"
      ? {
          async steer(p: PromptInput) {
            ensureOpen()
            const text = promptText(p)
            if (!tr.busy || preset.queue === "cli") {
              // Claude Code drains queued input between tool calls, reporting consumption by uuid.
              send(text)
              return
            }
            // Amp: `steer: true` folds the message into the running turn (no separate result).
            const uuid = crypto.randomUUID()
            emit([{ type: "message.completed", data: { messageId: uuid, role: "user", text } }])
            writeUser(text, true, uuid)
          },
        }
      : {}),
    interrupt: doInterrupt,
    async respondPermission(requestId, optionId) {
      pendingPerms.get(requestId)?.d.resolve(optionId)
    },
    ...(preset.control
      ? {
          async setModel(model: string) {
            ensureOpen()
            await controlRequest({ subtype: "set_model", model })
            emit([{ type: "agent.updated", data: { model } }])
          },
        }
      : {}),
    resumeId() {
      return tr.sessionId ?? cfg.resumeId
    },
    async close() {
      if (closing || exited) return exitedD.promise
      closing = true
      if (interruptTimer) clearTimeout(interruptTimer)
      interruptTimer = undefined
      for (const p of pendingPerms.values()) p.d.resolve(null)
      hostQueue.length = 0
      // Stop a running turn the CLI's own way first (never SIGTERM Claude mid-turn).
      if (tr.busy && preset.interrupt === "control") {
        tr.markInterrupting()
        await withTimeout(
          controlRequest({ subtype: "interrupt" }, CLOSE_SETTLE_MS).catch(() => undefined),
          CLOSE_SETTLE_MS,
        )
      } else if (tr.busy) proc.kill("SIGINT")
      // Graceful: EOF on stdin lets the CLI finish and exit; escalate only if it lingers.
      try {
        proc.stdin.end()
      } catch {}
      if ((await withTimeout(exitedD.promise, closeMs)) === undefined && !exited) {
        killTree(proc, "SIGINT")
        if ((await withTimeout(exitedD.promise, KILL_TIMEOUT_MS)) === undefined && !exited) killTree(proc, "SIGKILL")
      }
      await withTimeout(exitedD.promise, KILL_TIMEOUT_MS)
      // Whatever the CLI left behind in its process group goes with it.
      killTree(proc, "SIGKILL")
      removePrivateConfig(cfg.agentId)
    },
  }

  ctx.emit({ type: "agent.status", data: { status: "starting" } })
  launch(cfg.resumeId)

  if (preset.control) {
    try {
      const init = await withTimeout(
        controlRequest({ subtype: "initialize", ...(preset.initialize?.(cfg) ?? {}) }, timings.initTimeoutMs ?? INIT_TIMEOUT_MS),
        timings.initTimeoutMs ?? INIT_TIMEOUT_MS,
      )
      if (!init) ctx.log("warn", `${preset.id}: initialize handshake timed out`)
    } catch (e) {
      ctx.log("warn", `${preset.id}: initialize failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (exited) {
    ctx.signal.removeEventListener("abort", onCtxAbort)
    throw new Error(`${preset.displayName} failed to start: ${exitReason || "exited"}`)
  }
  started = true
  if (tr.status === "starting") emit(tr.setStatus("ready"))
  return session
}
