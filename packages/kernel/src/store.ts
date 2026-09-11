/**
 * Append-only event store (SQLite, WAL). The single source of truth: every projection
 * (agent state, bus, tasks, costs, UI feeds) is a fold over these events, so runs can be
 * resumed after a crash and replayed deterministically.
 */
import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { type AgentEvent, type BatonEvent, type EventType, matchesType, newId, parseEventData } from "@batonsh/protocol"

export interface AppendOptions {
  agentId?: string
  taskId?: string
  /** Skip zod validation (trusted internal producers on hot paths). */
  trusted?: boolean
}

export interface QueryOptions {
  runId?: string
  fromSeq?: number
  toSeq?: number
  types?: string[]
  agentId?: string
  limit?: number
}

export interface RunRow {
  runId: string
  startedAt: number
  title: string | null
  cwd: string
  lastSeq: number
}

type Listener = (e: BatonEvent) => void

export class EventStore {
  private db: Database
  private insert: ReturnType<Database["prepare"]>
  private listeners = new Set<Listener>()
  private keepRaw = process.env.BATON_KEEP_RAW === "1"

  constructor(path: string = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq      INTEGER PRIMARY KEY AUTOINCREMENT,
        id       TEXT NOT NULL,
        ts       INTEGER NOT NULL,
        run_id   TEXT NOT NULL,
        agent_id TEXT,
        task_id  TEXT,
        type     TEXT NOT NULL,
        data     TEXT NOT NULL,
        raw      TEXT
      );
      CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
      CREATE INDEX IF NOT EXISTS events_agent ON events(agent_id, seq);
      CREATE TABLE IF NOT EXISTS runs (
        run_id     TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        title      TEXT,
        cwd        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `)
    this.insert = this.db.prepare("INSERT INTO events (id, ts, run_id, agent_id, task_id, type, data, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq")
  }

  createRun(cwd: string, title?: string): string {
    const runId = newId("run")
    this.db.prepare("INSERT INTO runs (run_id, started_at, title, cwd) VALUES (?, ?, ?, ?)").run(runId, Date.now(), title ?? null, cwd)
    return runId
  }

  listRuns(limit = 50): RunRow[] {
    return this.db
      .prepare(
        `SELECT r.run_id as runId, r.started_at as startedAt, r.title, r.cwd,
                COALESCE((SELECT MAX(seq) FROM events e WHERE e.run_id = r.run_id), 0) as lastSeq
           FROM runs r ORDER BY r.started_at DESC LIMIT ?`,
      )
      .all(limit) as RunRow[]
  }

  append(runId: string, ev: AgentEvent, opts: AppendOptions = {}): BatonEvent {
    const data = opts.trusted ? (ev.data as never) : parseEventData(ev.type, ev.data)
    const id = newId("ev")
    const ts = Date.now()
    const raw = this.keepRaw && ev.raw !== undefined ? JSON.stringify(ev.raw) : null
    const row = this.insert.get(id, ts, runId, opts.agentId ?? null, opts.taskId ?? null, ev.type, JSON.stringify(data), raw) as { seq: number }
    const out = {
      id,
      seq: row.seq,
      ts,
      runId,
      agentId: opts.agentId,
      taskId: opts.taskId,
      type: ev.type,
      data,
      ...(raw ? { raw: ev.raw } : {}),
    } as BatonEvent
    for (const l of this.listeners) {
      try {
        l(out)
      } catch {}
    }
    return out
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  query(opts: QueryOptions = {}): BatonEvent[] {
    const where: string[] = []
    const args: (string | number)[] = []
    if (opts.runId) {
      where.push("run_id = ?")
      args.push(opts.runId)
    }
    if (opts.fromSeq !== undefined) {
      where.push("seq > ?")
      args.push(opts.fromSeq)
    }
    if (opts.toSeq !== undefined) {
      where.push("seq <= ?")
      args.push(opts.toSeq)
    }
    if (opts.agentId) {
      where.push("agent_id = ?")
      args.push(opts.agentId)
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq ASC ${opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : ""}`
    const rows = this.db.prepare(sql).all(...args) as {
      seq: number
      id: string
      ts: number
      run_id: string
      agent_id: string | null
      task_id: string | null
      type: EventType
      data: string
      raw: string | null
    }[]
    const out: BatonEvent[] = []
    for (const r of rows) {
      if (!matchesType(r.type, opts.types)) continue
      out.push({
        id: r.id,
        seq: r.seq,
        ts: r.ts,
        runId: r.run_id,
        agentId: r.agent_id ?? undefined,
        taskId: r.task_id ?? undefined,
        type: r.type,
        data: JSON.parse(r.data),
        ...(r.raw ? { raw: JSON.parse(r.raw) } : {}),
      } as BatonEvent)
    }
    return out
  }

  lastSeq(): number {
    const r = this.db.prepare("SELECT MAX(seq) as s FROM events").get() as { s: number | null }
    return r.s ?? 0
  }

  getKV(k: string): string | undefined {
    const r = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null
    return r?.v
  }

  setKV(k: string, v: string): void {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v)
  }

  close(): void {
    this.listeners.clear()
    this.db.close()
  }
}
