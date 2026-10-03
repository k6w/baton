/**
 * batond — the per-project daemon. Owns the runtime, the MCP server and the control
 * socket. Clients (TUI, CLI, SDK) come and go; agents keep running.
 */
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BatonConfig, loadConfig, projectPaths, type TrustEntry } from "@batonsh/kernel"
import { ensureA2A, stopA2A } from "./a2a-server.ts"
import { type ControlServer, startControlServer } from "./control.ts"
import { attachDemoDirector } from "./demo.ts"
import { type McpHttpServer, startMcpServer } from "./mcp.ts"
import { loadPlugins } from "./plugins.ts"
import { ensureRemote, stopRemote } from "./remote.ts"
import { attachRemoteNotify } from "./remote-notify.ts"
import { Runtime } from "./runtime.ts"
import { TelemetryExporter } from "./telemetry.ts"

export interface DaemonOptions {
  projectRoot: string
  /** Config overrides (CLI flags). */
  overrides?: Record<string, unknown>
  /** Use an in-memory store (tests). */
  ephemeral?: boolean
  /** Demo mode: mock orchestrator + director. */
  demo?: boolean | { workers?: number; speed?: number }
  /** Explicit socket path (tests). */
  socketPath?: string
  /** Exit the process when the daemon stops (standalone daemon). */
  exitOnStop?: boolean
}

export interface Daemon {
  runtime: Runtime
  socketPath: string
  mcp: McpHttpServer
  control: ControlServer
  stop(): Promise<void>
}

/** Unix socket paths are limited to ~104 bytes on macOS; fall back to tmp for deep projects. */
export function socketPathFor(projectRoot: string): string {
  const p = projectPaths(projectRoot).socket
  if (Buffer.byteLength(p) < 100) return p
  const h = createHash("sha1").update(projectRoot).digest("hex").slice(0, 12)
  return join(tmpdir(), `baton-${h}.sock`)
}

/** Is something answering on this socket? (a live daemon — never steal its socket) */
async function socketAlive(path: string): Promise<boolean> {
  if (!existsSync(path)) return false
  try {
    const s = await Bun.connect({ unix: path, socket: { data() {}, error() {} } })
    s.end()
    return true
  } catch {
    return false
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/**
 * One daemon per project: an O_EXCL lock file (pid inside) guards startup, and a live socket
 * is never unlinked. A lock left by a dead process is taken over.
 */
async function acquireLock(lockPath: string, socketPath: string): Promise<() => void> {
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`
  let held = false
  for (let attempt = 0; attempt < 2 && !held; attempt++) {
    try {
      const fd = openSync(lockPath, "wx")
      writeFileSync(fd, token)
      closeSync(fd)
      held = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      const owner = Number(readFileSync(lockPath, "utf8").split(":")[0])
      if (owner && pidAlive(owner)) throw new Error(`a baton daemon is already running for this project (pid ${owner})`)
      rmSync(lockPath, { force: true })
    }
  }
  if (!held) throw new Error(`could not take the daemon lock ${lockPath}`)
  if (await socketAlive(socketPath)) {
    rmSync(lockPath, { force: true })
    throw new Error(`a baton daemon is already listening on ${socketPath}`)
  }
  return () => {
    try {
      if (readFileSync(lockPath, "utf8").trim() === token) unlinkSync(lockPath)
    } catch {}
  }
}

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const paths = projectPaths(opts.projectRoot)
  const socketPath = opts.socketPath ?? socketPathFor(opts.projectRoot)
  if (!opts.ephemeral) mkdirSync(paths.run, { recursive: true })
  const releaseLock = opts.ephemeral ? () => {} : await acquireLock(join(paths.run, "daemon.lock"), socketPath)
  const loaded = loadConfig({ projectRoot: opts.projectRoot, overrides: opts.overrides })
  const adjust = (c: BatonConfig): BatonConfig => (opts.demo ? demoConfig(c) : c)
  const config: BatonConfig = adjust(loaded.config)
  function demoConfig(config: BatonConfig): BatonConfig {
    return {
      ...config,
      orchestrator: { ...config.orchestrator, enabled: true, agent: "mock", mode: "orchestrator" },
      bus: { ...config.bus, heartbeat_s: Math.min(config.bus.heartbeat_s || 4, 4) },
      // simulated agents don't edit files: skip worktrees in demo mode
      workspace: { ...config.workspace, isolation: "shared" },
    }
  }
  const runtime = new Runtime({ projectRoot: opts.projectRoot, config, storePath: opts.ephemeral ? ":memory:" : paths.state })
  for (const err of loaded.errors) runtime.emit({ type: "log", data: { level: "warn", message: err } })
  await runtime.init()
  // shown in the orchestrator feed (not just the log) so the user knows why a setting has no effect
  function warnUntrusted(list: TrustEntry[]) {
    if (!list.length) return
    const what = list.map((e) => e.path).join(", ")
    runtime.emit({
      type: "orch.note",
      data: {
        level: "warn",
        text: `${list.length} project setting${list.length === 1 ? "" : "s"} held back until you trust this repository (${what}) — run \`baton trust\` to review and allow`,
      },
    })
  }
  warnUntrusted(loaded.untrusted)
  await loadPlugins(runtime, loaded.layers, loaded.untrusted)
  attachRemoteNotify(runtime)
  const telemetry = config.telemetry.otlp_endpoint ? new TelemetryExporter(runtime, config.telemetry.otlp_endpoint) : undefined

  const mcp = startMcpServer(runtime, config.daemon.mcp_port)
  runtime.mcpBaseUrl = mcp.url

  let stopping = false
  const daemon: Daemon = {
    runtime,
    socketPath,
    mcp,
    control: undefined as unknown as ControlServer,
    async stop() {
      if (stopping) return
      stopping = true
      stopDemo?.()
      stopRemote(runtime)
      stopA2A(runtime)
      daemon.control.stop()
      await runtime.close()
      await telemetry?.stop()
      mcp.stop()
      if (!opts.ephemeral) {
        try {
          if (existsSync(paths.pidFile) && readFileSync(paths.pidFile, "utf8").trim() === String(process.pid)) unlinkSync(paths.pidFile)
        } catch {}
      }
      releaseLock()
      if (opts.exitOnStop) process.exit(0)
    },
  }
  // daemon.persist = false: stop once the last client has been gone for a grace period
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  daemon.control = startControlServer(runtime, socketPath, {
    onShutdown: () => void daemon.stop(),
    reloadConfig: () => {
      const fresh = loadConfig({ projectRoot: opts.projectRoot, overrides: opts.overrides })
      for (const err of fresh.errors) runtime.emit({ type: "log", data: { level: "warn", message: err } })
      // a half-typed config file must not reset everything to defaults: keep the running config
      if (fresh.failed.length) return { errors: [...fresh.errors, "config not reloaded — fix the file above (the previous settings stay active)"] }
      runtime.applyConfig(adjust(fresh.config))
      warnUntrusted(fresh.untrusted)
      return { errors: fresh.errors }
    },
    onClientsChanged: (n) => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
      if (n === 0 && !runtime.config.daemon.persist && !opts.ephemeral) idleTimer = setTimeout(() => void daemon.stop(), 5000)
    },
  })
  if (!opts.ephemeral) {
    writeFileSync(paths.pidFile, String(process.pid))
    if (socketPath !== paths.socket) writeFileSync(join(paths.run, "socket-path"), socketPath)
  }

  const stopDemo = opts.demo ? attachDemoDirector(runtime, typeof opts.demo === "object" ? opts.demo : {}) : undefined

  if (config.a2a.autostart && !opts.ephemeral) {
    try {
      ensureA2A(runtime)
    } catch (e) {
      runtime.emit({ type: "log", data: { level: "warn", message: `A2A endpoint: ${e instanceof Error ? e.message : e}` } })
    }
  }
  if (config.remote.autostart && !opts.ephemeral) {
    try {
      ensureRemote(runtime)
    } catch (e) {
      runtime.emit({ type: "log", data: { level: "warn", message: `web view: ${e instanceof Error ? e.message : e}` } })
    }
  }

  // autostart configured agents
  for (const [name, a] of Object.entries(config.agents)) {
    for (let i = 0; i < a.autostart; i++) {
      runtime
        .spawn({ adapter: name, label: a.label })
        .catch((e) => runtime.emit({ type: "log", data: { level: "error", message: `autostart ${name}: ${e.message}` } }))
    }
  }
  return daemon
}

/** Entry for `baton daemon` (detached background process). */
export async function runDaemonProcess(projectRoot: string, opts: Omit<DaemonOptions, "projectRoot" | "exitOnStop"> = {}): Promise<void> {
  const d = await startDaemon({ ...opts, projectRoot, exitOnStop: true })
  const stop = () => void d.stop()
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
  process.on("SIGHUP", stop)
}
