/**
 * Control server: newline-delimited JSON-RPC over a Unix domain socket. Every client (TUI,
 * CLI, SDK) speaks this; there are no private back doors.
 */
import { existsSync, unlinkSync } from "node:fs"
import {
  BATON_VERSION,
  CONTROL_PROTOCOL_VERSION,
  ControlErrorCode,
  type ControlErrorKind,
  type ControlMethod,
  type ControlParams,
  type ControlResult,
  classifyError,
  JsonRpcError,
  JsonRpcPeer,
  matchesType,
  newId,
  REQUIRED_PARAMS,
} from "@batonsh/protocol"
import type { Socket } from "bun"
import { ensureA2A, stopA2A } from "./a2a-server.ts"
import { exportRun, listRunSummaries, resumeRun } from "./history.ts"
import { handleInput } from "./input.ts"
import { listRecipes } from "./recipes.ts"
import { ensureRemote, qrLines, stopRemote } from "./remote.ts"
import type { Runtime } from "./runtime.ts"
import { getScorecards, pickForTask } from "./scores.ts"

export const DAEMON_VERSION = BATON_VERSION

interface Conn {
  peer: JsonRpcPeer
  buf: string
  decoder: TextDecoder
  subs: Map<string, { types?: string[]; agentId?: string }>
  unsubscribe: () => void
  pending: Uint8Array[]
  socket: Socket<Conn>
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
  if (existsSync(socketPath)) unlinkSync(socketPath)
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
  // socket.write returns *bytes* written; keep the queue as bytes so partial writes of
  // multi-byte UTF-8 never corrupt the stream.
  const flush = (conn: Conn) => {
    while (conn.pending.length) {
      const chunk = conn.pending[0] as Uint8Array
      const written = conn.socket.write(chunk)
      if (written >= chunk.byteLength) conn.pending.shift()
      else {
        conn.pending[0] = chunk.subarray(Math.max(0, written))
        return
      }
    }
  }

  const listener = Bun.listen<Conn>({
    unix: socketPath,
    socket: {
      open(socket) {
        const conn: Conn = {
          id: newId("conn"),
          buf: "",
          decoder: new TextDecoder(),
          subs: new Map(),
          pending: [],
          socket,
          unsubscribe: () => {},
          peer: new JsonRpcPeer((msg) => {
            conn.pending.push(encoder.encode(`${JSON.stringify(msg)}\n`))
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
          for (const [subscriptionId, f] of conn.subs) {
            if (f.agentId && event.agentId !== f.agentId) continue
            if (!matchesType(event.type, f.types)) continue
            conn.peer.notify("event", { subscriptionId, event })
          }
        })
        socket.data = conn
        conns.add(conn)
        hooks.onClientsChanged?.(conns.size)
      },
      data(socket, chunk) {
        const conn = socket.data
        conn.buf += conn.decoder.decode(chunk, { stream: true })
        let nl = conn.buf.indexOf("\n")
        while (nl >= 0) {
          const line = conn.buf.slice(0, nl)
          conn.buf = conn.buf.slice(nl + 1)
          if (line.trim()) {
            try {
              void conn.peer.handle(JSON.parse(line))
            } catch {}
          }
          nl = conn.buf.indexOf("\n")
        }
      },
      drain(socket) {
        flush(socket.data)
      },
      close(socket) {
        const conn = socket.data
        if (!conn) return
        conn.unsubscribe()
        conn.peer.close()
        conns.delete(conn)
        rt.leaveViewer(conn.id)
        hooks.onClientsChanged?.(conns.size)
      },
      error(socket) {
        socket.data?.unsubscribe()
      },
    },
  })

  return {
    path: socketPath,
    clients: () => conns.size,
    stop() {
      for (const c of conns) c.peer.notify("daemon.closing", { reason: "shutdown" })
      listener.stop(true)
      if (existsSync(socketPath)) unlinkSync(socketPath)
    },
  }
}
