/**
 * A live Codex session: one `codex app-server` process hosting one thread.
 *
 * Transport is JSONL JSON-RPC over stdio (codex omits the "jsonrpc" field). Responses to our
 * requests go through JsonRpcPeer; server→client requests are routed here so we can keep their
 * JSON-RPC ids (needed to correlate `serverRequest/resolved`).
 */
import { appendFileSync } from "node:fs"
import type { AdapterContext, AgentSession, ApprovalMode, PromptInput, SessionConfig } from "@batonsh/protocol"
import { augmentedPath, deferred, type JsonRpcMessage, JsonRpcPeer, readLines } from "@batonsh/protocol"
import { type ApprovalSettings, approvalSettings, appServerArgs, promptText, sandboxPolicyFor } from "./config.ts"
import type { InitializeParams } from "./generated/InitializeParams.ts"
import type { ThreadForkParams } from "./generated/v2/ThreadForkParams.ts"
import type { ThreadItem } from "./generated/v2/ThreadItem.ts"
import type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams.ts"
import type { ThreadStartParams } from "./generated/v2/ThreadStartParams.ts"
import type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse.ts"
import type { TurnStartParams } from "./generated/v2/TurnStartParams.ts"
import type { TurnStartResponse } from "./generated/v2/TurnStartResponse.ts"
import type { TurnSteerParams } from "./generated/v2/TurnSteerParams.ts"
import type { UserInput } from "./generated/v2/UserInput.ts"
import { GitSnapshotter } from "./snapshot.ts"
import { CodexTranslator, isReadOnlyCommand } from "./translator.ts"

const CLIENT_VERSION = "0.1.0"
const REQUEST_TIMEOUT_MS = 60_000
/** How long close() waits for an in-flight turn to wind down after interrupting it. */
const CLOSE_INTERRUPT_MS = 2_000

type Proc = Bun.Subprocess<"pipe", "pipe", "pipe">

function textInput(text: string): UserInput[] {
  return [{ type: "text", text, text_elements: [] }]
}

export interface CodexSessionOptions {
  /** Binary to run (already resolved). */
  bin: string
  /** Append every JSON-RPC message (both directions) to this JSONL file — used to record fixtures. */
  tapFile?: string
}

export class CodexSession implements AgentSession {
  private proc!: Proc
  private peer!: JsonRpcPeer
  private translator: CodexTranslator
  private threadId: string | undefined
  private model: string | undefined
  /** True from sending turn/start until turn/completed. */
  private running = false
  private queue: PromptInput[] = []
  private interruptRequested = false
  private approvalOverride: ApprovalSettings | undefined
  private closing = false
  /** Set once the app-server process has exited (for whatever reason). */
  private dead = false
  private stdoutDone: Promise<void> = Promise.resolve()
  private exited = deferred<number | null>()
  private turnIdle: ReturnType<typeof deferred<void>> | undefined
  /** Inbound messages are processed strictly in order (some steps are async). */
  private inbox: Promise<void> = Promise.resolve()
  /** Workspace snapshots for diffing shell-command edits (undefined = disabled). */
  private snapshots: GitSnapshotter | undefined
  /** Tree id of the workspace as of the last observed change. */
  private baseline: string | undefined

  constructor(
    private readonly cfg: SessionConfig,
    private readonly ctx: AdapterContext,
    private readonly opts: CodexSessionOptions,
  ) {
    this.model = cfg.model
    this.translator = new CodexTranslator((e) => ctx.emit(e), {
      keepRaw: process.env.BATON_KEEP_RAW === "1",
      log: (level, msg) => ctx.log(level, msg),
    })
    this.translator.onTurnEnded = () => this.turnEnded()
    if (cfg.options?.shellDiffs !== false) this.snapshots = new GitSnapshotter(cfg.cwd, (m) => ctx.log("debug", `codex snapshots: ${m}`))
  }

  // ───────────────────────────── startup ─────────────────────────────

  async start(): Promise<void> {
    const { args, env, modelProvider } = appServerArgs(this.cfg)
    this.ctx.emit({ type: "agent.status", data: { status: "starting" } })
    this.ctx.log("info", `spawning ${this.opts.bin} ${args.filter((a) => !a.includes("http_headers")).join(" ")}`)
    this.proc = Bun.spawn([this.opts.bin, ...args], {
      cwd: this.cfg.cwd,
      env: { ...process.env, PATH: augmentedPath(), ...env, ...this.cfg.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Own process group so close() can take down anything codex spawned (shell tools, MCP servers).
      detached: true,
    })
    this.peer = new JsonRpcPeer((msg) => this.write(msg), { includeVersion: false })
    this.stdoutDone = this.readStdout()
    void this.readStderr()
    void this.proc.exited.then((code) => this.onExit(code))
    this.ctx.signal.addEventListener("abort", () => void this.close(), { once: true })

    try {
      const init: InitializeParams = {
        clientInfo: { name: "baton", title: "Baton", version: CLIENT_VERSION },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }
      await this.peer.request("initialize", init, REQUEST_TIMEOUT_MS)
      this.peer.notify("initialized")
      await this.openThread(modelProvider)
      this.translator.setStatus("ready")
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.ctx.emit({ type: "error", data: { message: `codex failed to start: ${message}`, fatal: true } })
      await this.close()
      throw e
    }
  }

  private async openThread(modelProvider: string | undefined): Promise<void> {
    const { approvalPolicy, sandbox } = approvalSettings(this.cfg.approval, this.cfg.options)
    const common = {
      cwd: this.cfg.cwd,
      model: this.cfg.model ?? null,
      modelProvider: modelProvider ?? null,
      approvalPolicy,
      sandbox,
      developerInstructions: this.cfg.systemPrompt ?? null,
    }
    let res: ThreadStartResponse
    if (this.cfg.resumeId && this.cfg.options?.fork === true) {
      const params: ThreadForkParams = { threadId: this.cfg.resumeId, ...common }
      res = await this.peer.request<ThreadStartResponse>("thread/fork", params, REQUEST_TIMEOUT_MS)
    } else if (this.cfg.resumeId) {
      const params: ThreadResumeParams = { threadId: this.cfg.resumeId, ...common, excludeTurns: true }
      res = await this.peer.request<ThreadStartResponse>("thread/resume", params, REQUEST_TIMEOUT_MS)
    } else {
      const params: ThreadStartParams = { ...common, serviceName: "baton" }
      res = await this.peer.request<ThreadStartResponse>("thread/start", params, REQUEST_TIMEOUT_MS)
    }
    this.threadId = res.thread.id
    this.model = this.model ?? res.model
    this.translator.setThread(res.thread.id)
    this.ctx.log("info", `codex thread ${res.thread.id} (model ${res.model}, approval ${JSON.stringify(res.approvalPolicy)})`)
  }

  // ───────────────────────────── transport ─────────────────────────────

  private write(msg: JsonRpcMessage): void {
    if (this.opts.tapFile) appendFileSync(this.opts.tapFile, `${JSON.stringify({ dir: "out", msg })}\n`)
    try {
      this.proc.stdin.write(`${JSON.stringify(msg)}\n`)
      this.proc.stdin.flush()
    } catch (e) {
      this.ctx.log("warn", `codex stdin write failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async readStdout(): Promise<void> {
    try {
      for await (const line of readLines(this.proc.stdout)) {
        let msg: JsonRpcMessage
        try {
          msg = JSON.parse(line) as JsonRpcMessage
        } catch {
          this.ctx.log("debug", `codex stdout (non-JSON): ${line.slice(0, 500)}`)
          continue
        }
        if (this.opts.tapFile) appendFileSync(this.opts.tapFile, `${JSON.stringify({ dir: "in", msg })}\n`)
        this.inbox = this.inbox
          .then(() => this.route(msg))
          .catch((e) => this.ctx.log("warn", `codex: failed handling ${msg.method ?? "response"}: ${e instanceof Error ? e.message : String(e)}`))
      }
    } catch (e) {
      this.ctx.log("warn", `codex stdout read failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  private async route(msg: JsonRpcMessage): Promise<void> {
    const raw = process.env.BATON_KEEP_RAW === "1" ? msg : undefined
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      const r = this.translator.serverRequest(msg.id, msg.method, msg.params, raw)
      if (!r) {
        this.ctx.log("debug", `codex: unsupported server request ${msg.method}`)
        this.write({ id: msg.id, error: { code: -32601, message: `baton does not support ${msg.method}` } })
      }
      return
    }
    if (msg.method !== undefined) {
      if (this.translator.isForeign(msg.params)) {
        this.ctx.log("debug", `codex: ignoring ${msg.method} for another thread`)
        return
      }
      this.translator.notification(msg.method, msg.params, raw)
      if (msg.method === "item/completed") await this.afterItem((msg.params as { item: ThreadItem }).item)
      return
    }
    void this.peer.handle(msg)
  }

  /**
   * After a command finishes, diff the workspace against the last snapshot so edits made via
   * the shell surface as diffs; after apply_patch, just move the baseline (codex reported it).
   */
  private async afterItem(item: ThreadItem): Promise<void> {
    if (!this.snapshots || this.baseline === undefined) return
    if (item.type === "fileChange") {
      this.baseline = (await this.snapshots.snapshot()) ?? this.baseline
      return
    }
    if (item.type !== "commandExecution" || isReadOnlyCommand(item)) return
    const now = await this.snapshots.snapshot()
    if (!now || now === this.baseline) return
    const files = await this.snapshots.diff(this.baseline, now)
    this.baseline = now
    this.translator.shellEdits(item.id, files)
  }

  private async readStderr(): Promise<void> {
    try {
      for await (const line of readLines(this.proc.stderr)) {
        const level = /\b(ERROR|FATAL|panicked)\b/.test(line) ? "warn" : "debug"
        this.ctx.log(level, `codex stderr: ${line}`)
      }
    } catch {}
  }

  private async onExit(code: number | null): Promise<void> {
    this.dead = true
    this.queue = []
    // Let already-received output (e.g. a final turn/completed) be translated before reporting the exit.
    await Promise.race([this.stdoutDone.then(() => this.inbox), Bun.sleep(1_000)])
    this.peer.close(`codex exited (${code})`)
    if (!this.closing) {
      this.ctx.emit({ type: "error", data: { message: `codex app-server exited unexpectedly (code ${code})`, fatal: true } })
    }
    // Pending permissions can never be answered now.
    this.translator.cancelAll()
    // A turn that was running can never complete: report it as failed so the host records a result.
    if (this.translator.activeTurnId) this.translator.failTurn(this.closing ? "cancelled" : "error")
    this.running = false
    this.queue = []
    this.turnIdle?.resolve()
    this.ctx.emit({ type: "agent.exited", data: { code, reason: this.closing ? "closed" : "crashed" } })
    this.translator.setStatus("exited")
    this.exited.resolve(code)
  }

  // ───────────────────────────── turns ─────────────────────────────

  private assertAlive(): void {
    if (this.dead) throw new Error("codex app-server has exited")
    if (this.closing) throw new Error("codex session is closed")
  }

  async prompt(input: PromptInput): Promise<void> {
    this.assertAlive()
    if (this.running) {
      this.queue.push(input)
      this.ctx.log("debug", `codex: turn running, queued prompt (${this.queue.length} queued)`)
      return
    }
    await this.startTurn(input)
  }

  private async startTurn(input: PromptInput): Promise<void> {
    if (!this.threadId) throw new Error("codex thread not started")
    this.running = true
    this.interruptRequested = false
    this.turnIdle = deferred<void>()
    const text = promptText(input)
    this.translator.notePrompt(input.text)
    const params: TurnStartParams = { threadId: this.threadId, input: textInput(text), model: this.model ?? null }
    // autonomy switched mid-session: override approval + sandbox from this turn on
    if (this.approvalOverride) {
      params.approvalPolicy = this.approvalOverride.approvalPolicy
      params.sandboxPolicy = sandboxPolicyFor(this.approvalOverride.sandbox)
    }
    try {
      if (this.snapshots) this.baseline = await this.snapshots.snapshot()
      const res = await this.peer.request<TurnStartResponse>("turn/start", params, REQUEST_TIMEOUT_MS)
      // turn/started normally precedes the response; record the id either way.
      if (!this.translator.activeTurnId && res.turn.status === "inProgress") this.translator.activeTurnId = res.turn.id
      if (this.interruptRequested) await this.interruptTurn()
    } catch (e) {
      this.running = false
      this.turnIdle.resolve()
      if (this.dead) throw new Error("codex app-server has exited")
      const message = e instanceof Error ? e.message : String(e)
      this.ctx.emit({ type: "error", data: { message: `codex turn/start failed: ${message}` } })
      this.translator.setStatus("ready")
      throw e
    }
  }

  private turnEnded(): void {
    this.running = false
    this.turnIdle?.resolve()
    const next = this.queue.shift()
    if (next && !this.closing && !this.dead) {
      this.startTurn(next).catch((e) => this.ctx.log("warn", `codex: queued prompt failed: ${e instanceof Error ? e.message : String(e)}`))
    }
  }

  async steer(input: PromptInput): Promise<void> {
    this.assertAlive()
    const turnId = this.translator.activeTurnId
    if (!this.threadId || !turnId) return this.prompt(input)
    const params: TurnSteerParams = { threadId: this.threadId, input: textInput(promptText(input)), expectedTurnId: turnId }
    try {
      await this.peer.request("turn/steer", params, REQUEST_TIMEOUT_MS)
    } catch (e) {
      // The turn ended between our check and codex receiving the steer: run it as a new turn.
      if (this.dead) throw new Error("codex app-server has exited")
      this.ctx.log("info", `codex: steer rejected (${e instanceof Error ? e.message : String(e)}); queueing as a prompt`)
      await this.prompt(input)
    }
  }

  async interrupt(): Promise<void> {
    this.queue = []
    await this.interruptTurn()
  }

  /** Interrupt the running turn without touching the prompt queue. */
  private async interruptTurn(): Promise<void> {
    if (!this.running || !this.threadId || this.dead) return
    const turnId = this.translator.activeTurnId
    if (!turnId) {
      // turn/start is still in flight; interrupt as soon as we learn the turn id.
      this.interruptRequested = true
      return
    }
    try {
      await this.peer.request("turn/interrupt", { threadId: this.threadId, turnId }, REQUEST_TIMEOUT_MS)
    } catch (e) {
      this.ctx.log("warn", `codex turn/interrupt failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  async respondPermission(requestId: string, optionId: string | null): Promise<void> {
    const r = this.translator.resolvePermission(requestId, optionId, "user")
    if (!r) {
      this.ctx.log("debug", `codex: permission ${requestId} already resolved`)
      return
    }
    this.write({ id: r.rpcId, result: r.result })
  }

  /** Applies from the next turn (Codex takes approval/sandbox overrides per turn/start). */
  async setApproval(mode: ApprovalMode): Promise<void> {
    this.assertAlive()
    this.approvalOverride = approvalSettings(mode, this.cfg.options)
  }

  async setModel(model: string): Promise<void> {
    // Applied on the next turn/start ("override the model for this turn and subsequent turns").
    this.model = model
  }

  resumeId(): string | undefined {
    return this.threadId
  }

  // ───────────────────────────── shutdown ─────────────────────────────

  async close(): Promise<void> {
    if (this.closing) {
      await this.exited.promise
      return
    }
    this.closing = true
    this.queue = []
    if (!this.proc) {
      this.exited.resolve(null)
      return
    }
    for (const r of this.translator.cancelAll()) this.write({ id: r.rpcId, result: r.result })
    if (!this.dead && this.running && this.translator.activeTurnId) {
      // Bounded: a wedged app-server must not hold up shutdown.
      const deadline = Bun.sleep(CLOSE_INTERRUPT_MS)
      await Promise.race([this.interruptTurn().then(() => this.turnIdle?.promise), deadline])
    }
    if (!this.dead) {
      try {
        this.proc.stdin.end()
      } catch {}
      const exited = await Promise.race([this.exited.promise.then(() => true), Bun.sleep(2_000).then(() => false)])
      if (!exited) {
        this.killTree("SIGTERM")
        const gone = await Promise.race([this.exited.promise.then(() => true), Bun.sleep(2_000).then(() => false)])
        if (!gone) this.killTree("SIGKILL")
      }
    }
    // Take down anything codex left behind in its process group.
    this.killTree("SIGKILL")
    await this.exited.promise
    this.snapshots?.dispose()
  }

  private killTree(sig: NodeJS.Signals): void {
    const pid = this.proc?.pid
    if (!pid) return
    try {
      process.kill(-pid, sig)
      return
    } catch {}
    try {
      this.proc.kill(sig)
    } catch {}
  }
}
