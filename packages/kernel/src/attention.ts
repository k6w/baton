/**
 * The "needs you" queue: everything across all agents that is waiting on the user, ordered
 * by urgency. Derived purely from RunState so the TUI, CLI and SDK agree.
 */
import type { RunState } from "./projection.ts"

export type AttentionKind = "approval" | "plan" | "failed" | "conflict" | "merge" | "stalled" | "looping" | "budget" | "ready"

export interface AttentionItem {
  kind: AttentionKind
  agentId?: string
  /** Approval request id (for approval items). */
  requestId?: string
  title: string
  detail?: string
  ts: number
}

const ORDER: AttentionKind[] = ["approval", "plan", "failed", "conflict", "merge", "budget", "stalled", "looping", "ready"]

export function attentionItems(run: RunState): AttentionItem[] {
  const out: AttentionItem[] = []
  const name = (id?: string) => (id ? (run.agents.get(id)?.name ?? "agent") : "baton")
  for (const p of run.approvals.values())
    out.push({ kind: "approval", agentId: p.agentId, requestId: p.requestId, title: `${name(p.agentId)} wants to ${p.title}`, detail: p.detail, ts: p.ts })
  if (run.plan?.status === "proposed")
    out.push({ kind: "plan", title: `Plan proposed: ${run.tasks.size} tasks`, detail: "approve or reject it (ctrl+g)", ts: Date.now() })
  for (const a of run.agents.values()) {
    if (a.status === "error" || (a.status === "exited" && a.statusDetail && !/^(closed|killed|shutdown)$/.test(a.statusDetail)))
      out.push({ kind: "failed", agentId: a.agentId, title: `${a.name} failed`, detail: a.statusDetail, ts: a.lastEventAt ?? a.startedAt })
    if (a.attention && a.status === "busy")
      out.push({
        kind: a.attention.reason,
        agentId: a.agentId,
        title: `${a.name} looks ${a.attention.reason === "stalled" ? "stuck" : "stuck in a loop"}`,
        detail: a.attention.detail,
        ts: a.attention.ts,
      })
  }
  for (const [agentId, w] of run.workspaces) {
    const a = run.agents.get(agentId)
    if (!a || a.status === "exited") continue
    if (w.conflicts.length)
      out.push({
        kind: "conflict",
        agentId,
        title: `${a.name} conflicts with ${name(w.conflicts[0]!.with)}`,
        detail: w.conflicts[0]!.files.join(", "),
        ts: w.merge?.ts ?? a.lastEventAt ?? 0,
      })
    if (w.merge && (w.merge.status === "failed" || w.merge.status === "conflict"))
      out.push({ kind: "merge", agentId, title: `Merge of ${a.name} ${w.merge.status}`, detail: w.merge.detail, ts: w.merge.ts })
    else if (w.files.length && a.status === "ready" && !w.conflicts.length)
      out.push({
        kind: "ready",
        agentId,
        title: `${a.name} finished — ${w.files.length} file${w.files.length === 1 ? "" : "s"} to review & merge`,
        ts: a.lastEventAt ?? 0,
      })
  }
  for (const b of run.budgetHits)
    out.push({ kind: "budget", agentId: b.agentId, title: `Budget reached (${b.scope}): $${b.usedUsd.toFixed(2)} of $${b.limitUsd}`, ts: b.ts })
  return out.sort((x, y) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind) || x.ts - y.ts)
}

/** Items that should count toward the status-bar badge (everything except "ready to merge"). */
export function urgentCount(items: AttentionItem[]): number {
  return items.filter((i) => i.kind !== "ready").length
}
