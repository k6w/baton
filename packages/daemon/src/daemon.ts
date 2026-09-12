/**
 * batond — the per-project daemon. Owns the runtime, the MCP server and the control
 * socket. Clients (TUI, CLI, SDK) come and go; agents keep running.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BatonConfig, loadConfig, projectPaths } from "@batonsh/kernel"
import { type ControlServer, startControlServer } from "./control.ts"
import { attachDemoDirector } from "./demo.ts"
import { type McpHttpServer, startMcpServer } from "./mcp.ts"
import { loadPlugins } from "./plugins.ts"
import { Runtime } from "./runtime.ts"

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

export async function startDaemon(opts: DaemonOptions): Promise<Daemon> {
  const paths = projectPaths(opts.projectRoot)
  const loaded = loadConfig({ projectRoot: opts.projectRoot, overrides: opts.overrides })
  let config: BatonConfig = loaded.config
  if (opts.demo) {
    config = {
      ...config,
      orchestrator: { ...config.orchestrator, enabled: true, agent: "mock", mode: "orchestrator" },
      bus: { ...config.bus, heartbeat_s: Math.min(config.bus.heartbeat_s || 4, 4) },
    }
  }
  if (!opts.ephemeral) mkdirSync(paths.run, { recursive: true })
  const runtime = new Runtime({ projectRoot: opts.projectRoot, config, storePath: opts.ephemeral ? ":memory:" : paths.state })
  for (const err of loaded.errors) runtime.emit({ type: "log", data: { level: "warn", message: err } })
  await runtime.init()
  await loadPlugins(runtime, loaded.layers)

  const mcp = startMcpServer(runtime, config.daemon.mcp_port)
  runtime.mcpBaseUrl = mcp.url

  const socketPath = opts.socketPath ?? socketPathFor(opts.projectRoot)
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
      daemon.control.stop()
      await runtime.close()
      mcp.stop()
      if (!opts.ephemeral) {
        try {
          if (existsSync(paths.pidFile) && readFileSync(paths.pidFile, "utf8").trim() === String(process.pid)) unlinkSync(paths.pidFile)
        } catch {}
      }
      if (opts.exitOnStop) process.exit(0)
    },
  }
  // daemon.persist = false: stop once the last client has been gone for a grace period
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  daemon.control = startControlServer(runtime, socketPath, {
    onShutdown: () => void daemon.stop(),
    onClientsChanged: (n) => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
      if (n === 0 && !config.daemon.persist && !opts.ephemeral) idleTimer = setTimeout(() => void daemon.stop(), 5000)
    },
  })
  if (!opts.ephemeral) {
    writeFileSync(paths.pidFile, String(process.pid))
    if (socketPath !== paths.socket) writeFileSync(join(paths.run, "socket-path"), socketPath)
  }

  const stopDemo = opts.demo ? attachDemoDirector(runtime, typeof opts.demo === "object" ? opts.demo : {}) : undefined

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
