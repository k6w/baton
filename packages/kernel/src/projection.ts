/**
 * Projections: fold BEP events into the live run state (agents, bus, tasks, approvals,
 * totals) and per-agent activity feeds. The daemon and every client run the same reducer,
 * so a client that replays the event log sees exactly what the daemon sees.
 */
import type { AgentView, BatonEvent, BusMessageView, DiffHunkLine, PendingApproval, Snapshot, TaskView, ToolKind, ToolStatus } from "@batonsh/protocol"

export type FeedItem =
  | { kind: "message"; id: string; role: "assistant" | "thought"; text: string; done: boolean; ts: number }
  | { kind: "user"; id: string; text: string; from?: string; ts: number }
  | {
      kind: "tool"
      id: string
      toolKind: ToolKind
      name: string
      title: string
      status: ToolStatus
      summary?: string
      parentId?: string
      input?: unknown
      diffs: { path: string; lines: DiffHunkLine[]; added: number; removed: number }[]
      output?: string
      exitCode?: number | null
      ts: number
    }
  | { kind: "bus"; id: string; from: string; to: string; body: string; direction: "in" | "out"; ts: number }
  | { kind: "permission"; id: string; title: string; resolved?: string; ts: number }
  | { kind: "error"; id: string; text: string; ts: number }
  | { kind: "note"; id: string; text: string; ts: number }

export interface WorkspaceView {
  mode: "worktree" | "shared"
  path: string
  branch?: string
  files: { path: string; added: number; removed: number }[]
  added: number
  removed: number
  merge?: { status: "queued" | "verifying" | "merged" | "failed" | "conflict" | "undone"; detail?: string; files?: string[]; ts: number }
  conflicts: { with: string; files: string[]; kind: "merge" | "lease" }[]
  review?: { status: "requested" | "approve" | "changes_requested"; reviewer: string; notes?: string }
  leases: { leaseId: string; globs: string[]; exclusive: boolean }[]
  port?: number
}

export interface AgentFeed {
  items: FeedItem[]
  index: Map<string, FeedItem>
}

const MAX_FEED = 400
/** An agent that's gone keeps only its latest items (its card and history). */
const MAX_FEED_EXITED = 100
const MAX_BUS = 1000
/** Tool output kept per feed item (the tail): the screen shows a few lines of it. */
export const MAX_ITEM_OUTPUT = 32 * 1024
/** Diff lines kept per file per tool call; counts stay exact. */
const MAX_DIFF_LINES = 2000

const tailOf = (s: string) => (s.length > MAX_ITEM_OUTPUT ? s.slice(-MAX_ITEM_OUTPUT) : s)

export class RunState {
  runId = ""
  projectRoot = ""
  projectName = ""
  branch: string | undefined
  mode = "orchestrator"
  /** Run-wide autonomy level (normal = per-agent settings). */
  autonomy: "normal" | "ask" | "auto" | "yolo" = "normal"
  /** Who is watching (shared runs). */
  viewers: { name: string; via: string }[] = []
  /** agentId → person whose message starts that agent's next turn. */
  private pendingAuthor = new Map<string, { author: string; ts: number }>()
  orchestratorId: string | undefined
  agents = new Map<string, AgentView>()
  feeds = new Map<string, AgentFeed>()
  tasks = new Map<string, TaskView>()
  approvals = new Map<string, PendingApproval>()
  workspaces = new Map<string, WorkspaceView>()
  plan: { planId: string; status: "proposed" | "approved" | "rejected"; notes?: string } | undefined
  /** Budget stops that still need the user's attention. */
  budgetHits: { scope: string; usedUsd: number; limitUsd: number; ts: number; agentId?: string }[] = []
  bus: BusMessageView[] = []
  lastSeq = 0
  totals = { toolCalls: 0, messages: 0, added: 0, removed: 0, costUsd: 0, input: 0, output: 0 }
  /** Bumped on every applied event; per-agent versions let UIs re-render selectively. */
  version = 0
  agentVersions = new Map<string, number>()
  /** Agents that stopped keep only their latest items (live state); exports and replays turn this off. */
  trimExited = true
  busVersion = 0
  /** Bus messages excluding heartbeats/progress (status bar "msgs"). */
  busChatCount = 0
  /** Recent activity timestamps for sparklines. */
  activity: number[] = []

  /** Back to an empty state (replay seeking backwards). */
  reset(): void {
    const fresh = new RunState()
    for (const k of Object.keys(this) as (keyof this)[]) delete this[k]
    Object.assign(this, fresh)
  }

  static fromSnapshot(s: Snapshot): RunState {
    const r = new RunState()
    r.runId = s.runId
    r.projectRoot = s.projectRoot
    r.projectName = s.projectName
    r.branch = s.branch
    r.mode = s.mode
    r.orchestratorId = s.orchestratorId
    for (const a of s.agents) r.agents.set(a.agentId, { ...a })
    for (const t of s.tasks) r.tasks.set(t.taskId, { ...t })
    for (const p of s.approvals) r.approvals.set(p.requestId, { ...p })
    r.bus = [...s.bus]
    r.totals = { ...s.totals }
    r.lastSeq = s.lastSeq
    return r
  }

  feed(agentId: string): AgentFeed {
    let f = this.feeds.get(agentId)
    if (!f) {
      f = { items: [], index: new Map() }
      this.feeds.set(agentId, f)
    }
    return f
  }

  private push(agentId: string, item: FeedItem) {
    const f = this.feed(agentId)
    f.items.push(item)
    f.index.set(item.id, item)
    if (f.items.length > MAX_FEED) {
      const removed = f.items.splice(0, f.items.length - MAX_FEED)
      for (const r of removed) f.index.delete(r.id)
    }
  }

  private bump(agentId?: string) {
    this.version++
    if (agentId) this.agentVersions.set(agentId, (this.agentVersions.get(agentId) ?? 0) + 1)
  }

  apply(e: BatonEvent): void {
    if (!e.live) {
      if (e.seq <= this.lastSeq && this.lastSeq !== 0) return
      this.lastSeq = e.seq
    }
    if (!this.runId) this.runId = e.runId
    const aid = e.agentId
    const agent = aid ? this.agents.get(aid) : undefined
    if (agent && e.type !== "agent.attention") {
      agent.lastEventAt = e.ts
      if (
        agent.attention &&
        agent.attention.reason !== "scope" &&
        (e.type === "tool.call" || e.type === "turn.started" || e.type === "turn.completed" || e.type === "message.delta")
      ) {
        if (!(agent.attention.reason === "looping" && e.type === "tool.call")) agent.attention = undefined
      }
    }

    switch (e.type) {
      case "run.started":
        this.projectRoot = e.data.cwd
        this.mode = e.data.mode
        break
      case "orch.mode":
        this.mode = e.data.mode
        break
      case "run.autonomy":
        this.autonomy = e.data.mode
        break
      case "run.presence":
        this.viewers = e.data.viewers
        break
      case "user.input":
        this.pendingAuthor.set(e.data.agentId, { author: e.data.author, ts: e.ts })
        break
      case "agent.spawned": {
        const d = e.data
        this.agents.set(d.agentId, {
          ...d,
          status: "starting",
          startedAt: e.ts,
          usage: { input: 0, cachedInput: 0, output: 0, reasoning: 0, costUsd: 0 },
          toolCalls: 0,
          diff: { added: 0, removed: 0 },
        })
        if (d.isOrchestrator) this.orchestratorId = d.agentId
        this.bump(d.agentId)
        return
      }
      case "agent.updated":
        if (agent) Object.assign(agent, stripUndefined(e.data))
        break
      case "agent.session":
        if (agent) agent.sessionId = e.data.sessionId
        break
      case "agent.status":
        if (agent) {
          agent.status = e.data.status
          agent.statusDetail = e.data.detail
          if (e.data.status !== "busy" && e.data.status !== "awaiting_approval") agent.turnStartedAt = undefined
        }
        break
      case "agent.exited":
        if (agent) {
          agent.status = "exited"
          agent.statusDetail = e.data.reason
          agent.turnStartedAt = undefined
        }
        for (const [k, p] of this.approvals) if (p.agentId === aid) this.approvals.delete(k)
        if (aid && this.trimExited) {
          const f = this.feeds.get(aid)
          if (f && f.items.length > MAX_FEED_EXITED) for (const r of f.items.splice(0, f.items.length - MAX_FEED_EXITED)) f.index.delete(r.id)
        }
        break
      case "agent.history": {
        if (!aid) break
        const f = this.feed(aid)
        const old = (e.data.items as FeedItem[]).map((it) => ({ ...it, id: `h_${it.id}` }) as FeedItem)
        const marker: FeedItem = { kind: "note", id: `n_${e.id}`, text: "↑ earlier, from the resumed run", ts: e.ts }
        f.items.unshift(...old, marker)
        for (const it of [...old, marker]) f.index.set(it.id, it)
        if (f.items.length > MAX_FEED) for (const r of f.items.splice(0, f.items.length - MAX_FEED)) f.index.delete(r.id)
        break
      }
      case "turn.started":
        if (agent) {
          agent.turnStartedAt = e.ts
          agent.status = "busy"
        }
        if (aid && e.data.prompt) {
          const pa = this.pendingAuthor.get(aid)
          const from = pa && e.ts - pa.ts < 30_000 ? pa.author : undefined
          this.pendingAuthor.delete(aid)
          this.push(aid, { kind: "user", id: `u_${e.id}`, text: e.data.prompt, ts: e.ts, ...(from ? { from } : {}) })
        }
        break
      case "turn.completed":
      case "turn.interrupted":
        if (agent) agent.turnStartedAt = undefined
        if (aid) {
          // close dangling streamed messages
          for (const it of this.feed(aid).items) if (it.kind === "message" && !it.done) it.done = true
          if (e.type === "turn.interrupted") this.push(aid, { kind: "note", id: `n_${e.id}`, text: "Interrupted", ts: e.ts })
        }
        break
      case "message.delta": {
        if (!aid) break
        if (e.data.role === "user") break
        const f = this.feed(aid)
        const existing = f.index.get(e.data.messageId)
        if (existing && existing.kind === "message") existing.text += e.data.text
        else this.push(aid, { kind: "message", id: e.data.messageId, role: e.data.role, text: e.data.text, done: false, ts: e.ts })
        if (agent) agent.lastActivity = "writing"
        break
      }
      case "message.completed": {
        if (!aid || e.data.role === "user") break
        const f = this.feed(aid)
        const existing = f.index.get(e.data.messageId)
        if (existing && existing.kind === "message") {
          existing.text = e.data.text
          existing.done = true
        } else this.push(aid, { kind: "message", id: e.data.messageId, role: e.data.role, text: e.data.text, done: true, ts: e.ts })
        if (e.data.role === "assistant") this.totals.messages++
        break
      }
      case "tool.call": {
        if (!aid) break
        const f = this.feed(aid)
        if (f.index.has(e.data.toolCallId)) break
        this.push(aid, {
          kind: "tool",
          id: e.data.toolCallId,
          toolKind: e.data.kind,
          name: e.data.name,
          title: e.data.title,
          status: e.data.status,
          parentId: e.data.parentToolCallId,
          input: e.data.rawInput,
          diffs: [],
          ts: e.ts,
        })
        this.totals.toolCalls++
        if (agent) {
          agent.toolCalls++
          agent.lastActivity = e.data.title
        }
        this.activity.push(e.ts)
        if (this.activity.length > 600) this.activity.splice(0, this.activity.length - 600)
        break
      }
      case "tool.update": {
        if (!aid) break
        const it = this.feed(aid).index.get(e.data.toolCallId)
        if (it?.kind !== "tool") break
        if (e.data.status) it.status = e.data.status
        if (e.data.title) it.title = e.data.title
        if (e.data.summary) it.summary = e.data.summary
        for (const c of e.data.content ?? []) {
          if (c.type === "diff") {
            const lines = c.lines ?? []
            const added = c.added ?? lines.filter((l) => l.kind === "add").length
            const removed = c.removed ?? lines.filter((l) => l.kind === "del").length
            const prev = it.diffs.findIndex((d) => d.path === c.path)
            if (prev >= 0) {
              const old = it.diffs[prev]!
              this.totals.added -= old.added
              this.totals.removed -= old.removed
              if (agent) {
                agent.diff.added -= old.added
                agent.diff.removed -= old.removed
              }
              it.diffs.splice(prev, 1)
            }
            it.diffs.push({ path: c.path, lines: lines.length > MAX_DIFF_LINES ? lines.slice(0, MAX_DIFF_LINES) : lines, added, removed })
            this.totals.added += added
            this.totals.removed += removed
            if (agent) {
              agent.diff.added += added
              agent.diff.removed += removed
            }
          } else if (c.type === "terminal") {
            it.output = tailOf(c.output)
            if (c.exitCode !== undefined) it.exitCode = c.exitCode
          } else if (c.type === "text" && !it.summary) {
            it.output = tailOf((it.output ?? "") + c.text)
          }
        }
        break
      }
      case "plan.updated":
        if (agent) {
          const total = e.data.entries.length
          const done = e.data.entries.filter((x) => x.status === "completed").length
          agent.progress = total ? done / total : undefined
        }
        break
      case "usage.updated":
        if (agent) {
          const u = agent.usage
          const before = { ...u }
          if (e.data.mode === "delta") {
            u.input += e.data.input
            u.cachedInput += e.data.cachedInput
            u.output += e.data.output
            u.reasoning += e.data.reasoning
            u.costUsd += e.data.costUsd ?? 0
          } else {
            u.input = e.data.input
            u.cachedInput = e.data.cachedInput
            u.output = e.data.output
            u.reasoning = e.data.reasoning
            if (e.data.costUsd !== undefined) u.costUsd = e.data.costUsd
          }
          this.totals.input += u.input - before.input
          this.totals.output += u.output - before.output
          this.totals.costUsd += u.costUsd - before.costUsd
        }
        break
      case "permission.requested":
        if (aid) {
          this.approvals.set(e.data.requestId, {
            agentId: aid,
            requestId: e.data.requestId,
            title: e.data.title,
            kind: e.data.kind,
            detail: e.data.detail,
            options: e.data.options,
            ts: e.ts,
          })
          this.push(aid, { kind: "permission", id: e.data.requestId, title: e.data.title, ts: e.ts })
        }
        break
      case "permission.resolved": {
        this.approvals.delete(e.data.requestId)
        if (aid) {
          const it = this.feed(aid).index.get(e.data.requestId)
          if (it && it.kind === "permission") it.resolved = `${e.data.kind ?? "cancelled"} (${e.data.who ? `by ${e.data.who}` : e.data.by})`
        }
        break
      }
      case "bus.message": {
        const d = e.data
        this.bus.push({ messageId: d.messageId, ts: e.ts, from: d.from, to: d.to, kind: d.kind, body: d.body, delivery: d.delivery })
        if (this.bus.length > MAX_BUS) this.bus.splice(0, this.bus.length - MAX_BUS)
        this.busVersion++
        if (d.kind !== "heartbeat" && d.kind !== "progress") {
          this.busChatCount++
          if (this.agents.has(d.from))
            this.push(d.from, { kind: "bus", id: `bo_${d.messageId}`, from: d.from, to: d.to, body: d.body, direction: "out", ts: e.ts })
          if (this.agents.has(d.to)) this.push(d.to, { kind: "bus", id: `bi_${d.messageId}`, from: d.from, to: d.to, body: d.body, direction: "in", ts: e.ts })
          if (d.from !== d.to && this.agents.has(d.from)) this.bump(d.from)
          if (this.agents.has(d.to)) this.bump(d.to)
        }
        this.bump()
        return
      }
      case "bus.delivered": {
        const m = this.bus.findLast((b) => b.messageId === e.data.messageId)
        if (m) m.delivered = true
        this.busVersion++
        break
      }
      case "task.created":
        this.tasks.set(e.data.taskId, {
          taskId: e.data.taskId,
          title: e.data.title,
          state: "submitted",
          owner: e.data.owner,
          deps: e.data.deps,
          note: e.data.description,
          files: e.data.files,
          acceptance: e.data.acceptance,
          order: this.tasks.size,
        })
        break
      case "task.state": {
        const t = this.tasks.get(e.data.taskId)
        if (t) {
          t.state = e.data.state
          if (e.data.owner) t.owner = e.data.owner
          if (e.data.note) t.note = e.data.note
        }
        break
      }
      case "agent.attention":
        if (agent) agent.attention = e.data.reason === "clear" ? undefined : { reason: e.data.reason, detail: e.data.detail, ts: e.ts }
        break
      case "budget.exceeded":
        this.budgetHits.push({ scope: e.data.scope, usedUsd: e.data.usedUsd, limitUsd: e.data.limitUsd, ts: e.ts, agentId: aid })
        break
      case "workspace.created":
        if (aid) {
          this.workspaces.set(aid, {
            mode: e.data.mode,
            path: e.data.path,
            branch: e.data.branch,
            files: [],
            added: 0,
            removed: 0,
            conflicts: [],
            leases: [],
            port: e.data.ports?.[0],
          })
          if (agent) agent.cwd = e.data.path
        }
        break
      case "workspace.changed": {
        const w = aid ? this.workspaces.get(aid) : undefined
        if (w) {
          w.files = e.data.files
          w.added = e.data.added
          w.removed = e.data.removed
          const paths = new Set(e.data.files.map((f) => f.path))
          w.conflicts = w.conflicts.filter((c) => c.files.some((f) => paths.has(f)))
          if (w.merge?.status === "merged" && e.data.files.length) w.merge = undefined
        }
        break
      }
      case "workspace.conflict": {
        const w = aid ? this.workspaces.get(aid) : undefined
        if (w) {
          w.conflicts = w.conflicts.filter((c) => !(c.with === e.data.with && c.kind === e.data.kind))
          w.conflicts.push({ with: e.data.with, files: e.data.files, kind: e.data.kind })
        }
        if (aid) {
          const other = this.agents.get(e.data.with)?.name ?? "another agent"
          this.push(aid, {
            kind: "note",
            id: `c_${e.id}`,
            text: `${e.data.kind === "lease" ? "claimed by" : "conflicts with"} ${other}: ${e.data.files.join(", ")}`,
            ts: e.ts,
          })
        }
        break
      }
      case "workspace.merge": {
        const w = aid ? this.workspaces.get(aid) : undefined
        if (w) {
          w.merge = { status: e.data.status, detail: e.data.detail, files: e.data.files, ts: e.ts }
          if (e.data.status === "merged") w.conflicts = []
        }
        if (aid && e.data.status === "undone")
          this.push(aid, { kind: "note", id: `m_${e.id}`, text: `merge undone — ${e.data.files?.join(", ") ?? ""} unmerged again`, ts: e.ts })
        if (aid && (e.data.status === "merged" || e.data.status === "failed" || e.data.status === "conflict")) {
          const text =
            e.data.status === "merged"
              ? e.data.files?.length
                ? `merged ${e.data.files.length} file${e.data.files.length === 1 ? "" : "s"} (+${e.data.added ?? 0} −${e.data.removed ?? 0}) into the project`
                : "nothing to merge"
              : `merge ${e.data.status}: ${e.data.detail ?? ""}`
          this.push(aid, { kind: e.data.status === "merged" ? "note" : "error", id: `m_${e.id}`, text, ts: e.ts })
        }
        break
      }
      case "workspace.removed":
        if (aid) this.workspaces.delete(aid)
        break
      case "lease.claimed": {
        const w = aid ? this.workspaces.get(aid) : undefined
        if (w) w.leases.push({ leaseId: e.data.leaseId, globs: e.data.globs, exclusive: e.data.exclusive })
        break
      }
      case "lease.released":
        for (const w of this.workspaces.values()) w.leases = w.leases.filter((l) => l.leaseId !== e.data.leaseId)
        break
      case "review.requested": {
        const w = aid ? this.workspaces.get(aid) : undefined
        if (w) w.review = { status: "requested", reviewer: e.data.reviewer }
        break
      }
      case "review.verdict": {
        const w = this.workspaces.get(e.data.author)
        if (w) w.review = { status: e.data.verdict, reviewer: e.data.reviewer, notes: e.data.notes }
        if (aid)
          this.push(aid, {
            kind: "note",
            id: `r_${e.id}`,
            text: `review: ${e.data.verdict === "approve" ? "approved" : "changes requested"} — ${e.data.notes.split("\n")[0]}`,
            ts: e.ts,
          })
        break
      }
      case "task.updated": {
        const t = this.tasks.get(e.data.taskId)
        if (t) {
          if (e.data.title) t.title = e.data.title
          if (e.data.description) t.note = e.data.description
          if (e.data.acceptance !== undefined) t.acceptance = e.data.acceptance || undefined
          if (e.data.deps) t.deps = e.data.deps
          if (e.data.agent !== undefined) t.agent = e.data.agent || undefined
          if (e.data.order !== undefined) t.order = e.data.order
        }
        break
      }
      case "task.plan":
        this.plan = { planId: e.data.planId, status: e.data.status, notes: e.data.notes }
        break
      case "error":
        if (aid) this.push(aid, { kind: "error", id: `e_${e.id}`, text: e.data.message, ts: e.ts })
        break
      case "orch.note":
        if (aid) this.push(aid, { kind: "note", id: `n_${e.id}`, text: e.data.text, ts: e.ts })
        break
      default:
        break
    }
    this.bump(aid)
  }

  snapshot(): Snapshot {
    return {
      runId: this.runId,
      projectRoot: this.projectRoot,
      projectName: this.projectName,
      branch: this.branch,
      mode: this.mode,
      autonomy: this.autonomy,
      orchestratorId: this.orchestratorId,
      agents: [...this.agents.values()],
      tasks: [...this.tasks.values()],
      approvals: [...this.approvals.values()],
      bus: this.bus.slice(-200),
      totals: { ...this.totals },
      lastSeq: this.lastSeq,
      workspaces: Object.fromEntries(this.workspaces),
      viewers: this.viewers,
    }
  }

  /** Tasks in plan order (user reordering first, creation order otherwise). */
  orderedTasks(): TaskView[] {
    return [...this.tasks.values()]
      .map((t, i) => ({ t, k: t.order ?? i }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.t)
  }

  running(): AgentView[] {
    return [...this.agents.values()].filter((a) => a.status === "busy" || a.status === "awaiting_approval")
  }

  /** Workers in spawn order (everything but the orchestrator). */
  workers(): AgentView[] {
    return [...this.agents.values()].filter((a) => !a.isOrchestrator && a.status !== "exited")
  }

  findAgent(ref: string): AgentView | undefined {
    if (this.agents.has(ref)) return this.agents.get(ref)
    const lower = ref.toLowerCase()
    for (const a of this.agents.values()) if (a.name.toLowerCase() === lower && a.status !== "exited") return a
    for (const a of this.agents.values()) if (a.name.toLowerCase() === lower) return a
    return undefined
  }
}

function stripUndefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}
