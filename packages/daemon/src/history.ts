/**
 * Run history: summaries of past runs (from the event store), Markdown/JSONL export, and
 * resume — restart a run's agents with their native session ids and re-adopt worktrees that
 * still hold unmerged work.
 */
import { existsSync } from "node:fs"
import { formatCost, formatDuration, RunState } from "@batonsh/kernel"
import type { AgentInfo, BatonEvent } from "@batonsh/protocol"
import type { Runtime } from "./runtime.ts"

export interface RunSummary {
  runId: string
  startedAt: number
  endedAt?: number
  title: string
  agents: number
  adapters: string[]
  costUsd: number
  toolCalls: number
  added: number
  removed: number
  merged: number
  current: boolean
}

function fold(events: BatonEvent[]): RunState {
  const st = new RunState()
  for (const e of events) st.apply(e)
  return st
}

function firstPrompt(events: BatonEvent[]): string | undefined {
  for (const e of events) if (e.type === "turn.started" && e.data.prompt && !e.data.prompt.startsWith("[baton]")) return e.data.prompt
  return undefined
}

export function summarize(rt: Runtime, runId: string): RunSummary | undefined {
  const events = rt.store.query({ runId })
  if (!events.length) return undefined
  const st = fold(events)
  const merged = events.filter((e) => e.type === "workspace.merge" && e.data.status === "merged" && (e.data.files?.length ?? 0) > 0).length
  return {
    runId,
    startedAt: events[0]!.ts,
    endedAt: events.find((e) => e.type === "run.ended")?.ts,
    title: (firstPrompt(events) ?? "(no task)").split("\n")[0]!.slice(0, 120),
    agents: st.agents.size,
    adapters: [...new Set([...st.agents.values()].map((a) => a.adapter))],
    costUsd: st.totals.costUsd,
    toolCalls: st.totals.toolCalls,
    added: st.totals.added,
    removed: st.totals.removed,
    merged,
    current: runId === rt.runId,
  }
}

export function listRunSummaries(rt: Runtime, limit = 30): RunSummary[] {
  return rt.store
    .listRuns(limit)
    .map((r) => summarize(rt, r.runId))
    .filter((s): s is RunSummary => !!s)
}

export function exportRun(rt: Runtime, runId: string, format: "md" | "jsonl"): string {
  const events = rt.store.query({ runId })
  if (format === "jsonl") return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`
  const st = fold(events)
  const s = summarize(rt, runId)
  const out: string[] = []
  out.push(`# ${s?.title ?? runId}`, "")
  out.push(
    `- run: \`${runId}\` · started ${new Date(s?.startedAt ?? 0).toLocaleString()}${s?.endedAt ? ` · lasted ${formatDuration(s.endedAt - s.startedAt)}` : ""}`,
    `- agents: ${[...st.agents.values()].map((a) => `${a.name} (${a.adapter}${a.model ? `/${a.model}` : ""})`).join(", ")}`,
    `- ${st.totals.toolCalls} tool calls · +${st.totals.added} −${st.totals.removed} · ${formatCost(st.totals.costUsd)}`,
    "",
  )
  const name = (id?: string) => (id ? (st.agents.get(id)?.name ?? id) : "baton")
  const text = new Map<string, string>()
  for (const e of events) {
    switch (e.type) {
      case "turn.started":
        if (e.data.prompt)
          out.push(
            `### ${name(e.agentId)} ← ${e.data.prompt.startsWith("[baton]") ? "message" : "task"}`,
            "",
            `> ${e.data.prompt.split("\n").join("\n> ")}`,
            "",
          )
        break
      case "message.completed":
        if (e.data.role === "assistant" && e.data.text.trim()) out.push(`**${name(e.agentId)}:** ${e.data.text.trim()}`, "")
        text.set(e.data.messageId, e.data.text)
        break
      case "tool.call":
        out.push(`- \`${name(e.agentId)}\` ${e.data.title}`)
        break
      case "bus.message":
        if (e.data.kind !== "heartbeat" && e.data.kind !== "progress") out.push(`- ⇄ ${name(e.data.from)} → ${name(e.data.to)}: ${e.data.body.split("\n")[0]}`)
        break
      case "workspace.merge":
        if (e.data.status === "merged" || e.data.status === "failed" || e.data.status === "conflict")
          out.push(
            `- **merge ${e.data.status}** (${name(e.agentId)})${e.data.files?.length ? `: ${e.data.files.join(", ")}` : ""}${e.data.detail ? ` — ${e.data.detail}` : ""}`,
          )
        break
      case "review.verdict":
        out.push(`- **review** of ${name(e.data.author)} by ${name(e.data.reviewer)}: ${e.data.verdict} — ${e.data.notes.split("\n")[0]}`)
        break
      case "error":
        out.push(`- ⚠ ${name(e.agentId)}: ${e.data.message}`)
        break
    }
  }
  return `${out.join("\n")}\n`
}

/**
 * Resume a past run's agents in the current daemon. Agents get their native session back
 * (adapters that support resume), worktrees with unmerged work are re-adopted.
 */
export async function resumeRun(rt: Runtime, runId: string): Promise<string[]> {
  const events = rt.store.query({ runId })
  if (!events.length) throw new Error(`no run ${runId}`)
  const infos = new Map<string, AgentInfo>()
  const sessions = new Map<string, string>()
  const workspaces = new Map<string, { path: string; branch?: string; base?: string; mode: string }>()
  for (const e of events) {
    if (e.type === "agent.spawned") infos.set(e.data.agentId, e.data)
    else if (e.type === "agent.session" && e.agentId) sessions.set(e.agentId, e.data.sessionId)
    else if (e.type === "workspace.created" && e.agentId) workspaces.set(e.agentId, e.data)
  }
  const started: string[] = []
  const live = new Set([...rt.agents.values()].filter((a) => !a.closing).map((a) => a.info.name))
  for (const [oldId, info] of infos) {
    if (info.isOrchestrator) {
      if (!rt.orchestrator()) {
        const a = await rt.spawn({ adapter: info.adapter, isOrchestrator: true, model: info.model, label: info.label, resumeId: sessions.get(oldId) })
        started.push(a.name)
      }
      continue
    }
    if (live.has(info.name)) continue
    const ws = workspaces.get(oldId)
    const adopt = ws?.mode === "worktree" && existsSync(ws.path) ? ws : undefined
    try {
      const a = await rt.spawn({
        adapter: info.adapter,
        name: info.name,
        label: info.label,
        model: info.model,
        role: info.role,
        approval: info.approval as never,
        resumeId: sessions.get(oldId),
        adoptWorkspace: adopt ? { path: adopt.path, branch: adopt.branch, base: adopt.base } : undefined,
      })
      started.push(a.name)
    } catch (e) {
      rt.emit({ type: "log", data: { level: "warn", message: `resume ${info.name}: ${e instanceof Error ? e.message : e}` } })
    }
  }
  return started
}
