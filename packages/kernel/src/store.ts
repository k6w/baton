/**
 * Append-only event store (SQLite, WAL). The single source of truth: every projection
 * (agent state, bus, tasks, costs, UI feeds) is a fold over these events, so runs can be
 * resumed after a crash and replayed deterministically.
 */
import { Database } from "bun:sqlite"
import { mkdirSync, renameSync, rmSync } from "node:fs"
import { dirname } from "node:path"
import { type AgentEvent, type BatonEvent, type EventType, matchesType, newId, parseEventData } from "@batonsh/protocol"

export interface AppendOptions {
  agentId?: string
  taskId?: string
  /** Skip zod validation (trusted internal producers on hot paths). */
  trusted?: boolean
  /** Deliver to listeners without storing it (see `BatonEvent.live`). */
  live?: boolean
}

export interface QueryOptions {
  runId?: string
  fromSeq?: number
  toSeq?: number
  types?: string[]
  agentId?: string
  limit?: number
  /** Only the newest `last` matching events (still returned oldest first). */
  last?: number
}

export interface RunRow {
  runId: string
  startedAt: number
  title: string | null
  cwd: string
  lastSeq: number
}

type Listener = (e: BatonEvent) => void

/** `rawOutput` larger than this isn't stored: it repeats what `content` already shows. */
export const MAX_RAW_OUTPUT = 8 * 1024
/** Bump when `compact()` learns something new, so existing logs are compacted again once. */
// 2: also native and ACP agents' output (their "still running" is exitCode: null), and each command keeps its last snapshot
const COMPACT_VERSION = "2"

const SCHEMA = `
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
`
/** Lets a run's events of a few types be read without the rest (summaries, resume). */
const TYPE_INDEX = "CREATE INDEX IF NOT EXISTS events_run_type ON events(run_id, type, seq);"

export class EventStore {
  private db: Database
  private insert: ReturnType<Database["prepare"]>
  private listeners = new Set<Listener>()
  private keepRaw = process.env.BATON_KEEP_RAW === "1"
  private pending: BatonEvent[] = []
  private dispatching = false
  /** Last stored seq: what a live event carries. */
  private stored = 0

  constructor(private readonly path: string = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = this.open()
    this.insert = this.prepareInsert()
    this.stored = this.lastSeq()
  }

  private open(): Database {
    const db = new Database(this.path, { create: true })
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;")
    db.exec(SCHEMA)
    // building this index reads the whole log: an old, big one gets it from compact() instead
    const version = db.query("SELECT v FROM kv WHERE k = 'compact_version'").get() as { v: string } | null
    const empty = !db.query("SELECT 1 FROM events LIMIT 1").get()
    if (empty || version?.v === COMPACT_VERSION) db.exec(TYPE_INDEX)
    if (empty) db.query("INSERT INTO kv (k, v) VALUES ('compact_version', ?) ON CONFLICT(k) DO NOTHING").run(COMPACT_VERSION)
    return db
  }

  private prepareInsert() {
    return this.db.query("INSERT INTO events (id, ts, run_id, agent_id, task_id, type, data, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING seq")
  }

  createRun(cwd: string, title?: string): string {
    const runId = newId("run")
    this.db.query("INSERT INTO runs (run_id, started_at, title, cwd) VALUES (?, ?, ?, ?)").run(runId, Date.now(), title ?? null, cwd)
    return runId
  }

  listRuns(limit = 50): RunRow[] {
    return this.db
      .query(
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
    let seq = this.stored
    if (!opts.live) {
      const row = this.insert.get(id, ts, runId, opts.agentId ?? null, opts.taskId ?? null, ev.type, stored(ev.type, data), raw) as { seq: number }
      seq = this.stored = row.seq
    }
    const out = {
      id,
      seq,
      ts,
      runId,
      agentId: opts.agentId,
      taskId: opts.taskId,
      type: ev.type,
      data,
      ...(raw ? { raw: ev.raw } : {}),
      ...(opts.live ? { live: true } : {}),
    } as BatonEvent
    // Listeners may append events themselves (e.g. the demo director reacting to a turn).
    // Queue nested appends so every listener observes events in seq order.
    this.pending.push(out)
    if (!this.dispatching) {
      this.dispatching = true
      try {
        for (let ev = this.pending.shift(); ev; ev = this.pending.shift()) {
          for (const l of this.listeners) {
            try {
              l(ev)
            } catch {}
          }
        }
      } finally {
        this.dispatching = false
      }
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
    // filter types in SQL so LIMIT counts matching events, not all events; exact types as IN (…)
    // so the (run_id, type, seq) index finds them without reading the rest of the run
    if (opts.types?.length && !opts.types.includes("*")) {
      const exact = opts.types.filter((t) => !t.endsWith(".*"))
      const ors: string[] = []
      if (exact.length) {
        ors.push(`type IN (${exact.map(() => "?").join(", ")})`)
        args.push(...exact)
      }
      for (const t of opts.types) {
        if (!t.endsWith(".*")) continue
        ors.push("substr(type, 1, ?) = ?")
        args.push(t.length - 1, t.slice(0, -1))
      }
      where.push(`(${ors.join(" OR ")})`)
    }
    const filter = where.length ? `WHERE ${where.join(" AND ")}` : ""
    const sql = opts.last
      ? `SELECT * FROM (SELECT * FROM events ${filter} ORDER BY seq DESC LIMIT ${Math.floor(opts.last)}) ORDER BY seq ASC`
      : `SELECT * FROM events ${filter} ORDER BY seq ASC ${opts.limit ? `LIMIT ${Math.floor(opts.limit)}` : ""}`
    // not cached: the SQL varies with the options
    const stmt = this.db.prepare(sql)
    const rows = stmt.all(...args) as {
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
    stmt.finalize()
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

  /** Lines added/removed in a run (the last diff of each file per tool call), without loading the run. */
  diffTotals(runId: string): { added: number; removed: number } {
    const count = (kind: string) => `(SELECT count(*) FROM json_each(c.value, '$.lines') l WHERE json_extract(l.value, '$.kind') = '${kind}')`
    return this.db
      .query(
        `SELECT COALESCE(SUM(added), 0) AS added, COALESCE(SUM(removed), 0) AS removed FROM (
           SELECT json_extract(e.data, '$.toolCallId') AS tc, json_extract(c.value, '$.path') AS path,
                  COALESCE(json_extract(c.value, '$.added'), ${count("add")}) AS added,
                  COALESCE(json_extract(c.value, '$.removed'), ${count("del")}) AS removed,
                  MAX(e.seq)
             FROM events e, json_each(e.data, '$.content') c
            WHERE e.run_id = ? AND e.type = 'tool.update' AND json_extract(c.value, '$.type') = 'diff'
            GROUP BY tc, path)`,
      )
      .get(runId) as { added: number; removed: number }
  }

  lastSeq(): number {
    const r = this.db.query("SELECT MAX(seq) as s FROM events").get() as { s: number | null }
    return r.s ?? 0
  }

  getKV(k: string): string | undefined {
    const r = this.db.query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null
    return r?.v
  }

  setKV(k: string, v: string): void {
    this.db.query("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v)
  }

  /** Bytes the database takes (pages × page size). */
  sizeBytes(): number {
    const n = this.db.query("PRAGMA page_count").get() as { page_count: number }
    const p = this.db.query("PRAGMA page_size").get() as { page_size: number }
    return n.page_count * p.page_size
  }

  /** Whether `compact()` has work to do: the log predates the current compaction rules. */
  needsCompact(): boolean {
    return this.getKV("compact_version") !== COMPACT_VERSION
  }

  /**
   * Shrink a log written by an older version. Before 0.3.7 every chunk of a running command's
   * output was stored with all the output so far (gigabytes for a long run): only the last of
   * those is kept, and only when the command never reported a result. Big `rawOutput` goes too
   * (it repeats `content`). The log is read once and what's kept is written to a fresh file
   * that replaces it, which is much faster than deleting rows from a big one.
   * Run it with no other process using the log (the daemon stopped).
   */
  compact(): { before: number; after: number; removed: number } {
    const before = this.sizeBytes()
    const db = this.db
    // one pass over the tool updates: which are superseded output snapshots
    db.exec(`
      DROP TABLE IF EXISTS temp.tu;
      CREATE TEMP TABLE tu AS
        SELECT seq, run_id, json_extract(data, '$.toolCallId') AS tc,
               (COALESCE(json_extract(data, '$.status'), 'in_progress') = 'in_progress'
                AND json_array_length(data, '$.content') = 1
                AND json_extract(data, '$.content[0].type') = 'terminal'
                AND json_extract(data, '$.content[0].exitCode') IS NULL
                AND json_extract(data, '$.title') IS NULL
                AND json_extract(data, '$.summary') IS NULL) AS progress
          FROM events WHERE type = 'tool.update';
      DROP TABLE IF EXISTS temp.gone;
      CREATE TEMP TABLE gone (seq INTEGER PRIMARY KEY);
      -- every snapshot but the last of each command: its result may not repeat the output
      INSERT INTO temp.gone
        SELECT t.seq FROM temp.tu t
          JOIN (SELECT run_id, tc, MAX(seq) AS last FROM temp.tu WHERE progress GROUP BY run_id, tc) l
            ON l.run_id = t.run_id AND l.tc IS t.tc
         WHERE t.progress AND t.seq < l.last;
      DROP TABLE temp.tu;`)
    const removed = (db.query("SELECT count(*) AS n FROM temp.gone").get() as { n: number }).n
    const slimData = `CASE WHEN type = 'tool.update' AND length(data) > ${MAX_RAW_OUTPUT}
                            AND length(json_extract(data, '$.rawOutput')) > ${MAX_RAW_OUTPUT}
                           THEN json_remove(data, '$.rawOutput') ELSE data END`
    if (this.path === ":memory:") {
      db.transaction(() => {
        db.exec(`DELETE FROM events WHERE seq IN (SELECT seq FROM temp.gone); UPDATE events SET data = ${slimData} WHERE type = 'tool.update';`)
        this.setKV("compact_version", COMPACT_VERSION)
      })()
      db.exec(`DROP TABLE temp.gone; ${TYPE_INDEX}`)
      return { before, after: this.sizeBytes(), removed }
    }
    const fresh = `${this.path}.compact`
    for (const f of [fresh, `${fresh}-journal`]) rmSync(f, { force: true })
    try {
      db.query("ATTACH DATABASE ? AS fresh").run(fresh)
      db.exec("PRAGMA fresh.journal_mode = OFF; PRAGMA fresh.synchronous = OFF;")
      db.exec(SCHEMA.replaceAll("IF NOT EXISTS ", "IF NOT EXISTS fresh."))
      db.exec(`
        INSERT INTO fresh.events (seq, id, ts, run_id, agent_id, task_id, type, data, raw)
          SELECT seq, id, ts, run_id, agent_id, task_id, type, ${slimData}, raw
            FROM main.events WHERE seq NOT IN (SELECT seq FROM temp.gone) ORDER BY seq;
        INSERT INTO fresh.runs SELECT * FROM main.runs;
        INSERT INTO fresh.kv SELECT * FROM main.kv WHERE k <> 'compact_version';
        -- new events continue after the old log's last seq (clients remember seqs)
        DELETE FROM fresh.sqlite_sequence WHERE name = 'events';
        INSERT INTO fresh.sqlite_sequence (name, seq) SELECT name, seq FROM main.sqlite_sequence WHERE name = 'events';`)
      db.query("INSERT INTO fresh.kv (k, v) VALUES ('compact_version', ?)").run(COMPACT_VERSION)
      db.exec(TYPE_INDEX.replace("IF NOT EXISTS ", "IF NOT EXISTS fresh."))
      db.exec("DROP TABLE temp.gone; DETACH DATABASE fresh;")
    } catch (e) {
      try {
        db.exec("DETACH DATABASE fresh")
      } catch {}
      rmSync(fresh, { force: true })
      throw e
    }
    // swap the files (closing checkpointed the WAL into the old log): the old one moves aside
    // until the fresh one has its name, so a failed swap leaves the old log in place
    this.db.close()
    const old = `${this.path}.old`
    try {
      rmSync(old, { force: true })
      renameSync(this.path, old)
      // the old log's WAL must not be replayed into the fresh one
      for (const f of [`${this.path}-wal`, `${this.path}-shm`]) rmSync(f, { force: true })
      try {
        renameSync(fresh, this.path)
      } catch (e) {
        renameSync(old, this.path)
        throw e
      }
      rmSync(old, { force: true })
    } finally {
      this.db = this.open()
      this.insert = this.prepareInsert()
    }
    return { before, after: this.sizeBytes(), removed }
  }

  close(): void {
    this.listeners.clear()
    this.db.close()
  }
}

/** The stored form of an event's data: without a big `rawOutput` (see MAX_RAW_OUTPUT). */
function stored(type: string, data: unknown): string {
  const json = JSON.stringify(data)
  if (type !== "tool.update" || json.length <= MAX_RAW_OUTPUT) return json
  const { rawOutput, ...rest } = data as { rawOutput?: unknown }
  if (rawOutput === undefined || JSON.stringify(rawOutput).length <= MAX_RAW_OUTPUT) return json
  return JSON.stringify(rest)
}
