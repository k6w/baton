/**
 * Control server: newline-delimited JSON-RPC over a Unix domain socket. Every client (TUI,
 * CLI, SDK) speaks this; there are no private back doors.
 */
import { existsSync, unlinkSync } from "node:fs"
import type { Socket } from "bun"
import {
  CONTROL_PROTOCOL_VERSION,
  type ControlMethod,
  type ControlParams,
  type ControlResult,
  JsonRpcError,
  JsonRpcPeer,
  matchesType,
  newId,
} from "@batonsh/protocol"
import { handleInput } from "./input.ts"
import type { Runtime } from "./runtime.ts"

export const DAEMON_VERSION = "0.1.0"

interface Conn {
  peer: JsonRpcPeer
  buf: string
  decoder: TextDecoder
  subs: Map<string, { types?: string[]; agentId?: string }>
  unsubscribe: () => void
  pending: Uint8Array[]
  socket: Socket<Conn>
}

export interface ControlServer {
  path: string
  stop(): void
  clients(): number
}

type Handler<M extends ControlMethod> = (params: ControlParams<M>, conn: Conn) => Promise<ControlResult<M>> | ControlResult<M>

export function startControlServer(rt: Runtime, socketPath: string, hooks: { onShutdown: () => void; onClientsChanged?: (n: number) => void }): ControlServer {
  if (existsSync(socketPath)) unlinkSync(socketPath)
  const conns = new Set<Conn>()

  const handlers: { [M in ControlMethod]: Handler<M> } = {
    hello: () => ({ daemonVersion: DAEMON_VERSION, protocol: CONTROL_PROTOCOL_VERSION, runId: rt.runId, projectRoot: rt.projectRoot, pid: process.pid }),
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
    "events.query": (p) => ({ events: rt.store.query({ runId: rt.runId, ...p }) }),
    "input.submit": (p) => handleInput(rt, p.text),
    "agent.spawn": (p) => rt.spawn(p),
    "agent.prompt": async (p) => {
      await rt.promptAgent(p.agentId, p.text, { from: p.from ?? "user", delivery: p.delivery })
      return { ok: true }
    },
    "agent.interrupt": async (p) => {
      await rt.interrupt(p.agentId)
      return { ok: true }
    },
    "agent.kill": async (p) => {
      await rt.kill(p.agentId)
      return { ok: true }
    },
    "agent.rename": (p) => {
      rt.rename(p.agentId, p.name, p.label)
      return { ok: true }
    },
    "agents.detect": async (p) => ({ adapters: await rt.registry.detectAll(p?.refresh) }),
    "bus.send": (p) => ({ messageId: rt.send({ from: p.from ?? "user", to: p.to, body: p.body, kind: p.kind, delivery: p.delivery }) }),
    "permission.respond": async (p) => {
      await rt.resolvePermission(p.agentId, p.requestId, p.optionId, "user")
      return { ok: true }
    },
    "run.mode": (p) => {
      rt.setMode(p.mode)
      return { ok: true }
    },
    "config.get": () => ({ config: rt.config }),
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
            try {
              return await (h as Handler<ControlMethod>)(params as never, conn)
            } catch (e) {
              if (e instanceof JsonRpcError) throw e
              throw new JsonRpcError(-32000, e instanceof Error ? e.message : String(e))
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
