/**
 * OpenCode adapter: one `opencode serve` per session (127.0.0.1, random port, basic auth via
 * OPENCODE_SERVER_PASSWORD), driven over REST with `@opencode-ai/sdk` and translated from the
 * SSE `/event` stream into BEP.
 */
import type { AdapterCapabilities, AdapterContext, AgentAdapter, AgentEvent, AgentSession, DetectResult, PromptInput, SessionConfig } from "@batonsh/protocol"
import { augmentedPath, deferred, defineAdapter, IS_WINDOWS, killProcessTree, parseVersion, readLines, runCapture, spawnable, which } from "@batonsh/protocol"
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk/v2"
import { buildConfig, splitModel } from "./config.ts"
import { type OcEvent, OpencodeTranslator, replyFor } from "./translate.ts"

export { buildConfig, permissionFor, splitModel } from "./config.ts"
export type { OcEvent } from "./translate.ts"
export { OpencodeTranslator, PERMISSION_OPTIONS, replyFor, stopReasonFor } from "./translate.ts"

const READY_TIMEOUT_MS = 30_000
const INTERRUPT_GRACE_MS = 5_000
const KILL_GRACE_MS = 3_000

/**
 * Watchdog wrapper: runs the server in the background with our stdin kept on fd 3. When the host
 * dies (even SIGKILL) the stdin pipe hits EOF and the watchdog tears down the whole process group,
 * so `opencode serve` (and anything it spawned) never outlives baton. The wrapper exits with the
 * server's exit code when the server exits on its own.
 */
const WATCHDOG = [
  "exec 3<&0",
  '"$@" </dev/null 3<&- &',
  "pid=$!",
  // on stdin EOF: TERM the group, give the server up to ~3s to go, then KILL the group (incl. this watchdog)
  '( trap "" TERM; read _ <&3; kill -TERM 0 2>/dev/null; i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done; kill -KILL 0 2>/dev/null ) &',
  "w=$!",
  "exec 3<&-",
  'wait "$pid"',
  "code=$?",
  'kill "$w" 2>/dev/null',
  'exit "$code"',
].join("\n")

export type ServeProcess = Bun.Subprocess<"pipe", "pipe", "pipe">

/** Spawn `cmd` in its own process group behind the stdin-EOF watchdog (see WATCHDOG). */
export function spawnWatched(cmd: string[], opts: { cwd?: string; env?: Record<string, string | undefined> }): ServeProcess {
  if (IS_WINDOWS) {
    // no sh, no process groups: start it directly; close() ends the whole tree with taskkill
    const run = spawnable(cmd)
    return Bun.spawn(run.cmd, { ...run.opts, cwd: opts.cwd, env: opts.env, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  }
  return Bun.spawn(["/bin/sh", "-c", WATCHDOG, "baton-opencode", ...cmd], {
    windowsHide: true,
    cwd: opts.cwd,
    env: opts.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
  })
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(IS_WINDOWS ? pgid : -pgid, 0)
    return true
  } catch (e) {
    return (e as { code?: string }).code === "EPERM"
  }
}

/** Signal the process group of a {@link spawnWatched} process (falls back to the pid itself). */
export function killGroup(proc: { pid: number; exitCode?: number | null; kill(sig?: NodeJS.Signals | number): void }, sig: NodeJS.Signals): void {
  killProcessTree(proc.pid, sig, proc.exitCode === undefined ? undefined : { exitCode: proc.exitCode })
}

function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Buffer.from(bytes).toString("base64url")
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}

/** Count configured credentials in `opencode auth list` output (never returns the text itself). */
export function parseAuthList(out: string): number | undefined {
  const clean = stripAnsi(out)
  let bullets = 0
  for (const line of clean.split("\n")) if (/^\s*[●•]\s+\S/.test(line)) bullets++
  if (bullets > 0) return bullets
  const m = /(\d+)\s+(?:credentials?|environment variables?)/i.exec(clean)
  if (m) return Number(m[1])
  return undefined
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === "object") {
    const o = e as { data?: { message?: string }; message?: string; name?: string }
    return o.data?.message ?? o.message ?? o.name ?? JSON.stringify(e)
  }
  return String(e)
}

function isTurnEnd(e: AgentEvent): boolean {
  return e.type === "turn.completed" || e.type === "turn.interrupted"
}

class OpencodeSession implements AgentSession {
  private translator: OpencodeTranslator
  private client!: OpencodeClient
  private proc!: ServeProcess
  /** start() finished: lifecycle events (crash / agent.exited) are only emitted for a live session. */
  private started = false
  private sessionID: string | undefined
  private model: { providerID: string; modelID: string } | undefined
  private queue: PromptInput[] = []
  private starting = false
  private closing = false
  private exited = false
  private sseAbort: AbortController | undefined
  private connected = deferred<void>()
  private connectedOnce = false

  constructor(
    private cfg: SessionConfig,
    private ctx: AdapterContext,
  ) {
    this.translator = new OpencodeTranslator({ cwd: cfg.cwd, includeRaw: cfg.options?.raw === true })
    this.model = splitModel(cfg.model, cfg.provider?.id)
  }

  async start(): Promise<void> {
    const bin = which(this.cfg.command ?? "opencode")
    if (!bin) throw new Error("opencode not found on PATH (install: `bun add -g opencode-ai` or `curl -fsSL https://opencode.ai/install | bash`)")
    const password = randomPassword()
    const config = buildConfig(this.cfg)
    this.proc = spawnWatched([bin, "serve", "--port", "0", "--hostname", "127.0.0.1", ...(this.cfg.args ?? [])], {
      cwd: this.cfg.cwd,
      env: {
        ...process.env,
        PATH: augmentedPath(),
        ...this.cfg.env,
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
    })
    this.ctx.log("debug", `spawned opencode serve pid=${this.proc.pid} in ${this.cfg.cwd}`)

    const url = deferred<string>()
    void this.pump(this.proc.stdout as ReadableStream<Uint8Array>, "stdout", url.resolve)
    void this.pump(this.proc.stderr as ReadableStream<Uint8Array>, "stderr", url.resolve)
    void this.proc.exited.then((code) => {
      this.exited = true
      url.reject(new Error(`opencode serve exited with code ${code} before it was ready`))
      this.onExit(code)
    })
    const readyMs = typeof this.cfg.options?.readyTimeoutMs === "number" ? this.cfg.options.readyTimeoutMs : READY_TIMEOUT_MS
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      url.reject(new Error(`opencode serve not ready after ${readyMs}ms`))
    }, readyMs)
    let baseUrl: string
    try {
      baseUrl = await url.promise
    } catch (e) {
      this.closing = true
      // an unresponsive server gets no grace period
      if (timedOut) killGroup(this.proc, "SIGKILL")
      else await this.terminate()
      throw e
    } finally {
      clearTimeout(timer)
    }
    this.ctx.log("info", `opencode serve listening on ${baseUrl}`)

    this.client = createOpencodeClient({
      baseUrl,
      headers: { authorization: `Basic ${btoa(`opencode:${password}`)}` },
    })

    void this.sseLoop()
    const connectTimer = setTimeout(() => this.connected.reject(new Error("timed out connecting to opencode event stream")), 15_000)
    try {
      await this.connected.promise
    } finally {
      clearTimeout(connectTimer)
    }

    if (this.cfg.resumeId) {
      const got = await this.client.session.get({ sessionID: this.cfg.resumeId })
      if (got.error || !got.data) throw new Error(`cannot resume opencode session ${this.cfg.resumeId}: ${errMessage(got.error)}`)
      this.sessionID = got.data.id
    } else {
      const created = await this.client.session.create({ title: this.cfg.name })
      if (created.error || !created.data) throw new Error(`cannot create opencode session: ${errMessage(created.error)}`)
      this.sessionID = created.data.id
    }
    this.translator.setSession(this.sessionID)
    this.emit({ type: "agent.session", data: { sessionId: this.sessionID } })
    if (this.cfg.resumeId) await this.resync()
    if (!this.translator.turnActive) this.emitAll(this.translator.endTurn())

    this.started = true
    this.ctx.signal.addEventListener("abort", () => void this.close(), { once: true })
  }

  // ───────────────────────────── transport ─────────────────────────────

  private async pump(stream: ReadableStream<Uint8Array>, name: string, onUrl: (url: string) => void): Promise<void> {
    try {
      for await (const line of readLines(stream)) {
        const m = /listening on (https?:\/\/\S+)/.exec(line)
        if (m?.[1]) onUrl(m[1])
        this.ctx.log("debug", `[opencode ${name}] ${line}`)
      }
    } catch {
      // stream closed with the process
    }
  }

  private async sseLoop(): Promise<void> {
    let attempt = 0
    while (!this.closing && !this.exited) {
      const ac = new AbortController()
      this.sseAbort = ac
      try {
        const { stream } = await this.client.event.subscribe(undefined, {
          signal: ac.signal,
          sseMaxRetryAttempts: 1,
          onSseError: (e) => {
            if (!this.closing) this.ctx.log("warn", `opencode event stream error: ${errMessage(e)}`)
          },
        })
        for await (const ev of stream as AsyncIterable<OcEvent>) {
          if (!ev || typeof ev !== "object" || typeof ev.type !== "string") continue
          if (ev.type === "server.connected") {
            attempt = 0
            if (this.connectedOnce) await this.resync()
            this.connectedOnce = true
            this.connected.resolve()
            continue
          }
          this.dispatch(ev)
        }
      } catch (e) {
        if (!this.closing) this.ctx.log("warn", `opencode event stream failed: ${errMessage(e)}`)
      }
      if (this.closing || this.exited) break
      attempt++
      this.ctx.log("info", `opencode event stream disconnected; reconnecting (attempt ${attempt})`)
      await Bun.sleep(Math.min(200 * 2 ** attempt, 5_000))
    }
  }

  /** After a reconnect / resume: catch up on state we may have missed. */
  private async resync(): Promise<void> {
    const sid = this.sessionID
    if (!sid) return
    try {
      const st = await this.client.session.status()
      const mine = st.data?.[sid]
      if (mine && mine.type !== "idle" && !this.translator.turnActive) {
        this.dispatch({ type: "session.status", properties: { sessionID: sid, status: mine } })
      } else if ((!mine || mine.type === "idle") && this.translator.turnActive) {
        this.dispatch({ type: "session.idle", properties: { sessionID: sid } })
        if (this.translator.turnActive) this.finishTurn(this.translator.endTurn())
      }
      const perms = await this.client.permission.list()
      for (const req of perms.data ?? []) this.dispatch({ type: "permission.asked", properties: req as unknown as Record<string, unknown> })
    } catch (e) {
      this.ctx.log("warn", `opencode resync failed: ${errMessage(e)}`)
    }
  }

  private dispatch(ev: OcEvent): void {
    if (ev.type === "question.asked") {
      const p = ev.properties as { id?: string; sessionID?: string } | undefined
      if (p?.id && p.sessionID === this.sessionID) {
        this.ctx.log("warn", "opencode asked an interactive question; rejecting (not supported by baton)")
        void this.client.question.reject({ requestID: p.id }).catch(() => {})
      }
      return
    }
    this.finishTurn(this.translator.handle(ev))
  }

  private finishTurn(events: AgentEvent[]): void {
    this.emitAll(events)
    if (events.some(isTurnEnd)) void this.drain()
  }

  private emit(e: AgentEvent): void {
    this.ctx.emit(e)
  }

  private emitAll(events: AgentEvent[]): void {
    for (const e of events) this.emit(e)
  }

  private onExit(code: number | null): void {
    this.sseAbort?.abort()
    // a failed start() throws instead; the host never saw a session, so don't report its exit
    if (!this.started) return
    if (!this.closing) {
      this.ctx.emit({ type: "error", data: { message: `opencode server exited unexpectedly (code ${code})`, fatal: true } })
      if (this.translator.turnActive) for (const e of this.translator.endTurn({ interrupted: true })) this.ctx.emit(e)
      this.ctx.emit({ type: "agent.status", data: { status: "exited" } })
    }
    this.ctx.emit({ type: "agent.exited", data: { code, reason: this.closing ? "closed" : "crashed" } })
  }

  // ───────────────────────────── turns ─────────────────────────────

  private async drain(): Promise<void> {
    if (this.closing || this.translator.turnActive || this.starting) return
    const next = this.queue.shift()
    if (next) await this.startTurn(next)
  }

  private async startTurn(input: PromptInput): Promise<void> {
    const sid = this.sessionID
    if (!sid) throw new Error("opencode session not started")
    this.starting = true
    try {
      this.emitAll(this.translator.beginTurn(input.text))
      const text = input.from && input.from !== "user" ? `[message from ${input.from}]\n${input.text}` : input.text
      const res = await this.client.session.promptAsync({
        sessionID: sid,
        parts: [{ type: "text", text }],
        ...(this.model ? { model: this.model } : {}),
        ...(this.cfg.systemPrompt ? { system: this.cfg.systemPrompt } : {}),
      })
      if (res.error) {
        this.emit({ type: "error", data: { message: `opencode rejected the prompt: ${errMessage(res.error)}` } })
        this.finishTurn(this.translator.endTurn({ stopReason: "error" }))
      }
    } catch (e) {
      this.emit({ type: "error", data: { message: `opencode prompt failed: ${errMessage(e)}` } })
      this.finishTurn(this.translator.endTurn({ stopReason: "error" }))
    } finally {
      this.starting = false
    }
    if (!this.translator.turnActive) void this.drain()
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.closing) throw new Error("session closed")
    // OpenCode would fold a mid-turn prompt into the running loop at the next step; baton keeps
    // turns 1:1 with prompts by queueing locally and sending after `session.idle`.
    if (this.translator.turnActive || this.starting) {
      this.queue.push(input)
      return
    }
    await this.startTurn(input)
  }

  async interrupt(): Promise<void> {
    const sid = this.sessionID
    if (!sid || !this.translator.turnActive) return
    const turnId = this.translator.currentTurnId
    this.translator.markInterrupting()
    try {
      const res = await this.client.session.abort({ sessionID: sid })
      if (res.error) this.ctx.log("warn", `opencode abort failed: ${errMessage(res.error)}`)
    } catch (e) {
      this.ctx.log("warn", `opencode abort failed: ${errMessage(e)}`)
    }
    // OpenCode normally answers with session.idle; don't hang if it doesn't.
    setTimeout(() => {
      if (this.translator.turnActive && this.translator.currentTurnId === turnId && !this.closing) {
        this.finishTurn(this.translator.endTurn({ interrupted: true }))
      }
    }, INTERRUPT_GRACE_MS)
  }

  async respondPermission(requestId: string, optionId: string | null): Promise<void> {
    const reply = replyFor(optionId)
    this.translator.noteReply(requestId, optionId)
    const res = await this.client.permission.reply({ requestID: requestId, reply })
    if (res.error) {
      const message = `opencode permission reply failed: ${errMessage(res.error)}`
      this.ctx.log("warn", message)
      this.emit({ type: "error", data: { message } })
    }
  }

  async setModel(model: string): Promise<void> {
    const m = splitModel(model, this.cfg.provider?.id)
    if (!m) throw new Error(`opencode model must be "provider/model", got "${model}"`)
    this.model = m
    this.emit({ type: "agent.updated", data: { model: `${m.providerID}/${m.modelID}` } })
  }

  resumeId(): string | undefined {
    return this.sessionID
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    this.queue = []
    if (this.translator.turnActive && this.sessionID && !this.exited) {
      try {
        await Promise.race([this.client.session.abort({ sessionID: this.sessionID }), Bun.sleep(2_000)])
      } catch {
        // server may already be gone
      }
      for (const e of this.translator.endTurn({ interrupted: true })) this.ctx.emit(e)
    }
    this.sseAbort?.abort()
    await this.terminate()
  }

  /** SIGTERM the server's process group, then SIGKILL whatever is left after a grace period. */
  private async terminate(): Promise<void> {
    if (!this.proc) return
    try {
      this.proc.stdin.end()
    } catch {
      // already closed
    }
    killGroup(this.proc, "SIGTERM")
    // wait for the whole group (not just the wrapper) so the server can shut down gracefully
    const deadline = Date.now() + KILL_GRACE_MS
    while (Date.now() < deadline && groupAlive(this.proc.pid)) await Bun.sleep(50)
    killGroup(this.proc, "SIGKILL")
    await Promise.race([this.proc.exited, Bun.sleep(1_000)])
  }
}

export const opencodeAdapter: AgentAdapter = defineAdapter({
  id: "opencode",
  displayName: "OpenCode",
  family: "opencode",
  binaries: ["opencode"],

  async detect(opts?: { command?: string }): Promise<DetectResult> {
    const path = which(opts?.command ?? "opencode")
    if (!path) return { installed: false, auth: "unknown", authHint: "install opencode: `bun add -g opencode-ai`", protocols: [] }
    const result: DetectResult = { installed: true, path, auth: "unknown", protocols: ["serve", "acp", "run-json"] }
    try {
      const v = await runCapture([path, "--version"], { timeoutMs: 10_000 })
      result.version = parseVersion(v.stdout) ?? parseVersion(v.stderr)
    } catch {
      // leave version undefined
    }
    try {
      const a = await runCapture([path, "auth", "list"], { timeoutMs: 15_000 })
      const n = parseAuthList(`${a.stdout}\n${a.stderr}`)
      if (n === undefined) result.auth = "unknown"
      else if (n > 0) {
        result.auth = "ok"
        result.notes = [`${n} provider credential${n === 1 ? "" : "s"} configured`]
      } else {
        result.auth = "missing"
        result.authHint = "run `baton login opencode` (OpenCode's own provider sign-in)"
        result.login = [path, "auth", "login"]
      }
    } catch {
      result.auth = "unknown"
    }
    return result
  },

  capabilities(): AdapterCapabilities {
    return {
      steer: false,
      interrupt: true,
      resume: true,
      fork: false,
      diff: true,
      usage: true,
      cost: true,
      permissions: true,
      mcp: true,
      models: [],
    }
  },

  async start(cfg: SessionConfig, ctx: AdapterContext): Promise<AgentSession> {
    const s = new OpencodeSession(cfg, ctx)
    try {
      await s.start()
    } catch (e) {
      await s.close().catch(() => {})
      throw e
    }
    return s
  },
})

export default opencodeAdapter
