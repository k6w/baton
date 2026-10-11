/**
 * @batonsh/sdk — the public client. The Baton TUI is built exclusively on this API.
 *
 *   const baton = await connect({ cwd: process.cwd() })
 *   const run = await baton.live()
 *   run.onChange(() => render(run.state))
 *   await baton.submit("@codex-2 verify codex-1's fix")
 */
import { existsSync, readFileSync } from "node:fs"
import net from "node:net"
import { join } from "node:path"
import { findProjectRoot, projectPaths, RunState } from "@batonsh/kernel"
import { type BatonEvent, CONTROL_PROTOCOL_VERSION, type ControlMethod, type ControlParams, type ControlResult, ipcPath, JsonRpcPeer } from "@batonsh/protocol"

export interface ConnectOptions {
  /** Directory inside the project (default: process.cwd()). */
  cwd?: string
  /** Explicit socket path (skips discovery). */
  socketPath?: string
  /** Start a daemon if none is running (default true). */
  autostart?: boolean
  /** Command used to launch a detached daemon: receives the project root. */
  daemonCommand?: (projectRoot: string) => string[]
  /** Wait this long for a freshly started daemon (ms). */
  startTimeoutMs?: number
  clientName?: string
  /** The human behind this client (shown to everyone watching the run). */
  user?: string
}

export function discoverSocket(projectRoot: string): string {
  const paths = projectPaths(projectRoot)
  const alt = join(paths.run, "socket-path")
  if (existsSync(alt)) {
    const p = readFileSync(alt, "utf8").trim()
    if (p) return p
  }
  return paths.socket
}

export class BatonClient {
  private peer: JsonRpcPeer
  private socket?: { write(b: Uint8Array): number; end(): void; terminate(): void }
  private buf = ""
  private retry?: ReturnType<typeof setTimeout>
  private decoder = new TextDecoder()
  private eventHandlers = new Map<string, (e: BatonEvent) => void>()
  private closeHandlers = new Set<(reason: string) => void>()
  private outbox: Uint8Array[] = []
  private encoder = new TextEncoder()
  private early: { subscriptionId: string; event: BatonEvent }[] = []
  /** events.subscribe calls awaiting their response (only then can events race ahead). */
  private subscribing = 0
  private closeAfterFlush = false
  closed = false
  projectRoot = ""
  runId = ""
  daemonPid = 0

  private constructor() {
    this.peer = new JsonRpcPeer((msg) => this.write(`${JSON.stringify(msg)}\n`))
    this.peer.onNotification("event", (p: { subscriptionId: string; event: BatonEvent }) => {
      const h = this.eventHandlers.get(p.subscriptionId)
      if (h) h(p.event)
      // raced ahead of events.subscribe's response; anything else is for a closed subscription
      else if (this.subscribing > 0 && this.early.length < 100_000) this.early.push(p)
    })
    this.peer.onNotification("daemon.closing", (p: { reason: string }) => this.handleClose(p.reason))
  }

  private write(s: string) {
    this.outbox.push(this.encoder.encode(s))
    if (this.socket) this.flush()
  }

  private flush() {
    while (this.socket && this.outbox.length) {
      const chunk = this.outbox[0] as Uint8Array
      const n = this.socket.write(chunk)
      if (n >= chunk.byteLength) this.outbox.shift()
      else {
        this.outbox[0] = chunk.subarray(Math.max(0, n))
        // drain may not come on Windows named pipes: retry on a timer too
        if (!this.retry)
          this.retry = setTimeout(() => {
            this.retry = undefined
            if (!this.closed) this.flush()
          }, 10)
        return
      }
    }
    if (this.closeAfterFlush && this.outbox.length === 0) this.socket?.end()
  }

  private handleClose(reason: string) {
    if (this.closed) return
    this.closed = true
    this.peer.close(reason)
    for (const h of this.closeHandlers) h(reason)
  }

  static async open(socketPath: string, clientName = "sdk", user?: string): Promise<BatonClient> {
    const c = new BatonClient()
    const onData = (chunk: Uint8Array) => {
      c.buf += c.decoder.decode(chunk, { stream: true })
      let nl = c.buf.indexOf("\n")
      while (nl >= 0) {
        const line = c.buf.slice(0, nl)
        c.buf = c.buf.slice(nl + 1)
        if (line.trim()) {
          try {
            void c.peer.handle(JSON.parse(line))
          } catch {}
        }
        nl = c.buf.indexOf("\n")
      }
    }
    if (process.platform === "win32") {
      // node:net on the daemon's named pipe: it queues writes itself (Bun's sockets stall on busy pipes)
      const s = await new Promise<net.Socket>((resolve, reject) => {
        const sock = net.connect(ipcPath(socketPath))
        sock.once("connect", () => resolve(sock))
        sock.once("error", reject)
      })
      s.on("data", (b: Buffer) => onData(b))
      s.on("close", () => c.handleClose("socket closed"))
      s.on("error", () => c.handleClose("socket error"))
      c.socket = {
        write: (b) => {
          s.write(b)
          return b.byteLength
        },
        end: () => s.end(),
        terminate: () => s.destroy(),
      }
    } else
      c.socket = await Bun.connect<undefined>({
        unix: socketPath,
        socket: {
          data: (_s, chunk) => onData(chunk),
          drain: () => c.flush(),
          close: () => c.handleClose("socket closed"),
          error: () => c.handleClose("socket error"),
        },
      })
    c.flush()
    try {
      const hello = await c.call("hello", { client: clientName, version: CONTROL_PROTOCOL_VERSION, ...(user ? { user } : {}) }, 10_000)
      c.projectRoot = hello.projectRoot
      c.runId = hello.runId
      c.daemonPid = hello.pid
    } catch (e) {
      c.socket?.terminate()
      c.handleClose("hello failed")
      throw e
    }
    return c
  }

  call<M extends ControlMethod>(method: M, params?: ControlParams<M>, timeoutMs = 0): Promise<ControlResult<M>> {
    if (this.closed) return Promise.reject(new Error("baton: connection closed"))
    return this.peer.request<ControlResult<M>>(method, params ?? {}, timeoutMs)
  }

  /** Subscribe to events; returns an unsubscribe function. */
  async subscribe(handler: (e: BatonEvent) => void, opts: { fromSeq?: number; types?: string[]; agentId?: string } = {}): Promise<() => Promise<void>> {
    this.subscribing++
    let subscriptionId: string
    try {
      ;({ subscriptionId } = await this.call("events.subscribe", opts))
    } finally {
      this.subscribing--
    }
    this.eventHandlers.set(subscriptionId, handler)
    const mine = this.early.filter((p) => p.subscriptionId === subscriptionId)
    this.early = this.early.filter((p) => p.subscriptionId !== subscriptionId)
    for (const p of mine) handler(p.event)
    return async () => {
      this.eventHandlers.delete(subscriptionId)
      if (!this.closed) await this.call("events.unsubscribe", { subscriptionId }).catch(() => {})
    }
  }

  /** Async-iterable event stream. */
  async *events(opts: { fromSeq?: number; types?: string[]; agentId?: string } = {}): AsyncGenerator<BatonEvent> {
    const queue: BatonEvent[] = []
    let wake: (() => void) | undefined
    const unsub = await this.subscribe((e) => {
      queue.push(e)
      wake?.()
    }, opts)
    // a closed connection ends the stream instead of leaving the consumer waiting forever
    const offClose = this.onClose(() => wake?.())
    try {
      while (!this.closed) {
        const e = queue.shift()
        if (e) {
          yield e
          continue
        }
        await new Promise<void>((r) => {
          wake = r
        })
        wake = undefined
      }
    } finally {
      offClose()
      await unsub()
    }
  }

  onClose(h: (reason: string) => void): () => void {
    this.closeHandlers.add(h)
    return () => this.closeHandlers.delete(h)
  }

  // ── convenience wrappers ──
  submit(text: string) {
    return this.call("input.submit", { text })
  }
  spawn(p: ControlParams<"agent.spawn">) {
    return this.call("agent.spawn", p)
  }
  prompt(agentId: string, text: string, delivery?: "queue" | "steer" | "interrupt") {
    return this.call("agent.prompt", { agentId, text, delivery })
  }
  interrupt(agentId: string) {
    return this.call("agent.interrupt", { agentId })
  }
  kill(agentId: string) {
    return this.call("agent.kill", { agentId })
  }
  respond(agentId: string, requestId: string, optionId: string | null) {
    return this.call("permission.respond", { agentId, requestId, optionId })
  }
  send(to: string, body: string, opts: { from?: string; delivery?: "queue" | "steer" | "interrupt" } = {}) {
    return this.call("bus.send", { to, body, ...opts })
  }
  shutdown() {
    return this.call("daemon.shutdown", {})
  }

  /** Build a live, self-updating RunState (snapshot + full replay + subscription). */
  async live(): Promise<LiveRun> {
    const run = new LiveRun(this)
    await run.start()
    return run
  }

  /** Close the connection; requests already written (e.g. a final submit) are still sent. */
  close() {
    this.closeAfterFlush = true
    this.flush()
    this.handleClose("client closed")
  }
}

export class LiveRun {
  state = new RunState()
  private listeners = new Set<(e: BatonEvent) => void>()
  private unsub?: () => Promise<void>

  constructor(readonly client: BatonClient) {}

  async start() {
    const snap = await this.client.call("state.snapshot", {})
    this.state.runId = snap.runId
    this.state.projectRoot = snap.projectRoot
    this.state.projectName = snap.projectName
    this.state.branch = snap.branch
    // Replay the whole run so per-agent feeds are complete, then follow live.
    this.unsub = await this.client.subscribe(
      (e) => {
        this.state.apply(e)
        for (const l of this.listeners) l(e)
      },
      { fromSeq: 0 },
    )
    this.state.projectName = snap.projectName
    this.state.branch = snap.branch
  }

  onEvent(l: (e: BatonEvent) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  async stop() {
    await this.unsub?.()
  }
}

/**
 * Is there something to connect to? A socket file (POSIX), or on Windows — where the daemon
 * listens on a named pipe that isn't a file — its pid file with a live process behind it.
 */
export function daemonListening(socketPath: string, projectRoot?: string): boolean {
  if (process.platform !== "win32") return existsSync(socketPath)
  if (!projectRoot) return true
  try {
    const pid = Number(readFileSync(projectPaths(projectRoot).pidFile, "utf8").trim())
    if (!pid) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function tryOpen(socketPath: string, name: string, user?: string): Promise<BatonClient | undefined> {
  // POSIX: no socket file, nothing to try; Windows: just try the pipe
  if (process.platform !== "win32" && !existsSync(socketPath)) return undefined
  try {
    return await BatonClient.open(socketPath, name, user)
  } catch {
    return undefined
  }
}

/** Connect to the project's daemon, starting one if needed. */
export async function connect(opts: ConnectOptions = {}): Promise<BatonClient> {
  const root = findProjectRoot(opts.cwd ?? process.cwd())
  const socketPath = opts.socketPath ?? discoverSocket(root)
  const name = opts.clientName ?? "sdk"
  const existing = await tryOpen(socketPath, name, opts.user)
  if (existing) return existing
  if (opts.autostart === false) throw new Error(`no baton daemon running for ${root}`)
  const cmd = opts.daemonCommand?.(root) ?? defaultDaemonCommand(root)
  const proc = Bun.spawn(cmd, {
    windowsHide: true,
    cwd: root,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: { ...process.env, BATON_DAEMON: "1" },
  })
  proc.unref()
  const deadline = Date.now() + (opts.startTimeoutMs ?? 15_000)
  while (Date.now() < deadline) {
    await Bun.sleep(80)
    const sp = opts.socketPath ?? discoverSocket(root)
    const c = await tryOpen(sp, name, opts.user)
    if (c) return c
    // exited (by code or signal): one last look — another daemon may have won the start race
    if (proc.exitCode !== null || proc.signalCode !== null) {
      await Bun.sleep(150)
      const late = await tryOpen(opts.socketPath ?? discoverSocket(root), name, opts.user)
      if (late) return late
      throw new Error(
        `baton daemon ${proc.signalCode ? `was killed (${proc.signalCode})` : `exited with code ${proc.exitCode}`} (see ${projectPaths(root).log})`,
      )
    }
  }
  throw new Error("timed out waiting for the baton daemon to start")
}

function defaultDaemonCommand(root: string): string[] {
  const bin = Bun.which("baton")
  if (bin) return [bin, "daemon", "--root", root]
  throw new Error("cannot find the `baton` executable to start a daemon; pass daemonCommand")
}
