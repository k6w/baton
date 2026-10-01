/**
 * One ACP agent process + session, driven as a Baton AgentSession.
 *
 * Transport: the agent's stdio as newline-delimited JSON-RPC via `@agentclientprotocol/sdk`.
 * `session/update` notifications are intercepted on the raw message stream (before the SDK's
 * strict zod validation) so that agents emitting newer/unknown update variants don't break the
 * session, and so updates are processed strictly in wire order relative to responses.
 */

import { resolve } from "node:path"
import * as acp from "@agentclientprotocol/sdk"
import type {
  AdapterContext,
  AgentEvent,
  AgentSession,
  ApprovalMode,
  EventInput,
  EventType,
  PermissionOptionKind,
  PromptInput,
  SessionConfig,
  ToolContent,
  ToolKind,
  ToolStatus,
} from "@batonsh/protocol"
import { augmentedPath, deferred, newId, readLines } from "@batonsh/protocol"
import { blockText, contentKey, diffContent, diffKey, mapKind, mapToolContent, rawSummary, toolName, toolTitle } from "./map.ts"
import type { AcpPreset } from "./presets.ts"
import { runAuthCheck } from "./presets.ts"
import { killTree, TerminalManager } from "./terminal.ts"
import { WorkspaceFs } from "./workspace-fs.ts"

const AUTH_REQUIRED = -32000
const INTERACTIVE_AUTH = /oauth|browser|log ?in|device|sign[- ]?in|web|interactive|terminal/i
const KEY_AUTH = /api[-_ ]?key|token|env|key|vertex|cached|existing|gateway/i

type Role = "assistant" | "thought"

interface OpenMessage {
  messageId: string
  nativeId?: string
  role: Role
  text: string
}

interface ToolState {
  id: string
  kind: ToolKind
  acpTitle: string
  name?: string | null
  title: string
  locations: { path: string; line?: number | null }[]
  rawInput: unknown
  status: ToolStatus
  seen: Set<string>
  turnId?: string
}

interface PendingPermission {
  resolve: (optionId: string | null) => void
  options: acp.PermissionOption[]
}

interface Turn {
  turnId: string
  interrupted: boolean
  /** Terminal turn event already emitted (e.g. by onExit on a crash). */
  ended?: boolean
}

export interface AcpSessionOptions {
  preset: AcpPreset
  /** Resolved executable path. */
  bin: string
  args: string[]
}

export class AcpSession implements AgentSession {
  private proc!: ReturnType<typeof Bun.spawn>
  private conn!: acp.ClientConnection
  private agent!: acp.ClientContext
  private init?: acp.InitializeResponse
  private sessionId?: string
  private resumed = false
  private replaying = false
  private closing = false
  private closed = false
  private exitDone = deferred<void>()
  private stderrTail: string[] = []

  private queue: PromptInput[] = []
  private running = false
  private turn?: Turn
  private pendingSystemPrompt?: string

  private open: Partial<Record<Role, OpenMessage>> = {}
  private tools = new Map<string, ToolState>()
  private toolOrder: string[] = []
  private permissions = new Map<string, PendingPermission>()
  private terminalOwner = new Map<string, string>()
  private terminalTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private configOptions: acp.SessionConfigOption[] = []
  private legacyModels?: { availableModels?: { modelId: string; name?: string }[]; currentModelId?: string }
  private totals = { input: 0, cachedInput: 0, output: 0, reasoning: 0 }
  private costUsd?: number

  private fs: WorkspaceFs
  private terminals: TerminalManager
  private rawEnabled: boolean

  constructor(
    private opts: AcpSessionOptions,
    private cfg: SessionConfig,
    private ctx: AdapterContext,
  ) {
    this.fs = new WorkspaceFs(cfg.cwd)
    this.rawEnabled = cfg.options?.raw === true
    this.pendingSystemPrompt = cfg.systemPrompt?.trim() || undefined
    this.terminals = new TerminalManager({
      cwd: cfg.cwd,
      env: { ...opts.preset.env, ...cfg.env },
      onOutput: (id) => this.scheduleTerminalEmit(id),
      onExit: (id) => this.emitTerminal(id),
    })
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async start(): Promise<void> {
    const { preset, bin, args } = this.opts
    this.emit("agent.status", { status: "starting", detail: `${bin} ${args.join(" ")}`.trim() })
    this.proc = Bun.spawn([bin, ...args], {
      cwd: this.cfg.cwd,
      env: { ...process.env, PATH: augmentedPath(), ...preset.env, ...this.cfg.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // own process group, so shutdown reaches the agent's helpers (MCP servers, tool shells …)
      detached: true,
    })
    void this.pumpStderr()
    void this.proc.exited.then((code) => this.onExit(code))
    this.ctx.signal.addEventListener("abort", () => void this.close(), { once: true })

    const sink = this.proc.stdin as import("bun").FileSink
    const writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        if (this.closed) return
        try {
          sink.write(chunk)
          await sink.flush()
        } catch (e) {
          this.ctx.log("debug", `stdin write failed: ${String(e)}`)
        }
      },
      close: () => {
        try {
          sink.end()
        } catch {}
      },
    })
    const stream = acp.ndJsonStream(writable, this.proc.stdout as ReadableStream<Uint8Array>)
    const filtered = stream.readable.pipeThrough(
      new TransformStream<acp.AnyMessage, acp.AnyMessage>({
        transform: (msg, ctl) => {
          const m = msg as { method?: string; id?: unknown; params?: unknown }
          if (m.method === "session/update" && m.id === undefined) {
            try {
              this.onUpdate(m.params as acp.SessionNotification, msg)
            } catch (e) {
              this.ctx.log("warn", `failed to map session/update: ${e instanceof Error ? e.message : String(e)}`)
            }
            return
          }
          ctl.enqueue(msg)
        },
      }),
    )
    this.conn = this.buildClient().connect({ readable: filtered, writable: stream.writable })
    this.agent = this.conn.agent

    try {
      await this.handshake()
    } catch (e) {
      const tail = this.stderrTail.slice(-10).join("\n")
      await this.shutdown()
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`${preset.displayName}: ACP startup failed: ${msg}${tail ? `\n${tail}` : ""}`)
    }
  }

  private buildClient(): acp.ClientApp {
    const loose = <T>(p: unknown) => p as T
    return acp
      .client({ name: "baton" })
      .onRequest("session/request_permission", loose<acp.RequestPermissionRequest>, (c) => this.onPermission(c.params, c.signal))
      .onRequest("fs/read_text_file", loose<acp.ReadTextFileRequest>, (c) => this.onReadFile(c.params))
      .onRequest("fs/write_text_file", loose<acp.WriteTextFileRequest>, (c) => this.onWriteFile(c.params))
      .onRequest("terminal/create", loose<acp.CreateTerminalRequest>, (c) => this.onTerminalCreate(c.params))
      .onRequest("terminal/output", loose<acp.TerminalOutputRequest>, (c) => {
        const o = this.terminalCall(c.params.terminalId, () => this.terminals.output(c.params.terminalId))
        return { output: o.output, truncated: o.truncated, exitStatus: o.exitStatus }
      })
      .onRequest("terminal/wait_for_exit", loose<acp.WaitForTerminalExitRequest>, async (c) => {
        const ex = await this.terminalCall(c.params.terminalId, () => this.terminals.waitForExit(c.params.terminalId))
        return { exitCode: ex.exitCode, signal: ex.signal }
      })
      .onRequest("terminal/kill", loose<acp.KillTerminalRequest>, (c) => {
        this.terminalCall(c.params.terminalId, () => this.terminals.kill(c.params.terminalId))
        return {}
      })
      .onRequest("terminal/release", loose<acp.ReleaseTerminalRequest>, (c) => {
        this.emitTerminal(c.params.terminalId)
        this.terminals.release(c.params.terminalId)
        return {}
      })
  }

  private async handshake(): Promise<void> {
    const timeoutMs = Number(this.cfg.options?.initTimeoutMs ?? 60_000)
    const init = await withTimeout(
      this.agent.request("initialize", {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
        clientInfo: { name: "baton", version: "0.1.0" },
      }),
      timeoutMs,
      "initialize",
    )
    this.init = init
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
      // Spec: the agent answers with the latest version it supports; we only speak v1 (the v2
      // wire protocol is still a draft and no stdio agent advertises it yet).
      if (init.protocolVersion > acp.PROTOCOL_VERSION) this.ctx.log("warn", `agent answered ACP v${init.protocolVersion}; continuing with v1 semantics`)
      else throw new Error(`unsupported ACP protocol version ${init.protocolVersion}`)
    }
    const caps = init.agentCapabilities ?? {}
    this.ctx.log(
      "debug",
      `initialized ${init.agentInfo?.name ?? this.opts.preset.id} ${init.agentInfo?.version ?? ""} caps=${JSON.stringify(caps)} auth=${JSON.stringify(init.authMethods ?? [])}`,
    )

    const mcpServers = this.mcpServers(caps)
    const sessionTimeoutMs = Number(this.cfg.options?.sessionTimeoutMs ?? 60_000)
    const sessionRequest = <T>(p: Promise<T>, what: string) => withTimeout(p, sessionTimeoutMs, what)
    const resumeId = this.cfg.resumeId
    if (resumeId) {
      try {
        if (caps.sessionCapabilities?.resume) {
          const r = await this.withAuth(() =>
            sessionRequest(this.agent.request("session/resume", { sessionId: resumeId, cwd: this.cfg.cwd, mcpServers }), "session/resume"),
          )
          this.sessionId = resumeId
          this.absorbSessionResponse(r)
          this.resumed = true
        } else if (caps.loadSession) {
          this.replaying = true
          try {
            const r = await this.withAuth(() =>
              sessionRequest(this.agent.request("session/load", { sessionId: resumeId, cwd: this.cfg.cwd, mcpServers }), "session/load"),
            )
            this.sessionId = resumeId
            this.absorbSessionResponse(r)
            this.resumed = true
          } finally {
            this.replaying = false
          }
        } else {
          this.ctx.log("warn", `${this.opts.preset.displayName} does not support session/load or session/resume; starting a new session`)
        }
      } catch (e) {
        this.emit("error", { message: `could not resume session ${resumeId}; starting a new one`, detail: errMessage(e) })
      }
    }
    if (!this.sessionId) {
      const r = await this.withAuth(() => sessionRequest(this.agent.request("session/new", { cwd: this.cfg.cwd, mcpServers }), "session/new"))
      this.sessionId = r.sessionId
      this.absorbSessionResponse(r)
    }
    if (this.resumed) this.pendingSystemPrompt = undefined
    this.emit("agent.session", { sessionId: this.sessionId })

    if (this.cfg.model) await this.applyModel(this.cfg.model)
    if (this.cfg.provider) this.ctx.log("debug", "ACP has no provider injection; provider config is ignored (configure it in the agent itself)")
    this.emit("agent.updated", { version: init.agentInfo?.version ?? undefined, model: this.currentModel() })
    this.emit("agent.status", { status: "ready" })
  }

  private mcpServers(caps: acp.AgentCapabilities): acp.McpServer[] {
    const servers = this.cfg.mcpServers ?? []
    if (servers.length === 0) return []
    if (!caps.mcpCapabilities?.http) {
      this.ctx.log("warn", `${this.opts.preset.displayName} does not advertise HTTP MCP support; ${servers.length} MCP server(s) not injected`)
      return []
    }
    return servers.map((s) => ({
      type: "http" as const,
      name: s.name,
      url: s.url,
      headers: Object.entries(s.headers ?? {}).map(([name, value]) => ({ name, value })),
    }))
  }

  private absorbSessionResponse(r: unknown): void {
    const res = (r ?? {}) as { configOptions?: acp.SessionConfigOption[] | null; models?: unknown }
    if (Array.isArray(res.configOptions)) this.configOptions = res.configOptions
    // pre-config-options agents exposed `models` + `session/set_model` (unstable API)
    if (res.models && typeof res.models === "object") this.legacyModels = res.models as typeof this.legacyModels
  }

  private async withAuth<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      if (!isAuthRequired(e)) throw e
    }
    const methods = this.init?.authMethods ?? []
    const nonTerminal = methods.filter((m) => (m as { type?: string }).type !== "terminal")
    const text = (m: acp.AuthMethod) => `${m.id} ${m.name} ${m.description ?? ""}`
    const candidates = nonTerminal.filter((m) => KEY_AUTH.test(text(m)) && !INTERACTIVE_AUTH.test(m.id))
    // Methods that may need a browser are only tried when credentials look cached already.
    const cached = (await runAuthCheck(this.opts.preset.authCheck)).auth === "ok"
    if (cached) for (const m of nonTerminal) if (!candidates.includes(m)) candidates.push(m)
    for (const m of candidates) {
      try {
        this.ctx.log("info", `authenticating with method ${m.id}`)
        await withTimeout(this.agent.request("authenticate", { methodId: m.id }), 30_000, "authenticate")
        return await fn()
      } catch (e) {
        this.ctx.log("debug", `auth method ${m.id} failed: ${errMessage(e)}`)
      }
    }
    const hint = this.opts.preset.authHint ?? `run \`${this.opts.bin.split("/").pop()}\` once interactively to log in`
    const offered = methods.map((m) => m.name || m.id).join(", ")
    const message = `${this.opts.preset.displayName} requires authentication — ${hint}`
    this.emit("error", { message, detail: offered ? `agent auth methods: ${offered}` : undefined, fatal: true })
    throw new Error(message)
  }

  private onExit(code: number | null): void {
    if (this.closed) return
    this.closed = true
    const expected = this.closing
    for (const id of [...this.permissions.keys()]) this.resolvePermission(id, null, "cancelled")
    for (const t of this.terminalTimers.values()) clearTimeout(t)
    try {
      this.conn?.close(new Error("agent process exited"))
    } catch {}
    void this.terminals.disposeAll()
    // reap helpers the agent left behind in its process group
    killTree(this.proc)
    if (!expected) {
      this.emit("error", {
        message: `${this.opts.preset.displayName} exited unexpectedly (code ${code})`,
        detail: this.stderrTail.slice(-20).join("\n") || undefined,
        fatal: true,
      })
    }
    // A running turn must end (as failed) before agent.exited, so hosts record a failed result.
    const turn = this.turn
    if (turn && !turn.ended) {
      turn.ended = true
      this.flushAll()
      this.emit(
        turn.interrupted ? "turn.interrupted" : "turn.completed",
        turn.interrupted ? { turnId: turn.turnId } : { turnId: turn.turnId, stopReason: expected ? "cancelled" : "error" },
      )
    }
    this.emit("agent.exited", { code, reason: expected ? "closed" : "crashed" })
    this.emit("agent.status", { status: expected ? "exited" : "error" })
    this.exitDone.resolve()
  }

  private async pumpStderr(): Promise<void> {
    try {
      for await (const line of readLines(this.proc.stderr as ReadableStream<Uint8Array>)) {
        this.stderrTail.push(line)
        if (this.stderrTail.length > 50) this.stderrTail.shift()
        this.ctx.log("debug", `[stderr] ${line}`)
      }
    } catch {}
  }

  private async shutdown(): Promise<void> {
    this.closing = true
    try {
      ;(this.proc.stdin as import("bun").FileSink).end()
    } catch {}
    const exitedSoon = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(1500).then(() => false)])
    if (!exitedSoon) {
      killTree(this.proc, "SIGTERM")
      const gone = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(2000).then(() => false)])
      if (!gone) killTree(this.proc, "SIGKILL")
    }
    await Promise.race([this.exitDone.promise, Bun.sleep(3000)])
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) return this.exitDone.promise
    this.closing = true
    this.queue = []
    for (const id of [...this.permissions.keys()]) this.resolvePermission(id, null, "cancelled")
    if (this.sessionId) {
      if (this.turn) await this.agent.notify("session/cancel", { sessionId: this.sessionId }).catch(() => {})
      if (this.init?.agentCapabilities?.sessionCapabilities?.close)
        await withTimeout(this.agent.request("session/close", { sessionId: this.sessionId }), 2000, "session/close").catch(() => {})
    }
    await this.terminals.disposeAll()
    await this.shutdown()
  }

  resumeId(): string | undefined {
    return this.sessionId
  }

  // ───────────────────────────── turns ─────────────────────────────

  async prompt(input: PromptInput): Promise<void> {
    if (this.closed || this.closing) throw new Error("session is closed")
    this.queue.push(input)
    if (this.running) this.ctx.log("info", `turn in progress; prompt queued (${this.queue.length} waiting)`)
    void this.runQueue()
  }

  private async runQueue(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0 && !this.closed && !this.closing) {
        await this.runTurn(this.queue.shift() as PromptInput)
      }
    } finally {
      this.running = false
    }
    if (!this.closed && !this.closing) this.emit("agent.status", { status: "ready" })
  }

  private async runTurn(input: PromptInput): Promise<void> {
    const turn: Turn = { turnId: newId("turn"), interrupted: false }
    this.turn = turn
    this.emit("turn.started", { turnId: turn.turnId, prompt: input.text })
    this.emit("agent.status", { status: "busy" })
    let text = input.text
    if (input.from && input.from !== "user") text = `[message from ${input.from}]\n${text}`
    if (this.pendingSystemPrompt) {
      text = `<baton-context>\n${this.pendingSystemPrompt}\n</baton-context>\n\n${text}`
      this.pendingSystemPrompt = undefined
    }
    try {
      const res = await this.agent.request("session/prompt", { sessionId: this.sessionId as string, prompt: [{ type: "text", text }] })
      if (turn.ended) return
      turn.ended = true
      this.flushAll()
      if (res.usage) this.addUsage(res.usage)
      // An interrupted turn ends with turn.interrupted alone (it is the terminal event).
      if (turn.interrupted) this.emit("turn.interrupted", { turnId: turn.turnId }, res)
      else this.emit("turn.completed", { turnId: turn.turnId, stopReason: res.stopReason }, res)
    } catch (e) {
      if (turn.ended) return
      turn.ended = true
      this.flushAll()
      if (turn.interrupted) {
        this.emit("turn.interrupted", { turnId: turn.turnId })
      } else if (this.closing) {
        this.emit("turn.completed", { turnId: turn.turnId, stopReason: "cancelled" })
      } else {
        const authHint = isAuthRequired(e) ? ` — ${this.opts.preset.authHint ?? "log in to the agent first"}` : ""
        if (!this.closed) this.emit("error", { message: `prompt failed: ${errMessage(e)}${authHint}`, detail: errDetail(e) })
        this.emit("turn.completed", { turnId: turn.turnId, stopReason: "error" })
      }
    } finally {
      this.turn = undefined
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.turn
    if (!turn || !this.sessionId) {
      this.ctx.log("debug", "interrupt: no turn running")
      return
    }
    if (turn.interrupted) return
    turn.interrupted = true
    await this.agent.notify("session/cancel", { sessionId: this.sessionId }).catch((e) => this.ctx.log("warn", `session/cancel failed: ${errMessage(e)}`))
    // Spec: the client MUST answer every pending permission request with `cancelled`.
    for (const id of [...this.permissions.keys()]) this.resolvePermission(id, null, "cancelled")
    // turn.interrupted is emitted by runTurn once the agent answers session/prompt (stopReason cancelled)
  }

  async respondPermission(requestId: string, optionId: string | null): Promise<void> {
    if (!this.resolvePermission(requestId, optionId, "user")) this.ctx.log("warn", `unknown or already-resolved permission request ${requestId}`)
  }

  async setModel(model: string): Promise<void> {
    if (!this.sessionId) throw new Error("session not started")
    await this.applyModel(model)
  }

  // ───────────────────────────── models ─────────────────────────────

  private modelOption(): (acp.SessionConfigOption & { type: "select" }) | undefined {
    return this.configOptions.find((o) => o.type === "select" && (o.category === "model" || o.id === "model")) as
      | (acp.SessionConfigOption & { type: "select" })
      | undefined
  }

  /**
   * Autonomy switch: pick the agent's own permission mode (a "mode" config option) whose
   * id/name matches the level — e.g. Claude ACP's default / acceptEdits / bypassPermissions.
   */
  async setApproval(mode: ApprovalMode): Promise<void> {
    const opt = this.configOptions.find((o) => o.type === "select" && (o.category === "mode" || o.id === "mode")) as
      | (acp.SessionConfigOption & { type: "select" })
      | undefined
    if (!opt || !this.sessionId) throw new Error(`${this.opts.preset.displayName} exposes no permission modes over ACP`)
    const values = (opt.options as unknown[]).flatMap((o) =>
      o && typeof o === "object" && "options" in o ? (o as acp.SessionConfigSelectGroup).options : [o as acp.SessionConfigSelectOption],
    )
    const patterns: Record<ApprovalMode, RegExp> = {
      yolo: /bypass|yolo|full.?access|danger|dont.?ask|never.?ask|allow.?all/i,
      auto: /^auto$|auto.?approve|accept.?all|agent.?full|autonom/i,
      "auto-edit": /accept.?edits|auto.?edit|edit/i,
      ask: /^default$|ask|manual|normal|read.?only/i,
    }
    const match = values.find((v) => patterns[mode].test(v.value) || patterns[mode].test(v.name ?? ""))
    if (!match) throw new Error(`${this.opts.preset.displayName} has no mode for ${mode}`)
    if (opt.currentValue === match.value) return
    const res = await this.agent.request("session/set_config_option", { sessionId: this.sessionId, configId: opt.id, value: match.value })
    if (Array.isArray(res?.configOptions)) this.configOptions = res.configOptions
    else opt.currentValue = match.value
  }

  private currentModel(): string | undefined {
    const opt = this.modelOption()
    if (opt) return opt.currentValue
    return this.legacyModels?.currentModelId
  }

  private async applyModel(model: string): Promise<boolean> {
    const want = model.toLowerCase()
    const pick = <T>(items: T[], value: (t: T) => string, name: (t: T) => string | undefined) =>
      items.find((i) => value(i) === model) ??
      items.find((i) => value(i).toLowerCase() === want || name(i)?.toLowerCase() === want) ??
      items.find((i) => value(i).toLowerCase().endsWith(`/${want}`))
    const opt = this.modelOption()
    try {
      if (opt) {
        const values = (opt.options as unknown[]).flatMap((o) =>
          o && typeof o === "object" && "options" in o ? (o as acp.SessionConfigSelectGroup).options : [o as acp.SessionConfigSelectOption],
        )
        const match = pick(
          values,
          (v) => v.value,
          (v) => v.name,
        )
        if (!match) {
          this.ctx.log("warn", `model ${model} not offered by ${this.opts.preset.displayName}; keeping ${opt.currentValue}`)
          return false
        }
        const res = await this.agent.request("session/set_config_option", { sessionId: this.sessionId as string, configId: opt.id, value: match.value })
        if (Array.isArray(res?.configOptions)) this.configOptions = res.configOptions
        else opt.currentValue = match.value
        this.emit("agent.updated", { model: match.value })
        return true
      }
      const legacy = this.legacyModels?.availableModels
      if (legacy?.length) {
        const match = pick(
          legacy,
          (m) => m.modelId,
          (m) => m.name,
        )
        if (!match) {
          this.ctx.log("warn", `model ${model} not offered by ${this.opts.preset.displayName}`)
          return false
        }
        await this.agent.request("session/set_model", { sessionId: this.sessionId, modelId: match.modelId })
        if (this.legacyModels) this.legacyModels.currentModelId = match.modelId
        this.emit("agent.updated", { model: match.modelId })
        return true
      }
    } catch (e) {
      this.ctx.log("warn", `could not set model ${model}: ${errMessage(e)}`)
      return false
    }
    this.ctx.log("debug", `${this.opts.preset.displayName} exposes no model selection over ACP; ignoring model ${model}`)
    return false
  }

  // ───────────────────────────── session/update ─────────────────────────────

  private onUpdate(n: acp.SessionNotification, raw: unknown): void {
    const u = n?.update as acp.SessionUpdate | undefined
    if (!u) return
    if (this.replaying) {
      this.ctx.log("debug", `replay: ${u.sessionUpdate}`)
      return
    }
    if (this.sessionId && n.sessionId && n.sessionId !== this.sessionId) {
      this.ctx.log("debug", `update for foreign session ${n.sessionId}: ${u.sessionUpdate}`)
      return
    }
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        this.flush("thought")
        this.chunk("assistant", u.content, u.messageId, raw)
        break
      case "agent_thought_chunk":
        this.chunk("thought", u.content, u.messageId, raw)
        break
      case "user_message_chunk":
        this.ctx.log("debug", "user_message_chunk (echo) ignored")
        break
      case "tool_call":
        this.onToolCall(u, raw)
        break
      case "tool_call_update":
        this.onToolUpdate(u, raw)
        break
      case "plan":
        this.emitPlan(u.entries, raw)
        break
      case "plan_update":
        if (u.plan?.type === "items") this.emitPlan(u.plan.entries, raw)
        else this.ctx.log("debug", `plan_update (${u.plan?.type}) not mapped`)
        break
      case "plan_removed":
        this.emit("plan.updated", { entries: [] }, raw)
        break
      case "usage_update":
        this.ctx.log("debug", `context ${u.used}/${u.size} tokens`)
        if (u.cost && u.cost.currency?.toUpperCase() === "USD") {
          this.costUsd = u.cost.amount
          this.emitUsage(raw)
        }
        break
      case "config_option_update":
        if (Array.isArray(u.configOptions)) {
          const before = this.currentModel()
          this.configOptions = u.configOptions
          const after = this.currentModel()
          if (after && after !== before) this.emit("agent.updated", { model: after })
        }
        break
      case "notice":
        this.ctx.log(u.severity === "error" ? "error" : u.severity === "warning" ? "warn" : "info", `${u.title}${u.description ? `: ${u.description}` : ""}`)
        break
      default:
        this.ctx.log("debug", `session/update ${(u as { sessionUpdate: string }).sessionUpdate} not mapped`)
    }
  }

  private chunk(role: Role, block: acp.ContentBlock, nativeId: string | null | undefined, raw: unknown): void {
    const text = blockText(block)
    if (!text) return
    let m = this.open[role]
    if (m && nativeId && m.nativeId && nativeId !== m.nativeId) {
      this.flush(role)
      m = undefined
    }
    if (!m) {
      m = { messageId: newId("msg"), nativeId: nativeId ?? undefined, role, text: "" }
      this.open[role] = m
    }
    m.text += text
    this.emit("message.delta", { messageId: m.messageId, role, text }, raw)
  }

  private flush(role: Role): void {
    const m = this.open[role]
    if (!m) return
    this.open[role] = undefined
    if (m.text.length > 0) this.emit("message.completed", { messageId: m.messageId, role, text: m.text })
  }

  private flushAll(): void {
    this.flush("thought")
    this.flush("assistant")
  }

  private emitPlan(entries: acp.PlanEntry[] | undefined, raw: unknown): void {
    const status = (s: string) => (s === "completed" || s === "in_progress" ? s : "pending") as "pending" | "in_progress" | "completed"
    const priority = (p: string | undefined) => (p === "high" || p === "medium" || p === "low" ? p : undefined)
    this.emit("plan.updated", { entries: (entries ?? []).map((e) => ({ content: e.content, status: status(e.status), priority: priority(e.priority) })) }, raw)
  }

  // ───────────────────────────── tool calls ─────────────────────────────

  private onToolCall(u: acp.ToolCall, raw: unknown): void {
    if (this.tools.has(u.toolCallId)) {
      this.onToolUpdate(u, raw)
      return
    }
    this.flushAll()
    const kind = mapKind(u.kind)
    const st: ToolState = {
      id: u.toolCallId,
      kind,
      acpTitle: u.title ?? "",
      name: u.name,
      title: "",
      locations: u.locations ?? [],
      rawInput: u.rawInput,
      status: (u.status as ToolStatus) ?? "pending",
      seen: new Set(),
      turnId: this.turn?.turnId,
    }
    st.title = this.titleOf(st)
    this.tools.set(st.id, st)
    this.toolOrder.push(st.id)
    if (this.toolOrder.length > 500) this.tools.delete(this.toolOrder.shift() as string)
    this.emit(
      "tool.call",
      {
        toolCallId: st.id,
        kind,
        name: toolName(kind, st.acpTitle, st.name),
        title: st.title,
        status: st.status,
        locations: st.locations.map((l) => (l.line != null ? { path: l.path, line: l.line } : { path: l.path })),
        rawInput: st.rawInput,
      },
      raw,
    )
    const content = mapToolContent(u.content, this.terminalLookup(st.id), st.seen)
    if (content.length > 0 || u.rawOutput !== undefined)
      this.emit("tool.update", { toolCallId: st.id, content: content.length ? content : undefined, rawOutput: u.rawOutput })
  }

  private onToolUpdate(u: acp.ToolCallUpdate, raw: unknown): void {
    let st = this.tools.get(u.toolCallId)
    if (!st) {
      this.onToolCall(
        {
          toolCallId: u.toolCallId,
          title: u.title ?? "",
          kind: u.kind ?? undefined,
          name: u.name,
          locations: u.locations ?? undefined,
          rawInput: u.rawInput,
          status: u.status ?? undefined,
        },
        raw,
      )
      st = this.tools.get(u.toolCallId) as ToolState
    }
    if (u.title) st.acpTitle = u.title
    if (u.locations) st.locations = u.locations
    if (u.rawInput !== undefined) st.rawInput = u.rawInput
    if (u.name) st.name = u.name
    if (u.kind) st.kind = mapKind(u.kind)
    const title = this.titleOf(st)
    const titleChanged = title !== st.title
    st.title = title
    const status = u.status ? (u.status as ToolStatus) : undefined
    const statusChanged = status !== undefined && status !== st.status
    if (status) st.status = status
    const content = mapToolContent(u.content, this.terminalLookup(st.id), st.seen)
    if (!titleChanged && !statusChanged && content.length === 0 && u.rawOutput === undefined) return
    this.emit(
      "tool.update",
      {
        toolCallId: st.id,
        status: statusChanged ? status : undefined,
        title: titleChanged ? title : undefined,
        content: content.length ? content : undefined,
        rawOutput: u.rawOutput,
      },
      raw,
    )
  }

  private titleOf(st: ToolState): string {
    return toolTitle(st.kind, st.acpTitle, st.locations, st.rawInput, (p) => this.fs.display(p), st.name)
  }

  /** Drops content items already emitted for this tool call (agents often resend the full set). */
  private newContent(st: ToolState, items: ToolContent[]): ToolContent[] {
    const out: ToolContent[] = []
    for (const c of items) {
      const key = contentKey(c)
      if (st.seen.has(key)) continue
      st.seen.add(key)
      out.push(c)
    }
    return out
  }

  private terminalLookup(toolCallId: string) {
    return (terminalId: string) => {
      this.terminalOwner.set(terminalId, toolCallId)
      const s = this.terminals.snapshot(terminalId)
      return s ? { output: s.output, exitCode: s.exit?.exitCode ?? null, command: s.command } : undefined
    }
  }

  private scheduleTerminalEmit(terminalId: string): void {
    if (!this.terminalOwner.has(terminalId) || this.terminalTimers.has(terminalId)) return
    this.terminalTimers.set(
      terminalId,
      setTimeout(() => {
        this.terminalTimers.delete(terminalId)
        this.emitTerminal(terminalId)
      }, 250),
    )
  }

  private emitTerminal(terminalId: string): void {
    const owner = this.terminalOwner.get(terminalId)
    const st = owner ? this.tools.get(owner) : undefined
    const snap = this.terminals.snapshot(terminalId)
    if (!st || !snap || this.closed) return
    const content = this.newContent(st, [{ type: "terminal", terminalId, command: snap.command, output: snap.output, exitCode: snap.exit?.exitCode ?? null }])
    if (content.length) this.emit("tool.update", { toolCallId: st.id, content })
  }

  // ───────────────────────────── permissions ─────────────────────────────

  private async onPermission(params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    if (this.turn?.interrupted || this.closing || this.closed) return { outcome: { outcome: "cancelled" } }
    const tc = params.toolCall ?? ({ toolCallId: newId("tc") } as acp.ToolCallUpdate)
    if (!this.tools.has(tc.toolCallId)) this.onToolCall({ ...tc, title: tc.title ?? "Permission", kind: tc.kind ?? undefined } as acp.ToolCall, params)
    else this.onToolUpdate(tc, params)
    const st = this.tools.get(tc.toolCallId) as ToolState
    const requestId = newId("perm")
    const d = deferred<string | null>()
    this.permissions.set(requestId, { resolve: d.resolve, options: params.options ?? [] })
    this.emit(
      "permission.requested",
      {
        requestId,
        toolCallId: st.id,
        title: st.title,
        kind: st.kind,
        detail: rawSummary(st.rawInput),
        options: (params.options ?? []).map((o) => ({ optionId: o.optionId, name: o.name, kind: permKind(o.kind) })),
      },
      params,
    )
    this.emit("agent.status", { status: "awaiting_approval", detail: st.title })
    const onAbort = () => this.resolvePermission(requestId, null, "cancelled")
    signal.addEventListener("abort", onAbort, { once: true })
    const choice = await d.promise
    signal.removeEventListener("abort", onAbort)
    if (this.turn && !this.closed && this.permissions.size === 0) this.emit("agent.status", { status: "busy" })
    return choice === null ? { outcome: { outcome: "cancelled" } } : { outcome: { outcome: "selected", optionId: choice } }
  }

  private resolvePermission(requestId: string, optionId: string | null, by: "user" | "cancelled"): boolean {
    const p = this.permissions.get(requestId)
    if (!p) return false
    let opt: acp.PermissionOption | undefined
    if (optionId !== null) {
      // accept an optionId, or a BEP option kind ("allow_once") as a convenience
      opt = p.options.find((o) => o.optionId === optionId) ?? p.options.find((o) => o.kind === optionId)
      if (!opt) throw new Error(`permission ${requestId}: unknown option ${optionId}`)
    }
    this.permissions.delete(requestId)
    this.emit("permission.resolved", { requestId, optionId: opt?.optionId ?? null, kind: opt ? permKind(opt.kind) : null, by })
    p.resolve(opt?.optionId ?? null)
    return true
  }

  // ───────────────────────────── fs ─────────────────────────────

  private onReadFile(p: acp.ReadTextFileRequest): acp.ReadTextFileResponse {
    try {
      return { content: this.fs.read(p.path, p.line, p.limit) }
    } catch (e) {
      if ((e as { code?: string }).code === "ENOENT") throw acp.RequestError.resourceNotFound(p.path)
      throw acp.RequestError.invalidParams(undefined, errMessage(e))
    }
  }

  private onWriteFile(p: acp.WriteTextFileRequest): acp.WriteTextFileResponse {
    let res: { path: string; oldText: string | null }
    try {
      res = this.fs.write(p.path, p.content)
    } catch (e) {
      throw acp.RequestError.invalidParams(undefined, errMessage(e))
    }
    const st = this.editToolFor(res.path)
    const key = diffKey(p.path, p.content)
    if (!st.seen.has(key)) {
      st.seen.add(key)
      this.emit("tool.update", { toolCallId: st.id, content: [diffContent(p.path, res.oldText, p.content)] })
    }
    return {}
  }

  /** The tool call a write belongs to: open call touching the path > open edit call > synthesized. */
  private editToolFor(abs: string): ToolState {
    const recent = [...this.toolOrder]
      .reverse()
      .map((id) => this.tools.get(id))
      .filter((t): t is ToolState => !!t)
    const open = recent.filter((t) => t.status === "pending" || t.status === "in_progress")
    const touches = (t: ToolState) => t.locations.some((l) => samePath(this.fs.root, l.path, abs))
    const found =
      open.find(touches) ??
      open.find((t) => t.kind === "edit" || t.kind === "delete" || t.kind === "move") ??
      recent.find((t) => t.turnId === this.turn?.turnId && t.turnId !== undefined && touches(t))
    if (found) return found
    const id = newId("tc")
    this.onToolCall({ toolCallId: id, title: `Write ${this.fs.display(abs)}`, kind: "edit", status: "completed", locations: [{ path: abs }] }, undefined)
    return this.tools.get(id) as ToolState
  }

  // ───────────────────────────── terminals ─────────────────────────────

  private onTerminalCreate(p: acp.CreateTerminalRequest): acp.CreateTerminalResponse {
    try {
      const terminalId = this.terminals.create({ command: p.command, args: p.args, env: p.env, cwd: p.cwd, outputByteLimit: p.outputByteLimit })
      return { terminalId }
    } catch (e) {
      throw acp.RequestError.internalError(undefined, `could not start command: ${errMessage(e)}`)
    }
  }

  private terminalCall<T>(id: string, fn: () => T): T {
    if (!this.terminals.has(id)) throw acp.RequestError.resourceNotFound(id)
    return fn()
  }

  // ───────────────────────────── usage / emit ─────────────────────────────

  private addUsage(u: acp.Usage): void {
    this.totals.input += u.inputTokens ?? 0
    this.totals.output += u.outputTokens ?? 0
    this.totals.cachedInput += u.cachedReadTokens ?? 0
    this.totals.reasoning += u.thoughtTokens ?? 0
    this.emitUsage(u)
  }

  private emitUsage(raw: unknown): void {
    this.emit("usage.updated", { ...this.totals, costUsd: this.costUsd, source: "reported", mode: "cumulative" }, raw)
  }

  private emit<T extends EventType>(type: T, data: EventInput<T>, raw?: unknown): void {
    const ev = (this.rawEnabled && raw !== undefined ? { type, data, raw } : { type, data }) as AgentEvent
    try {
      this.ctx.emit(ev)
    } catch (e) {
      this.ctx.log("error", `emit ${type} failed: ${errMessage(e)}`)
    }
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function permKind(k: string): PermissionOptionKind {
  if (k === "allow_once" || k === "allow_always" || k === "reject_once" || k === "reject_always") return k
  return k.startsWith("allow") ? "allow_once" : "reject_once"
}

function samePath(root: string, a: string, b: string): boolean {
  return resolve(root, a) === resolve(root, b)
}

function isAuthRequired(e: unknown): boolean {
  const err = e as { code?: number; message?: string }
  return err?.code === AUTH_REQUIRED && /auth/i.test(err.message ?? "auth")
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message)
  return String(e)
}

function errDetail(e: unknown): string | undefined {
  const data = (e as { data?: unknown })?.data
  if (data === undefined) return undefined
  try {
    return typeof data === "string" ? data : JSON.stringify(data)
  } catch {
    return undefined
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (!(ms > 0)) return p
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms waiting for ${what}`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}
