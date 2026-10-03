/**
 * The project's agent scorecards (kernel/scorecard.ts) computed from the event store across
 * recent runs, cached and refreshed when merges or reviews land.
 */
import { pickAgents, runRecords, SCORE_EVENT_TYPES, type ScoreRow, scorecards } from "@batonsh/kernel"
import type { Runtime } from "./runtime.ts"

const cache = new WeakMap<Runtime, { rows: ScoreRow[]; at: number; dirty: boolean }>()
const watching = new WeakSet<Runtime>()

export function getScorecards(rt: Runtime, maxRuns = 200): ScoreRow[] {
  if (!watching.has(rt)) {
    watching.add(rt)
    rt.store.subscribe((e) => {
      if (e.type === "workspace.merge" || e.type === "review.verdict" || e.type === "agent.exited") {
        const c = cache.get(rt)
        if (c) c.dirty = true
      }
    })
  }
  const c = cache.get(rt)
  if (c && !c.dirty && Date.now() - c.at < 60_000) return c.rows
  const records = rt.store.listRuns(maxRuns).flatMap((r) => runRecords(rt.store.query({ runId: r.runId, types: SCORE_EVENT_TYPES })))
  const rows = scorecards(records)
  cache.set(rt, { rows, at: Date.now(), dirty: false })
  return rows
}

/** Installed, logged-in adapters worth considering for a task. */
export async function candidateAdapters(rt: Runtime): Promise<string[]> {
  const out: string[] = []
  for (const a of rt.registry.list()) {
    if (a.id === "mock" || a.id === "acp" || a.id === "exec") continue
    const d = await rt.registry.detect(a.id)
    if (d?.installed && d.auth !== "missing") out.push(a.id)
  }
  return out.length ? out : ["mock"]
}

export async function pickForTask(rt: Runtime, task: string, candidates?: string[]) {
  return pickAgents(getScorecards(rt), task, candidates?.length ? candidates : await candidateAdapters(rt))
}
