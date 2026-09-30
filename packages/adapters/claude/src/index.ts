/**
 * Claude Code adapter: drives the real `claude` binary through @anthropic-ai/claude-agent-sdk in
 * streaming-input mode (one long-lived query() per session) and translates its messages to BEP.
 */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import {
  type CanUseTool,
  type HookCallback,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import type { AgentAdapter, AgentEvent, AgentSession, DetectResult, PermissionOptionKind, PromptInput, SessionConfig } from "@batonsh/protocol"
import { AsyncQueue, DEFAULT_PERMISSION_OPTIONS, deferred, defineAdapter, newId, parseVersion, runCapture } from "@batonsh/protocol"
import { baseOptions, buildEnv, resolveBinary } from "./options.ts"
import { ClaudeTranslator } from "./translator.ts"

export { baseOptions, buildEnv, permissionModeFor } from "./options.ts"
export { ClaudeTranslator } from "./translator.ts"

const PROTOCOLS = ["agent-sdk", "stream-json"]
const DENY_MESSAGE = "Denied by user via baton"
/** How long to wait for the CLI's initialize handshake before reporting ready anyway. */
const INIT_TIMEOUT_MS = 30_000
/** After interrupt(), close the turn ourselves if no result frame arrives in time. */
const INTERRUPT_GRACE_MS = 10_000
const CLOSE_TIMEOUT_MS = 5_000

async function detect(opts?: { command?: string }): Promise<DetectResult> {
  const path = resolveBinary(opts?.command)
  if (!path) return { installed: false, auth: "unknown", authHint: "install Claude Code: https://claude.com/claude-code", protocols: PROTOCOLS }
  const env = buildEnv({})
  const v = await runCapture([path, "--version"], { timeoutMs: 10_000, env }).catch(() => undefined)
  const version = v ? parseVersion(v.stdout) : undefined
  const notes: string[] = []

  // Heuristic credential presence (never reads secrets).
  let hasCreds = false
  for (const k of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ])
    if (process.env[k]) hasCreds = true
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
  if (!hasCreds && existsSync(join(configDir, ".credentials.json"))) hasCreds = true
  if (!hasCreds && process.platform === "darwin") {
    // Exit code only: 0 = an item exists. Without -w/-g no secret is printed (and output is discarded).
    const r = await runCapture(["security", "find-generic-password", "-s", "Claude Code-credentials"], { timeoutMs: 5_000 }).catch(() => undefined)
    if (r?.code === 0) hasCreds = true
  }

  // The CLI's own view is authoritative when available.
  let loggedIn: boolean | undefined
  const s = await runCapture([path, "auth", "status"], { timeoutMs: 10_000, env }).catch(() => undefined)
  if (s?.code !== undefined) {
    try {
      const j = JSON.parse(s.stdout) as { loggedIn?: unknown }
      if (typeof j.loggedIn === "boolean") loggedIn = j.loggedIn
    } catch {}
  }
  let auth: DetectResult["auth"]
  if (loggedIn === true) auth = "ok"
  else if (loggedIn === false) {
    auth = hasCreds ? "unknown" : "missing"
    if (hasCreds) notes.push("credentials found but `claude auth status` reports not logged in (keychain locked or token expired?)")
  } else auth = hasCreds ? "ok" : "unknown"
  return {
    installed: true,
    ...(version ? { version } : {}),
    path,
    auth,
    ...(auth !== "ok" ? { authHint: "run `claude` and use /login, or set ANTHROPIC_API_KEY" } : {}),
    protocols: PROTOCOLS,
    ...(notes.length ? { notes } : {}),
  }
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

function promptText(input: PromptInput): string {
  if (!input.from || input.from === "user") return input.text
  return `[message from ${input.from}]\n${input.text}`
}

async function start(cfg: SessionConfig, ctx: AdapterContextLike): Promise<AgentSession> {
  const binary = resolveBinary(cfg.command)
  if (!binary) throw new Error("Claude Code (`claude`) not found on PATH; install it or set the agent's command")
  const emit = (events: AgentEvent[]) => {
    for (const e of events) ctx.emit(e)
  }

  // File contents captured right before Write/Edit/MultiEdit run (fallback diff source).
  // Each snapshot is read once, when the tool's result arrives, then freed.
  const snapshots = new Map<string, string | null>()
  const takeSnapshot = (id: string) => {
    const v = snapshots.get(id)
    snapshots.delete(id)
    return v
  }
  const tr = new ClaudeTranslator({ cwd: cfg.cwd, snapshot: takeSnapshot })
  const input = new AsyncQueue<SDKUserMessage>()
  const abort = new AbortController()
  const onCtxAbort = () => void session.close()
  ctx.signal.addEventListener("abort", onCtxAbort, { once: true })

  const allowAlways = new Set<string>()
  const denyAlways = new Set<string>()
  const pendingPerms = new Map<string, ReturnType<typeof deferred<string | null>>>()
  let closing = false
  /** Set once start() has returned the session; before that a dead CLI makes start() throw. */
  let started = false
  /** The CLI process is gone (loop finished); `exitReason` says why. */
  let dead = false
  let exitReason = ""
  let interruptTimer: ReturnType<typeof setTimeout> | undefined

  const canUseTool: CanUseTool = async (toolName, toolInput, opts): Promise<PermissionResult> => {
    if (denyAlways.has(toolName)) return { behavior: "deny", message: DENY_MESSAGE }
    if (allowAlways.has(toolName)) {
      emit(tr.toolStarted(opts.toolUseID))
      return { behavior: "allow", updatedInput: toolInput }
    }
    const requestId = newId("perm")
    const d = deferred<string | null>()
    pendingPerms.set(requestId, d)
    const onAbort = () => d.resolve(null)
    opts.signal.addEventListener("abort", onAbort, { once: true })
    emit(
      tr.permissionRequested(requestId, toolName, toolInput, opts.toolUseID, DEFAULT_PERMISSION_OPTIONS, opts.title ?? opts.description ?? opts.decisionReason),
    )
    const optionId = await d.promise
    opts.signal.removeEventListener("abort", onAbort)
    pendingPerms.delete(requestId)
    const kind: PermissionOptionKind | null = DEFAULT_PERMISSION_OPTIONS.find((o) => o.optionId === optionId)?.kind ?? null
    emit([
      {
        type: "permission.resolved",
        data: { requestId, optionId: kind ? optionId : null, kind, by: kind ? "user" : "cancelled" },
      },
    ])
    if (tr.status === "awaiting_approval" && pendingPerms.size === 0) emit(tr.setStatus(tr.busy ? "busy" : "ready"))
    switch (kind) {
      case "allow_once":
        emit(tr.toolStarted(opts.toolUseID))
        return { behavior: "allow", updatedInput: toolInput }
      case "allow_always": {
        emit(tr.toolStarted(opts.toolUseID))
        // Prefer Claude Code's own scoped rule suggestions (e.g. `Bash(npm test:*)`), kept for
        // this session only; fall back to a baton-side allow-set keyed by tool name.
        const suggestions: PermissionUpdate[] = opts.suppressAlwaysAllowRule
          ? []
          : (opts.suggestions ?? []).map((s) => ({ ...s, destination: "session" }) as PermissionUpdate)
        if (suggestions.length) return { behavior: "allow", updatedInput: toolInput, updatedPermissions: suggestions }
        allowAlways.add(toolName)
        return { behavior: "allow", updatedInput: toolInput }
      }
      case "reject_always":
        denyAlways.add(toolName)
        return { behavior: "deny", message: DENY_MESSAGE }
      case "reject_once":
        return { behavior: "deny", message: DENY_MESSAGE }
      default:
        // No answer (null / cancelled): deny and stop the turn rather than letting the model retry.
        if (!opts.signal.aborted && !closing) tr.markInterrupting()
        return { behavior: "deny", message: DENY_MESSAGE, interrupt: true }
    }
  }

  const snapshotHook: HookCallback = async (hookInput) => {
    if (hookInput.hook_event_name === "PreToolUse") {
      const ti = (hookInput.tool_input ?? {}) as { file_path?: unknown }
      if (typeof ti.file_path === "string") {
        const p = isAbsolute(ti.file_path) ? ti.file_path : resolve(cfg.cwd, ti.file_path)
        let content: string | null = null
        try {
          content = existsSync(p) ? readFileSync(p, "utf8") : null
        } catch {}
        snapshots.set(hookInput.tool_use_id, content)
      }
    }
    return { continue: true }
  }

  const base = baseOptions(cfg, binary)
  const q: Query = query({
    prompt: input,
    options: {
      ...base,
      abortController: abort,
      canUseTool,
      hooks: { ...(base.hooks ?? {}), PreToolUse: [...(base.hooks?.PreToolUse ?? []), { matcher: "Write|Edit|MultiEdit", hooks: [snapshotHook] }] },
      stderr: (data) => {
        for (const line of data.split("\n")) if (line.trim()) ctx.log("debug", `claude stderr: ${line}`)
      },
    },
  })

  ctx.emit({ type: "agent.status", data: { status: "starting" } })

  const loop = (async () => {
    let reason = "closed"
    let code: number | null = 0
    try {
      for await (const m of q) {
        const events = tr.handle(m)
        if (interruptTimer && !tr.isInterrupting) {
          clearTimeout(interruptTimer)
          interruptTimer = undefined
        }
        emit(events)
        // Tools that never got a result (interrupt / denial) keep no snapshot past the turn.
        if (!tr.busy) snapshots.clear()
      }
      if (!closing) reason = "claude exited"
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!closing) {
        reason = msg
        const exit = /exited with code (\d+)/.exec(msg)
        code = exit ? Number(exit[1]) : null
        ctx.log(started ? "error" : "debug", `claude: ${msg}`)
        if (started) {
          emit([{ type: "error", data: { message: msg, fatal: true } }])
          emit(tr.setStatus("error"))
        }
      } else ctx.log("debug", `claude ended during close: ${msg}`)
    } finally {
      dead = true
      exitReason = reason
      input.close()
      if (interruptTimer) clearTimeout(interruptTimer)
      interruptTimer = undefined
      for (const d of pendingPerms.values()) d.resolve(null)
      snapshots.clear()
      // A failed start() throws instead of reporting the exit as events.
      if (started) {
        if (tr.busy) {
          // Closing (or an interrupt in flight) ends the turn as interrupted; an unexpected exit fails it.
          if (closing) emit([{ type: "turn.interrupted", data: { turnId: tr.currentTurnId } }])
          else emit(tr.failTurn())
        }
        emit(tr.setStatus("exited"))
        emit([{ type: "agent.exited", data: { code, reason } }])
      }
      ctx.signal.removeEventListener("abort", onCtxAbort)
    }
  })()

  const send = (text: string) => {
    const uuid = crypto.randomUUID()
    emit(tr.userPrompt(uuid, text))
    input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: uuid as SDKUserMessage["uuid"] & string })
  }

  const ensureOpen = () => {
    if (dead) throw new Error(`claude is not running (${exitReason || "exited"})`)
    if (closing || input.isClosed) throw new Error("session closed")
  }

  const session: AgentSession = {
    async prompt(p) {
      ensureOpen()
      send(promptText(p))
    },
    // Claude Code drains queued user input at the next opportunity inside a running turn
    // (between tool calls), so steering is the same as sending another message.
    async steer(p) {
      ensureOpen()
      send(promptText(p))
    },
    async interrupt() {
      if (!tr.busy || dead) return
      tr.markInterrupting()
      for (const d of pendingPerms.values()) d.resolve(null)
      try {
        await q.interrupt()
      } catch (e) {
        ctx.log("warn", `interrupt failed: ${e instanceof Error ? e.message : String(e)}`)
      }
      if (tr.isInterrupting && !interruptTimer)
        interruptTimer = setTimeout(() => {
          interruptTimer = undefined
          emit(tr.forceInterrupted())
        }, INTERRUPT_GRACE_MS)
    },
    async respondPermission(requestId, optionId) {
      pendingPerms.get(requestId)?.resolve(optionId)
    },
    async setModel(model) {
      ensureOpen()
      await q.setModel(model)
      emit([{ type: "agent.updated", data: { model } }])
    },
    resumeId() {
      return tr.sessionId ?? cfg.resumeId
    },
    async close() {
      if (closing) return loop
      closing = true
      if (interruptTimer) clearTimeout(interruptTimer)
      for (const d of pendingPerms.values()) d.resolve(null)
      // Graceful: end the input stream and let the CLI finish; abort only if it lingers.
      input.close()
      const done = await withTimeout(
        loop.then(() => true),
        CLOSE_TIMEOUT_MS,
      )
      if (!done) {
        abort.abort()
        q.close()
        await withTimeout(loop, CLOSE_TIMEOUT_MS)
      }
    },
  }

  // Wait for the initialize handshake so "ready" means the CLI is actually up. A CLI that dies
  // (or rejects initialize) during startup fails start() instead of reporting ready.
  let initError: string | undefined
  try {
    const init = await withTimeout(
      Promise.race([q.initializationResult(), loop.then(() => Promise.reject(new Error(exitReason || "claude exited")))]),
      INIT_TIMEOUT_MS,
    )
    if (!init) ctx.log("warn", "claude initialize handshake timed out")
  } catch (e) {
    initError = e instanceof Error ? e.message : String(e)
  }
  if (initError !== undefined || dead) {
    const msg = initError ?? (exitReason || "claude exited")
    ctx.log("error", `claude failed to start: ${msg}`)
    closing = true
    input.close()
    abort.abort()
    try {
      q.close()
    } catch {}
    await withTimeout(loop, CLOSE_TIMEOUT_MS)
    ctx.signal.removeEventListener("abort", onCtxAbort)
    throw new Error(`claude failed to start: ${msg}`)
  }
  started = true
  if (tr.status === "starting") emit(tr.setStatus("ready"))
  return session
}

type AdapterContextLike = Parameters<AgentAdapter["start"]>[1]

export const claudeAdapter: AgentAdapter = defineAdapter({
  id: "claude",
  displayName: "Claude Code",
  family: "claude",
  binaries: ["claude"],
  detect,
  capabilities: () => ({
    steer: true,
    interrupt: true,
    resume: true,
    fork: true,
    diff: true,
    usage: true,
    cost: true,
    permissions: true,
    mcp: true,
    models: ["sonnet", "opus", "haiku"],
  }),
  start,
})

export default claudeAdapter
