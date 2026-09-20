/**
 * Collaboration layer on top of the runtime: per-agent workspaces (git worktrees), predicted
 * conflicts, the merge queue, file leases, cross-vendor reviews and the task plan.
 */
import type { BatonEvent, TaskState } from "@batonsh/protocol"
import { deferred, newId } from "@batonsh/protocol"
import type { AgentRuntime, Runtime } from "./runtime.ts"
import { type MergeOutcome, type Workspace, WorkspaceManager } from "./workspace.ts"

interface Lease {
  leaseId: string
  agentId: string
  globs: string[]
  exclusive: boolean
  expiresAt: number
}

interface Review {
  reviewId: string
  author: string
  reviewer: string
  requester?: string
  /** Signature of the author's changes when the review was requested. */
  signature: string
  verdict?: "approve" | "changes_requested"
  notes?: string
}

export interface PlanTask {
  id?: string
  title: string
  description?: string
  deps?: string[]
  files?: string[]
  acceptance?: string
}

const VENDOR_ORDER = ["codex", "claude", "opencode", "gemini", "cursor", "copilot", "goose", "qwen", "kiro", "droid"]

function vendorOf(adapter: string): string {
  return adapter.replace(/-(acp|cli|stream)$/, "")
}

function signature(ws: Workspace | undefined): string {
  return (ws?.files ?? []).map((f) => `${f.path}:${f.added}:${f.removed}`).join("|")
}

export class Collaboration {
  readonly workspaces: WorkspaceManager
  private leases = new Map<string, Lease>()
  private reviews = new Map<string, Review>()
  private refreshTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private conflictSigs = new Map<string, string>()
  private taskOwners = new Map<string, string>() // agentId -> taskId
  private planWaiter: ReturnType<typeof deferred<{ approved: boolean; notes?: string }>> | undefined
  private planId: string | undefined

  constructor(private rt: Runtime) {
    this.workspaces = new WorkspaceManager(rt.projectRoot, rt.config.workspace, rt.runId)
  }

  // ───────────────────────────── workspaces ─────────────────────────────

  /** Create the agent's workspace; returns the directory the agent should work in. */
  async prepare(agent: AgentRuntime, isolation: "worktree" | "shared"): Promise<string> {
    let ws: Workspace
    try {
      ws = await this.workspaces.create(agent.info.agentId, agent.info.name, isolation)
    } catch (e) {
      this.rt.emit(
        {
          type: "orch.note",
          data: { level: "warn", text: `worktree for ${agent.info.name} failed (${e instanceof Error ? e.message : e}); using the project directly` },
        },
        agent.info.agentId,
      )
      ws = await this.workspaces.create(agent.info.agentId, agent.info.name, "shared")
    }
    this.rt.emit({ type: "workspace.created", data: { path: ws.path, branch: ws.branch, base: ws.base, mode: ws.mode, ports: ws.ports } }, agent.info.agentId)
    return ws.path
  }

  /** Re-attach a worktree left behind by an earlier run (resume). */
  adopt(agent: AgentRuntime, ws: { path: string; branch?: string; base?: string }): string {
    const w = this.workspaces.adopt(agent.info.agentId, agent.info.name, ws.path, ws.branch, ws.base)
    this.rt.emit({ type: "workspace.created", data: { path: w.path, branch: w.branch, base: w.base, mode: "worktree" } }, agent.info.agentId)
    this.scheduleRefresh(agent.info.agentId, 200)
    return w.path
  }

  onEvent(agent: AgentRuntime, e: BatonEvent): void {
    const id = agent.info.agentId
    switch (e.type) {
      case "tool.update": {
        const touched = (e.data.content ?? []).filter((c) => c.type === "diff").map((c) => (c.type === "diff" ? c.path : ""))
        if (touched.length) this.checkLeases(agent, touched)
        if (touched.length || e.data.status === "completed") this.scheduleRefresh(id)
        break
      }
      case "turn.completed":
      case "turn.interrupted":
        this.scheduleRefresh(id, 300)
        break
    }
  }

  /** Result of a dispatched task → task state. */
  onResult(agent: AgentRuntime, outcome: "ok" | "failed" | "interrupted") {
    const taskId = this.taskOwners.get(agent.info.agentId)
    if (!taskId) return
    const task = this.rt.state.tasks.get(taskId)
    if (!task || task.state !== "working") return
    const state: TaskState = outcome === "ok" ? "completed" : outcome === "failed" ? "failed" : "input_required"
    this.rt.emit({ type: "task.state", data: { taskId, state, owner: agent.info.agentId } })
    this.taskOwners.delete(agent.info.agentId)
  }

  private scheduleRefresh(agentId: string, delay = 1200) {
    const ws = this.workspaces.byAgent.get(agentId)
    if (!ws || ws.mode !== "worktree") return
    const prev = this.refreshTimers.get(agentId)
    if (prev) clearTimeout(prev)
    const t = setTimeout(() => {
      this.refreshTimers.delete(agentId)
      void this.refresh(agentId)
    }, delay)
    t.unref?.()
    this.refreshTimers.set(agentId, t)
  }

  async refresh(agentId: string): Promise<Workspace | undefined> {
    const before = signature(this.workspaces.byAgent.get(agentId))
    let ws: Workspace | undefined
    try {
      ws = await this.workspaces.refresh(agentId)
    } catch (e) {
      this.rt.emit({ type: "log", data: { level: "debug", message: `workspace refresh: ${e instanceof Error ? e.message : e}` } }, agentId)
      return undefined
    }
    if (!ws) return undefined
    if (signature(ws) !== before) {
      const added = ws.files.reduce((n, f) => n + f.added, 0)
      const removed = ws.files.reduce((n, f) => n + f.removed, 0)
      this.rt.emit({ type: "workspace.changed", data: { files: ws.files, added, removed } }, agentId)
      this.checkScope(
        agentId,
        ws.files.map((f) => f.path),
      )
      if (this.rt.config.workspace.conflict_check) await this.checkConflicts(agentId)
    }
    return ws
  }

  private scopeSeen = new Map<string, string>()

  /** Files changed outside the agent's task scope (task.files globs) → flag once per new set. */
  private checkScope(agentId: string, paths: string[]) {
    const taskId = this.taskOwners.get(agentId) ?? [...this.rt.state.tasks.values()].find((t) => t.owner === agentId)?.taskId
    if (!taskId) return
    const created = this.rt.store.query({ types: ["task.created"] }).find((e) => e.type === "task.created" && e.data.taskId === taskId)
    const globs = created?.type === "task.created" ? created.data.files : undefined
    if (!globs?.length) return
    const outside = paths.filter((p) => !globs.some((g) => matchGlob(g, p)))
    if (!outside.length) return
    const sig = [...outside].sort().join(",")
    if (this.scopeSeen.get(agentId) === sig) return
    this.scopeSeen.set(agentId, sig)
    const name = this.rt.agents.get(agentId)?.info.name ?? "agent"
    this.rt.emit({ type: "agent.attention", data: { reason: "scope", detail: `outside ${globs.join(", ")}: ${outside.join(", ")}` } }, agentId)
    this.notifyLead(`${name} changed files outside its task scope (${globs.join(", ")}): ${outside.join(", ")}. Check whether that's intended before merging.`)
  }

  private async checkConflicts(agentId: string) {
    const conflicts = await this.workspaces.conflictsFor(agentId).catch(() => [])
    for (const c of conflicts) {
      const key = [agentId, c.with].sort().join("|")
      const sig = c.files.sort().join(",")
      if (this.conflictSigs.get(key) === sig) continue
      this.conflictSigs.set(key, sig)
      this.rt.emit({ type: "workspace.conflict", data: { with: c.with, files: c.files, kind: "merge" } }, agentId)
      this.rt.emit({ type: "workspace.conflict", data: { with: agentId, files: c.files, kind: "merge" } }, c.with)
      const a = this.rt.agents.get(agentId)?.info.name
      const b = this.rt.agents.get(c.with)?.info.name
      this.notifyLead(
        `Conflict ahead: ${a} and ${b} both changed ${c.files.join(", ")} in incompatible ways. Merge one, then \`sync\` the other (or reassign the files).`,
      )
    }
  }

  private notifyLead(body: string, kind: "system" | "result" = "system") {
    const lead = this.rt.orchestrator()
    if (!lead) return
    try {
      this.rt.send({ from: "baton", to: lead.info.agentId, body, kind, delivery: "queue" })
    } catch {}
  }

  async diff(agentId: string, paths: string[] = []): Promise<string> {
    return this.workspaces.patch(agentId, paths)
  }

  async merge(agentId: string, requester?: string): Promise<MergeOutcome> {
    const agent = this.rt.agents.get(agentId)
    if (!agent) throw new Error("no such agent")
    const ws = await this.refresh(agentId)
    if (this.rt.config.workspace.review === "required" && ws?.files.length) {
      const approved = [...this.reviews.values()].some((r) => r.author === agentId && r.verdict === "approve" && r.signature === signature(ws))
      if (!approved) {
        const out: MergeOutcome = {
          status: "failed",
          files: ws.files,
          detail: "workspace.review = required: get an approving review of the current changes first (request_review)",
        }
        this.rt.emit({ type: "workspace.merge", data: { status: "failed", detail: out.detail } }, agentId)
        return out
      }
    }
    this.rt.emit({ type: "workspace.merge", data: { status: "queued" } }, agentId)
    const r = await this.workspaces.merge(agentId, () => this.rt.emit({ type: "workspace.merge", data: { status: "verifying" } }, agentId))
    const added = r.files.reduce((n, f) => n + f.added, 0)
    const removed = r.files.reduce((n, f) => n + f.removed, 0)
    const files = r.files.map((f) => f.path)
    if (r.status === "merged") {
      this.rt.emit({ type: "workspace.merge", data: { status: "merged", commit: r.commit, files, added, removed } }, agentId)
      this.rt.emit({ type: "workspace.changed", data: { files: [], added: 0, removed: 0 } }, agentId)
      // merged changes can resolve or create conflicts for everyone else
      for (const other of this.workspaces.byAgent.keys()) if (other !== agentId) this.scheduleRefresh(other, 200)
    } else if (r.status === "empty") {
      this.rt.emit({ type: "workspace.merge", data: { status: "merged", files: [], added: 0, removed: 0, detail: "nothing to merge" } }, agentId)
    } else {
      this.rt.emit(
        { type: "workspace.merge", data: { status: r.status === "conflict" ? "conflict" : "failed", files: r.conflicts ?? files, detail: r.detail } },
        agentId,
      )
      if (requester !== this.rt.orchestrator()?.info.agentId) this.notifyLead(`Merge of ${agent.info.name} ${r.status}: ${r.detail ?? ""}`)
    }
    return r
  }

  async undoMerge(agentId?: string) {
    const r = await this.workspaces.undoMerge(agentId)
    const target = r.agentName ? this.rt.findAgent(r.agentName) : undefined
    if (r.ok && target) {
      this.rt.emit({ type: "workspace.merge", data: { status: "undone", files: r.files } }, target.info.agentId)
      this.scheduleRefresh(target.info.agentId, 0)
    }
    return r
  }

  async sync(agentId: string): Promise<{ clean: boolean; conflicts: string[] }> {
    const r = await this.workspaces.sync(agentId)
    this.scheduleRefresh(agentId, 0)
    if (!r.clean) {
      const agent = this.rt.agents.get(agentId)
      if (agent) {
        try {
          this.rt.send({
            from: "baton",
            to: agentId,
            kind: "request",
            delivery: "queue",
            body: `The project changed under you; I merged it into your workspace. Resolve the conflict markers in: ${r.conflicts.join(", ")}. Keep both intents; then report.`,
          })
        } catch {}
      }
    }
    return r
  }

  async remove(agentId: string) {
    const timer = this.refreshTimers.get(agentId)
    if (timer) clearTimeout(timer)
    for (const [id, l] of this.leases) if (l.agentId === agentId) this.releaseLease(id)
    const r = await this.workspaces.remove(agentId).catch((e) => ({ kept: true, reason: String(e) }))
    if (this.rt.state.workspaces.has(agentId)) this.rt.emit({ type: "workspace.removed", data: r }, agentId)
    if (r.kept && r.reason) this.rt.emit({ type: "orch.note", data: { level: "warn", text: r.reason } }, agentId)
  }

  // ───────────────────────────── leases ─────────────────────────────

  claim(agentId: string, globs: string[], exclusive = true, ttlS = 1800): { ok: boolean; leaseId?: string; conflicts: { agent: string; globs: string[] }[] } {
    this.expire()
    const conflicts: { agent: string; globs: string[] }[] = []
    for (const l of this.leases.values()) {
      if (l.agentId === agentId || (!l.exclusive && !exclusive)) continue
      const overlap = globs.filter((g) => l.globs.some((h) => globsOverlap(g, h)))
      if (overlap.length) conflicts.push({ agent: this.rt.agents.get(l.agentId)?.info.name ?? l.agentId, globs: overlap })
    }
    if (conflicts.length && exclusive) return { ok: false, conflicts }
    const leaseId = newId("lease")
    const expiresAt = Date.now() + ttlS * 1000
    this.leases.set(leaseId, { leaseId, agentId, globs, exclusive, expiresAt })
    this.rt.emit({ type: "lease.claimed", data: { leaseId, globs, exclusive, expiresAt } }, agentId)
    return { ok: true, leaseId, conflicts }
  }

  release(agentId: string, globs?: string[]): number {
    let n = 0
    for (const [id, l] of this.leases) {
      if (l.agentId !== agentId) continue
      if (globs && !l.globs.some((g) => globs.includes(g))) continue
      this.releaseLease(id)
      n++
    }
    return n
  }

  private releaseLease(id: string) {
    const l = this.leases.get(id)
    if (!l) return
    this.leases.delete(id)
    this.rt.emit({ type: "lease.released", data: { leaseId: id } }, l.agentId)
  }

  private expire() {
    const now = Date.now()
    for (const [id, l] of this.leases) if (l.expiresAt < now) this.releaseLease(id)
  }

  /** An agent edited files someone else holds an exclusive lease on. */
  private checkLeases(agent: AgentRuntime, paths: string[]) {
    this.expire()
    for (const l of this.leases.values()) {
      if (l.agentId === agent.info.agentId || !l.exclusive) continue
      const hit = paths.filter((p) => l.globs.some((g) => matchGlob(g, p)))
      if (!hit.length) continue
      const holder = this.rt.agents.get(l.agentId)?.info.name ?? "another agent"
      this.rt.emit({ type: "workspace.conflict", data: { with: l.agentId, files: hit, kind: "lease" } }, agent.info.agentId)
      try {
        this.rt.send({
          from: "baton",
          to: agent.info.agentId,
          kind: "system",
          delivery: "steer",
          body: `${hit.join(", ")} is claimed by ${holder}. Coordinate with them (send_message) before changing it.`,
        })
      } catch {}
    }
  }

  // ───────────────────────────── reviews ─────────────────────────────

  pickReviewer(author: AgentRuntime, preferred?: string): string {
    if (preferred) return preferred
    if (this.rt.config.workspace.reviewer) return this.rt.config.workspace.reviewer
    const authorVendor = vendorOf(author.info.adapter)
    const usable = (id: string) => {
      const a = this.rt.registry.get(id)
      return a !== undefined && id !== "mock"
    }
    const candidates = VENDOR_ORDER.filter((id) => vendorOf(id) !== authorVendor && usable(id))
    return candidates[0] ?? author.info.adapter
  }

  async requestReview(authorId: string, opts: { reviewer?: string; requester?: string } = {}): Promise<{ reviewId: string; reviewer: string }> {
    const author = this.rt.agents.get(authorId)
    if (!author) throw new Error("no such agent")
    const ws = await this.refresh(authorId)
    const wsAny = this.workspaces.byAgent.get(authorId)
    if (!wsAny) throw new Error(`${author.info.name} has no workspace`)
    const existing = opts.reviewer ? this.rt.findAgent(opts.reviewer) : undefined
    const reviewId = newId("rev")
    const files = (ws?.files ?? []).map((f) => `- ${f.path} (+${f.added} −${f.removed})`).join("\n") || "- (no changes detected yet)"
    // Inline the patch: reviewers may run sandboxed (no access to the main repo's git metadata).
    const patch = await this.workspaces.patch(authorId).catch(() => "")
    const shown = patch.length > 40_000 ? `${patch.slice(0, 40_000)}\n… [truncated; ${patch.length} bytes total]` : patch
    const task = `Review the changes ${author.info.name} made${author.info.label ? ` for "${author.info.label}"` : ""}. You are in its workspace (the changed files are on disk here).
Changed files:
${files}

${shown ? `The diff:\n\`\`\`diff\n${shown}\n\`\`\`` : "(no diff available — inspect the files directly)"}

Check correctness, edge cases and tests (run them if the project has any). Do NOT modify files.
When done, call the baton tool submit_review with verdict "approve" or "changes_requested" and specific, actionable notes.`
    let reviewerId: string
    if (existing) {
      reviewerId = existing.info.agentId
      await this.rt.promptAgent(reviewerId, task, { from: opts.requester })
    } else {
      const adapter = this.pickReviewer(author, opts.reviewer)
      const info = await this.rt.spawn({
        adapter,
        label: `review ${author.info.name}`,
        role: this.rt.config.roles.reviewer ? "reviewer" : undefined,
        parentId: opts.requester,
        cwd: wsAny.path,
        isolation: "shared",
        prompt: task,
      })
      reviewerId = info.agentId
    }
    this.reviews.set(reviewId, { reviewId, author: authorId, reviewer: reviewerId, requester: opts.requester, signature: signature(ws) })
    this.rt.emit({ type: "review.requested", data: { reviewId, author: authorId, reviewer: reviewerId } }, authorId)
    return { reviewId, reviewer: this.rt.agents.get(reviewerId)?.info.name ?? reviewerId }
  }

  submitReview(reviewerId: string, verdict: "approve" | "changes_requested", notes: string): { author: string } {
    const review = [...this.reviews.values()].reverse().find((r) => r.reviewer === reviewerId && !r.verdict)
    if (!review) throw new Error("no open review is assigned to you")
    review.verdict = verdict
    review.notes = notes
    this.rt.emit({ type: "review.verdict", data: { reviewId: review.reviewId, author: review.author, reviewer: reviewerId, verdict, notes } }, review.author)
    const author = this.rt.agents.get(review.author)
    const reviewer = this.rt.agents.get(reviewerId)?.info.name ?? "reviewer"
    if (verdict === "changes_requested" && author && !author.closing) {
      try {
        this.rt.send({ from: reviewerId, to: review.author, kind: "request", delivery: "queue", body: `Review from ${reviewer}: changes requested.\n${notes}` })
      } catch {}
    }
    this.notifyLead(`Review of ${author?.info.name ?? "agent"} by ${reviewer}: ${verdict === "approve" ? "APPROVED" : "changes requested"}\n${notes}`, "result")
    return { author: author?.info.name ?? review.author }
  }

  // ───────────────────────────── tasks ─────────────────────────────

  async plan(tasks: PlanTask[], timeoutMs = 15 * 60_000): Promise<{ approved: boolean; notes?: string; ids: string[] }> {
    const ids: string[] = []
    for (const t of tasks) {
      const taskId = t.id ?? `t${this.rt.state.tasks.size + ids.length + 1}`
      ids.push(taskId)
      this.rt.emit({
        type: "task.created",
        data: { taskId, title: t.title, description: t.description, deps: t.deps ?? [], files: t.files, acceptance: t.acceptance },
      })
    }
    if (!this.rt.config.orchestrator.plan_approval) return { approved: true, ids }
    this.planId = newId("plan")
    this.planWaiter = deferred()
    this.rt.emit({ type: "task.plan", data: { planId: this.planId, status: "proposed" } })
    const t = setTimeout(() => this.planWaiter?.resolve({ approved: false, notes: "no answer from the user (timed out)" }), timeoutMs)
    const r = await this.planWaiter.promise
    clearTimeout(t)
    this.planWaiter = undefined
    return { ...r, ids }
  }

  decidePlan(approved: boolean, notes?: string): boolean {
    if (!this.planWaiter || !this.planId) return false
    this.rt.emit({ type: "task.plan", data: { planId: this.planId, status: approved ? "approved" : "rejected", notes } })
    this.planWaiter.resolve({ approved, notes })
    return true
  }

  assignTask(taskId: string, agentId: string) {
    if (!this.rt.state.tasks.has(taskId)) return
    this.taskOwners.set(agentId, taskId)
    this.rt.emit({ type: "task.state", data: { taskId, state: "working", owner: agentId } })
  }

  updateTask(taskId: string, state: TaskState, note?: string) {
    if (!this.rt.state.tasks.has(taskId)) throw new Error(`no task "${taskId}"`)
    this.rt.emit({ type: "task.state", data: { taskId, state, note } })
  }
}

/** Minimal glob support: `*` (segment), `**` (any depth), `?`; plain paths match prefixes (dirs). */
export function matchGlob(glob: string, path: string): boolean {
  const g = glob.replace(/^\.\//, "")
  const p = path.replace(/^\.\//, "")
  if (!/[*?]/.test(g)) return p === g || p.startsWith(`${g.replace(/\/$/, "")}/`)
  return new Bun.Glob(g).match(p)
}

function globsOverlap(a: string, b: string): boolean {
  const lit = (g: string) => g.replace(/^\.\//, "").split(/[*?]/)[0] ?? ""
  const la = lit(a)
  const lb = lit(b)
  return la.startsWith(lb) || lb.startsWith(la) || matchGlob(a, lb) || matchGlob(b, la)
}
