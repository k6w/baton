/**
 * Scorecards: what each agent (adapter + model) has actually delivered in this project, per kind
 * of task — merged work, review verdicts, failed turns, cost — learned from past runs' events.
 * The orchestrator uses them to pick who does what (and on which model tier); the TUI shows them.
 */
import type { BatonEvent } from "@batonsh/protocol"
import { RunState } from "./projection.ts"

export const TASK_KINDS = ["tests", "bugfix", "refactor", "feature", "docs", "ui", "review", "research", "perf", "other"] as const
export type TaskKind = (typeof TASK_KINDS)[number]

const KIND_WORDS: [TaskKind, RegExp][] = [
  ["review", /\breview|verify|audit|check (the|their|its)\b/i],
  ["tests", /\btests?\b|\bspec\b|coverage|\bflaky\b/i],
  ["bugfix", /\bfix|bug|crash|error|broken|regression|typo|issue\b/i],
  ["refactor", /refactor|clean ?up|rename|extract|simplif|migrat|restructur/i],
  ["docs", /\bdocs?\b|readme|changelog|documentation|comment/i],
  ["ui", /\bui\b|css|style|layout|component|frontend|tailwind|button|page\b/i],
  ["perf", /perf|faster|slow|optimi[sz]|latency|memory/i],
  ["research", /research|investigat|explore|find out|figure out|analy[sz]e|why\b/i],
  ["feature", /\badd|implement|build|create|support|introduce|new\b/i],
]

/** The built-in role that fits a kind of task (pick_agent suggests it). */
export const ROLE_FOR_KIND: Partial<Record<TaskKind, string>> = {
  tests: "tester",
  bugfix: "debugger",
  refactor: "refactorer",
  docs: "docs",
  ui: "frontend",
  review: "reviewer",
  research: "researcher",
}

/** A role for a task: security work gets the auditor, otherwise by kind. */
export function roleFor(text: string): string | undefined {
  if (/\bsecurity|vulnerab|exploit|auth[nz]?\b|injection|xss|csrf|secret/i.test(text)) return "security"
  return ROLE_FOR_KIND[classifyTask(text)]
}

/** Rough kind of a task from its label / prompt. */
export function classifyTask(text: string): TaskKind {
  for (const [kind, re] of KIND_WORDS) if (re.test(text)) return kind
  return "other"
}

export interface ScoreRow {
  /** "codex", "claude · opus" … */
  key: string
  adapter: string
  model?: string
  kind: TaskKind | "all"
  /** Agents (one per spawn) that worked on this kind of task. */
  agents: number
  merged: number
  mergeFailed: number
  approved: number
  changesRequested: number
  failedTurns: number
  interrupted: number
  costUsd: number
  /** Smoothed success rate 0..1 (Laplace prior: 1 success, 1 failure). */
  score: number
  /** Average cost per success (merged or approved), undefined without successes. */
  costPerSuccess?: number
}

interface AgentRecord {
  adapter: string
  model?: string
  kind: TaskKind
  merged: number
  mergeFailed: number
  approved: number
  changesRequested: number
  failedTurns: number
  interrupted: number
  costUsd: number
}

/** The event types scorecards need (to query the store cheaply). */
export const SCORE_EVENT_TYPES = [
  "agent.spawned",
  "agent.updated",
  "turn.started",
  "turn.completed",
  "turn.interrupted",
  "usage.updated",
  "workspace.merge",
  "review.verdict",
]

/** One run's events → one record per worker agent. */
export function runRecords(events: readonly BatonEvent[]): AgentRecord[] {
  const st = new RunState()
  const firstPrompt = new Map<string, string>()
  const rec = new Map<string, Omit<AgentRecord, "adapter" | "model" | "kind" | "costUsd">>()
  const get = (id: string) => {
    let r = rec.get(id)
    if (!r) {
      r = { merged: 0, mergeFailed: 0, approved: 0, changesRequested: 0, failedTurns: 0, interrupted: 0 }
      rec.set(id, r)
    }
    return r
  }
  for (const e of events) {
    st.apply(e)
    const id = e.agentId
    switch (e.type) {
      case "turn.started":
        if (id && e.data.prompt && !e.data.prompt.startsWith("[baton]") && !firstPrompt.has(id)) firstPrompt.set(id, e.data.prompt)
        break
      case "turn.completed":
        if (id && e.data.stopReason === "error") get(id).failedTurns++
        break
      case "turn.interrupted":
        if (id) get(id).interrupted++
        break
      case "workspace.merge":
        if (!id) break
        if (e.data.status === "merged" && (e.data.files?.length ?? 0) > 0) get(id).merged++
        else if (e.data.status === "failed" || e.data.status === "conflict") get(id).mergeFailed++
        else if (e.data.status === "undone") get(id).merged = Math.max(0, get(id).merged - 1)
        break
      case "review.verdict":
        if (e.data.verdict === "approve") get(e.data.author).approved++
        else get(e.data.author).changesRequested++
        break
    }
  }
  const out: AgentRecord[] = []
  for (const a of st.agents.values()) {
    if (a.isOrchestrator || a.adapter === "mock") continue
    const r = get(a.agentId)
    const text = `${a.label ?? ""} ${a.role ?? ""} ${firstPrompt.get(a.agentId) ?? ""}`
    out.push({ ...r, adapter: a.adapter, model: a.model, kind: a.role === "reviewer" ? "review" : classifyTask(text), costUsd: a.usage.costUsd })
  }
  return out
}

/** Aggregate records into rows per agent key, per kind and overall ("all"). */
export function scorecards(records: readonly AgentRecord[]): ScoreRow[] {
  const rows = new Map<string, ScoreRow>()
  const add = (r: AgentRecord, kind: TaskKind | "all") => {
    const key = r.model ? `${r.adapter} · ${r.model}` : r.adapter
    const id = `${key}|${kind}`
    let row = rows.get(id)
    if (!row) {
      row = {
        key,
        adapter: r.adapter,
        model: r.model,
        kind,
        agents: 0,
        merged: 0,
        mergeFailed: 0,
        approved: 0,
        changesRequested: 0,
        failedTurns: 0,
        interrupted: 0,
        costUsd: 0,
        score: 0.5,
      }
      rows.set(id, row)
    }
    row.agents++
    row.merged += r.merged
    row.mergeFailed += r.mergeFailed
    row.approved += r.approved
    row.changesRequested += r.changesRequested
    row.failedTurns += r.failedTurns
    row.interrupted += r.interrupted
    row.costUsd += r.costUsd
  }
  for (const r of records) {
    add(r, r.kind)
    add(r, "all")
  }
  for (const row of rows.values()) {
    const good = row.merged + row.approved
    const bad = row.mergeFailed + row.changesRequested + row.failedTurns
    row.score = (good + 1) / (good + bad + 2)
    row.costPerSuccess = good ? row.costUsd / good : undefined
  }
  return [...rows.values()].sort((a, b) => b.score - a.score || b.agents - a.agents)
}

export interface Pick {
  adapter: string
  model?: string
  tier?: "small" | "medium" | "large"
  score: number
  costPerSuccess?: number
  why: string
}

/**
 * Rank candidates for a task: track record on this kind of task first (falling back to overall),
 * then cost per success. With little evidence everyone is ~0.5 and cheaper/untried agents get a
 * chance; a model tier is suggested from the task's kind (small for docs / research / review).
 */
export function pickAgents(rows: readonly ScoreRow[], task: string, candidates: readonly string[]): { kind: TaskKind; picks: Pick[] } {
  const kind = classifyTask(task)
  const tier: Pick["tier"] =
    kind === "docs" || kind === "research" || kind === "review" ? "small" : kind === "refactor" || kind === "feature" || kind === "perf" ? "large" : "medium"
  const picks: Pick[] = candidates.map((adapter) => {
    const specific = rows.filter((r) => r.adapter === adapter && r.kind === kind).sort((a, b) => b.agents - a.agents)[0]
    const overall = rows.filter((r) => r.adapter === adapter && r.kind === "all").sort((a, b) => b.agents - a.agents)[0]
    const best = specific && specific.agents >= 2 ? specific : overall
    if (!best) return { adapter, tier, score: 0.5, why: "no track record yet in this project" }
    const n = best.merged + best.approved + best.mergeFailed + best.changesRequested + best.failedTurns
    const where = best === specific ? `on ${kind} tasks` : "overall"
    return {
      adapter,
      model: best.model,
      tier,
      score: best.score,
      costPerSuccess: best.costPerSuccess,
      why: `${Math.round(best.score * 100)}% ${where} (${best.merged} merged, ${best.approved} approved, ${best.mergeFailed + best.changesRequested + best.failedTurns} setbacks in ${n} outcomes${best.costPerSuccess !== undefined ? `, ~$${best.costPerSuccess.toFixed(2)} per success` : ""})`,
    }
  })
  // expected value per dollar decides close calls
  picks.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.08) return b.score - a.score
    return (a.costPerSuccess ?? Number.POSITIVE_INFINITY) - (b.costPerSuccess ?? Number.POSITIVE_INFINITY) || b.score - a.score
  })
  return { kind, picks }
}
