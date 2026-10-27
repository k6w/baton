/**
 * Control server: newline-delimited JSON-RPC over a Unix domain socket. Every client (TUI,
 * CLI, SDK) speaks this; there are no private back doors.
 */

import { existsSync, unlinkSync } from "node:fs"
import net from "node:net"
import {
  BATON_VERSION,
  CONTROL_PROTOCOL_VERSION,
  ControlErrorCode,
  type ControlErrorKind,
  type ControlMethod,
  type ControlParams,
  type ControlResult,
  classifyError,
  ipcPath,
  JsonRpcError,
  JsonRpcPeer,
  matchesType,
  newId,
  REQUIRED_PARAMS,
} from "@batonsh/protocol"
import { ensureA2A, stopA2A } from "./a2a-server.ts"
import { exportRun, listRunSummaries, resumeRun } from "./history.ts"
import { handleInput } from "./input.ts"
import { listRecipes } from "./recipes.ts"
import { ensureRemote, qrLines, stopRemote } from "./remote.ts"
import type { Runtime } from "./runtime.ts"
import { getScorecards, pickForTask } from "./scores.ts"

export const DAEMON_VERSION = BATON_VERSION

/** What a connection needs from its socket: Bun's Socket, or a node:net wrapper on Windows. */
interface ConnSocket {
  /** Bytes accepted (fewer than given = wait for drain / retry). */
  write(b: Uint8Array): number
  end(): void
  /** Bytes the socket itself still holds (node:net queues writes rather than refusing them). */
  queued?(): number
}

interface Conn {
  peer: JsonRpcPeer
  buf: string
  decoder: TextDecoder
  subs: Map<string, { types?: string[]; agentId?: string }>
  unsubscribe: () => void
  pending: Uint8Array[]
  /** Bytes waiting in `pending`. */
  pendingBytes: number
  socket: ConnSocket
  /** Retry timer for a short write (see flush). */
  retry?: ReturnType<typeof setTimeout>
  closed?: boolean
  id: string
  /** From hello: who is behind this connection. */
  user?: string
  client?: string
}

export interface ControlServer {
  path: string
  stop(): void
  clients(): number
}

type Handler<M extends ControlMethod> = (params: ControlParams<M>, conn: Conn) => Promise<ControlResult<M>> | ControlResult<M>

export function startControlServer(
  rt: Runtime,
  socketPath: string,
  hooks: { onShutdown: () => void; onClientsChanged?: (n: number) => void; reloadConfig?: () => { errors: string[] } },
): ControlServer {
  // a stale socket file (POSIX); Windows named pipes vanish with their server
  if (process.platform !== "win32" && existsSync(socketPath)) unlinkSync(socketPath)
  const conns = new Set<Conn>()

  const helloResult = () => ({
    daemonVersion: DAEMON_VERSION,
    protocol: CONTROL_PROTOCOL_VERSION,
    runId: rt.runId,
    projectRoot: rt.projectRoot,
    pid: process.pid,
  })
  const handlers: { [M in ControlMethod]: Handler<M> } = {
    hello: (p, conn) => {
      conn.user = p.user?.trim() || undefined
      conn.client = p.client
      // humans (tui, web, cli) are viewers; agents' and scripts' connections aren't shown
      if (conn.user && p.client !== "mcp") rt.joinViewer(conn.id, conn.user, p.client)
      return helloResult()
    },
    "state.snapshot": () => rt.state.snapshot(),
    "events.subscribe": (p, conn) => {
      const subscriptionId = newId("sub")
      conn.subs.set(subscriptionId, { types: p.types, agentId: p.agentId })
      // replay backlog first so the client never misses events between snapshot and subscribe
      if (p.fromSeq !== undefined) {
        for (const e of rt.store.query({ runId: rt.runId, fromSeq: p.fromSeq, types: p.types, agentId: p.agentId })) {
          conn.peer.notify("event", { subscriptionId, event: e })
        }
      }
      return { subscriptionId, lastSeq: rt.state.lastSeq }
    },
    "events.unsubscribe": (p, conn) => {
      conn.subs.delete(p.subscriptionId)
      return { ok: true }
    },
    "events.query": (p) => ({ events: rt.store.query({ ...p, runId: p.runId ?? rt.runId }) }),
    "input.submit": (p, conn) => handleInput(rt, p.text, { who: conn.user }),
    "agent.spawn": (p) => rt.spawn(p),
    "agent.prompt": async (p) => {
      await rt.promptAgent(p.agentId, p.text, { from: p.from ?? "user", delivery: p.delivery })
      return { ok: true }
    },
    "agent.interrupt": async (p) => {
      if (!rt.agents.has(p.agentId)) throw new Error(`no agent ${p.agentId}`)
      await rt.interrupt(p.agentId)
      return { ok: true }
    },
    "agent.kill": async (p) => {
      if (!rt.agents.has(p.agentId)) throw new Error(`no agent ${p.agentId}`)
      await rt.kill(p.agentId)
      return { ok: true }
    },
    "agent.rename": (p) => {
      rt.rename(p.agentId, p.name, p.label)
      return { ok: true }
    },
    "agents.detect": async (p) => ({ adapters: await rt.registry.detectAll(p?.refresh) }),
    "agents.models": async (p) => ({ models: await rt.registry.models(rt.config.agents[p.adapter]?.adapter ?? p.adapter) }),
    "bus.send": (p) => ({ messageId: rt.send({ from: p.from ?? "user", to: p.to, body: p.body, kind: p.kind, delivery: p.delivery }) }),
    "permission.respond": async (p, conn) => {
      await rt.resolvePermission(p.agentId, p.requestId, p.optionId, "user", conn.user)
      return { ok: true }
    },
    "run.mode": (p) => {
      rt.setMode(p.mode)
      return { ok: true }
    },
    "run.autonomy": (p) => rt.setAutonomy(p.mode),
    "config.get": () => ({ config: rt.config }),
    "remote.start": (p) => {
      const s = ensureRemote(rt, p ?? {})
      return {
        url: s.url,
        openUrl: s.openUrl,
        lanUrls: s.lanUrls,
        lan: s.lan,
        qr: qrLines(s.openUrl),
        tls: s.tls,
        fingerprint: s.fingerprint,
        publicUrl: s.publicUrl,
      }
    },
    "scorecards.get": () => ({ rows: getScorecards(rt) }),
    "a2a.start": (p) => {
      const s = ensureA2A(rt, p ?? {})
      return { url: s.url, port: s.port, token: s.token }
    },
    "a2a.stop": () => {
      stopA2A(rt)
      return { ok: true }
    },
    "agents.pick": (p) => pickForTask(rt, p.task, p.candidates),
    "remote.stop": () => {
      stopRemote(rt)
      return { ok: true }
    },
    "config.reload": () => hooks.reloadConfig?.() ?? { errors: ["reload not supported"] },
    "workspace.merge": async (p) => {
      const r = await rt.collab.merge(p.agentId)
      return { status: r.status, files: (r.conflicts ?? r.files.map((f) => f.path)) as string[], detail: r.detail }
    },
    "workspace.sync": (p) => rt.collab.sync(p.agentId),
    "workspace.diff": async (p) => ({ patch: await rt.collab.diff(p.agentId, p.paths ?? []) }),
    "review.request": async (p) => ({ reviewer: (await rt.collab.requestReview(p.agentId, { reviewer: p.reviewer })).reviewer }),
    "plan.decide": (p) => ({ ok: rt.collab.decidePlan(p.approved, p.notes) }),
    "task.edit": (p) => {
      if (!rt.state.tasks.has(p.taskId)) throw new Error(`no task ${p.taskId}`)
      const { taskId, title, description, acceptance, deps, agent } = p
      if (title || description || acceptance !== undefined || deps || agent !== undefined)
        rt.emit({ type: "task.updated", data: { taskId, title, description, acceptance, deps, agent } })
      if (p.move) {
        // swap places with the neighbour, renumbering the whole plan so orders stay dense
        const list = rt.state.orderedTasks()
        const i = list.findIndex((t) => t.taskId === taskId)
        const j = p.move === "up" ? i - 1 : i + 1
        if (i >= 0 && j >= 0 && j < list.length) {
          ;[list[i], list[j]] = [list[j]!, list[i]!]
          list.forEach((t, k) => {
            if (t.order !== k) rt.emit({ type: "task.updated", data: { taskId: t.taskId, order: k } })
          })
        }
      }
      if (p.cancel) rt.emit({ type: "task.state", data: { taskId, state: "canceled", note: "removed by the user" } })
      return { ok: true }
    },
    "task.add": (p) => {
      let n = rt.state.tasks.size + 1
      while (rt.state.tasks.has(`t${n}`)) n++
      const taskId = `t${n}`
      rt.emit({ type: "task.created", data: { taskId, title: p.title, description: p.description, deps: p.deps ?? [], acceptance: p.acceptance } })
      if (p.agent) rt.emit({ type: "task.updated", data: { taskId, agent: p.agent } })
      return { taskId }
    },
    "runs.list": (p) => ({ runs: listRunSummaries(rt, p?.limit ?? 30) }),
    "run.export": (p) => ({ text: exportRun(rt, p.runId, p.format) }),
    "run.resume": async (p) => ({ agents: await resumeRun(rt, p.runId) }),
    "recipes.list": () => ({
      recipes: listRecipes(rt.projectRoot).map(({ template, ...r }) => ({
        ...r,
        steps: template
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => /^\d+\./.test(l)),
      })),
    }),
    "daemon.shutdown": () => {
      setTimeout(hooks.onShutdown, 10)
      return { ok: true }
    },
  }

  const encoder = new TextEncoder()
  const MAX_PENDING_BYTES = 256 * 1024 * 1024
  /** Behind by this much: live output is skipped for the client. */
  const LAGGING_BYTES = 1024 * 1024
  const backlog = (conn: Conn) => conn.pendingBytes + (conn.socket.queued?.() ?? 0)
  const TRACE = process.env.BATON_TRACE_IPC === "1"
  // socket.write returns *bytes* written; keep the queue as bytes so partial writes of
  // multi-byte UTF-8 never corrupt the stream.
  // A short write waits for `drain`, and a timer retries too: Windows named pipes don't always
  // report drain, and a stalled queue would freeze the client.
  const flush = (conn: Conn) => {
    while (conn.pending.length) {
      const chunk = conn.pending[0] as Uint8Array
      const written = conn.socket.write(chunk)
      conn.pendingBytes -= Math.max(0, Math.min(written, chunk.byteLength))
      if (written >= chunk.byteLength) conn.pending.shift()
      else {
        conn.pending[0] = chunk.subarray(Math.max(0, written))
        if (!conn.retry)
          conn.retry = setTimeout(() => {
            conn.retry = undefined
            if (!conn.closed) flush(conn)
          }, 10)
        return
      }
    }
  }

  // the connection handlers, shared by both transports below
  const onOpen = (socket: ConnSocket): Conn => {
    const conn: Conn = {
      id: newId("conn"),
      buf: "",
      decoder: new TextDecoder(),
      subs: new Map(),
      pending: [],
      pendingBytes: 0,
      socket,
      unsubscribe: () => {},
      peer: new JsonRpcPeer((msg) => {
        if (TRACE && !(msg as { method?: string }).method?.startsWith("event"))
          console.error(`[ipc ${Date.now() % 100000}] -> ${JSON.stringify(msg).slice(0, 160)}`)
        if (conn.closed) return
        const bytes = encoder.encode(`${JSON.stringify(msg)}\n`)
        conn.pending.push(bytes)
        conn.pendingBytes += bytes.byteLength
        // a client that stopped reading would hold everything since in memory: drop it (it reconnects and resyncs)
        if (backlog(conn) > MAX_PENDING_BYTES) {
          conn.pending = []
          conn.pendingBytes = 0
          conn.socket.end()
          return
        }
        flush(conn)
      }),
    }
    for (const [method, h] of Object.entries(handlers)) {
      conn.peer.onRequest(method, async (params) => {
        const fail = (kind: ControlErrorKind, message: string): never => {
          throw new JsonRpcError(ControlErrorCode[kind], message, { kind })
        }
        // validate before the handler sees anything
        const p = (params ?? {}) as Record<string, unknown>
        if (typeof p !== "object" || Array.isArray(p)) fail("InvalidParams", `${method}: params must be an object`)
        const missing = (REQUIRED_PARAMS[method] ?? []).filter((k) => p[k] === undefined || p[k] === null || p[k] === "")
        if (missing.length) fail("InvalidParams", `${method}: missing ${missing.join(", ")}`)
        if (method === "hello" && typeof p.version === "number" && p.version > CONTROL_PROTOCOL_VERSION)
          fail(
            "VersionMismatch",
            `this client speaks protocol ${p.version}, the daemon ${CONTROL_PROTOCOL_VERSION} — restart the daemon (baton stop) to upgrade it`,
          )
        try {
          return await (h as Handler<ControlMethod>)(params as never, conn)
        } catch (e) {
          if (e instanceof JsonRpcError) throw e
          const message = e instanceof Error ? e.message : String(e)
          const kind = classifyError(message)
          throw new JsonRpcError(ControlErrorCode[kind], message, { kind })
        }
      })
    }
    conn.unsubscribe = rt.store.subscribe((event) => {
      // live output is superseded by the next chunk: a client that's behind doesn't need it
      if (event.live && backlog(conn) > LAGGING_BYTES) return
      for (const [subscriptionId, f] of conn.subs) {
        if (f.agentId && event.agentId !== f.agentId) continue
        if (!matchesType(event.type, f.types)) continue
        conn.peer.notify("event", { subscriptionId, event })
      }
    })
    conns.add(conn)
    hooks.onClientsChanged?.(conns.size)
    return conn
  }
  const onData = (conn: Conn, chunk: Uint8Array) => {
    conn.buf += conn.decoder.decode(chunk, { stream: true })
    let nl = conn.buf.indexOf("\n")
    while (nl >= 0) {
      const line = conn.buf.slice(0, nl)
      conn.buf = conn.buf.slice(nl + 1)
      if (line.trim()) {
        if (TRACE) console.error(`[ipc ${Date.now() % 100000}] <- ${line.slice(0, 160)}`)
        try {
          void conn.peer.handle(JSON.parse(line))
        } catch {}
      }
      nl = conn.buf.indexOf("\n")
    }
  }
  const onClose = (conn: Conn) => {
    if (conn.closed) return
    conn.closed = true
    if (conn.retry) clearTimeout(conn.retry)
    conn.unsubscribe()
    conn.peer.close()
    conns.delete(conn)
    rt.leaveViewer(conn.id)
    hooks.onClientsChanged?.(conns.size)
  }

  let stopListener: () => void
  if (process.platform === "win32") {
    // Windows: node:net on a named pipe. It queues writes itself (Bun's sockets stall on busy pipes).
    const server = net.createServer((s) => {
      const conn = onOpen({
        write: (b) => {
          s.write(b)
          return b.byteLength
        },
        end: () => s.end(),
        queued: () => s.writableLength,
      })
      s.on("data", (b: Buffer) => onData(conn, b))
      s.on("close", () => onClose(conn))
      s.on("error", () => onClose(conn))
    })
    server.listen(ipcPath(socketPath))
    stopListener = () => {
      server.close()
      for (const c of conns) c.socket.end()
    }
  } else {
    const listener = Bun.listen<Conn>({
      unix: socketPath,
      socket: {
        open(socket) {
          socket.data = onOpen(socket)
        },
        data(socket, chunk) {
          onData(socket.data, chunk)
        },
        drain(socket) {
          flush(socket.data)
        },
        close(socket) {
          if (socket.data) onClose(socket.data)
        },
        error(socket) {
          socket.data?.unsubscribe()
        },
      },
    })
    stopListener = () => listener.stop(true)
  }

  return {
    path: socketPath,
    clients: () => conns.size,
    stop() {
      for (const c of conns) c.peer.notify("daemon.closing", { reason: "shutdown" })
      stopListener()
      if (process.platform !== "win32" && existsSync(socketPath)) unlinkSync(socketPath)
    },
  }
}
