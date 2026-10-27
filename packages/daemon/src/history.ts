/**
 * Run history: summaries of past runs (from the event store), Markdown/JSONL export, and
 * resume — restart a run's agents with their native session ids and re-adopt worktrees that
 * still hold unmerged work.
 */
import { existsSync } from "node:fs"
import { type FeedItem, formatCost, formatDuration, RunState } from "@batonsh/kernel"
import type { AgentInfo, BatonEvent } from "@batonsh/protocol"
import { mdToHtml } from "./md-html.ts"
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

/** What a run summary is made of; everything but the tool output, so big runs stay cheap. */
const SUMMARY_TYPES = ["run.ended", "agent.spawned", "agent.updated", "usage.updated", "tool.call", "turn.started", "workspace.merge"]

export function summarize(rt: Runtime, runId: string): RunSummary | undefined {
  const first = rt.store.query({ runId, limit: 1 })[0]
  if (!first) return undefined
  const events = rt.store.query({ runId, types: SUMMARY_TYPES })
  const st = fold(events)
  const diff = rt.store.diffTotals(runId)
  const merged = events.filter((e) => e.type === "workspace.merge" && e.data.status === "merged" && (e.data.files?.length ?? 0) > 0).length
  return {
    runId,
    startedAt: first.ts,
    endedAt: events.find((e) => e.type === "run.ended")?.ts,
    title: (firstPrompt(events) ?? "(no task)").split("\n")[0]!.slice(0, 120),
    agents: st.agents.size,
    adapters: [...new Set([...st.agents.values()].map((a) => a.adapter))],
    costUsd: st.totals.costUsd,
    toolCalls: st.totals.toolCalls,
    added: diff.added,
    removed: diff.removed,
    merged,
    current: runId === rt.runId,
  }
}

/** Past runs don't change: their summaries are kept in the store, keyed by their last event. */
export function listRunSummaries(rt: Runtime, limit = 30): RunSummary[] {
  const out: RunSummary[] = []
  for (const r of rt.store.listRuns(limit)) {
    const key = `summary:${r.runId}`
    if (r.runId !== rt.runId) {
      try {
        const cached = JSON.parse(rt.store.getKV(key) ?? "null") as { lastSeq: number; summary: RunSummary } | null
        if (cached?.lastSeq === r.lastSeq) {
          out.push({ ...cached.summary, current: false })
          continue
        }
      } catch {}
    }
    const s = summarize(rt, r.runId)
    if (!s) continue
    if (r.runId !== rt.runId) rt.store.setKV(key, JSON.stringify({ lastSeq: r.lastSeq, summary: s }))
    out.push(s)
  }
  return out
}

export function exportRun(rt: Runtime, runId: string, format: "md" | "jsonl" | "html"): string {
  const events = rt.store.query({ runId })
  if (format === "jsonl") return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`
  if (format === "html") return exportHtml(rt, runId, events)
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
        out.push(`- ▲ ${name(e.agentId)}: ${e.data.message}`)
        break
    }
  }
  return `${out.join("\n")}\n`
}

/** The events that say which agents a run had and how each one ended. */
const LIFECYCLE_TYPES = ["agent.spawned", "agent.updated", "agent.session", "agent.exited", "workspace.created", "workspace.removed", "run.ended"]
/** Runs from before 0.3.7 don't list their agents in run.ended: exits this close to it were the shutdown. */
const SHUTDOWN_WINDOW_MS = 15_000

interface PastAgent {
  info: AgentInfo
  session?: string
  workspace?: { path: string; branch?: string; base?: string; mode: string }
  exitedAt?: number
}

/**
 * The agents a resume brings back: the ones still running when the run ended (or when the
 * daemon died). Agents that were killed, failed or finished before that stay gone; an agent
 * spawned again under the same name counts once, as its latest self.
 */
export function resumableAgents(events: BatonEvent[]): { oldId: string; agent: PastAgent }[] {
  const agents = new Map<string, PastAgent>()
  let ended: { ts: number; agents?: string[] } | undefined
  for (const e of events) {
    const a = e.agentId ? agents.get(e.agentId) : undefined
    switch (e.type) {
      case "agent.spawned":
        agents.set(e.data.agentId, { info: { ...e.data } })
        break
      case "agent.updated":
        if (a) for (const [k, v] of Object.entries(e.data)) if (v !== undefined) (a.info as Record<string, unknown>)[k] = v
        break
      case "agent.session":
        if (a) a.session = e.data.sessionId
        break
      case "agent.exited":
        if (a) a.exitedAt ??= e.ts
        break
      case "workspace.created":
        if (a) a.workspace = e.data
        break
      case "workspace.removed":
        if (a && !e.data.kept) a.workspace = undefined
        break
      case "run.ended":
        ended = { ts: e.ts, agents: e.data.agents }
        break
    }
  }
  const alive = (id: string, a: PastAgent) => {
    if (ended?.agents) return ended.agents.includes(id)
    if (a.exitedAt === undefined) return true
    return !!ended && ended.ts - a.exitedAt <= SHUTDOWN_WINDOW_MS
  }
  const byName = new Map<string, { oldId: string; agent: PastAgent }>()
  for (const [oldId, agent] of agents) {
    if (!alive(oldId, agent)) continue
    // later spawns under the same name replace earlier ones
    byName.set(agent.info.isOrchestrator ? "\0lead" : agent.info.name.toLowerCase(), { oldId, agent })
  }
  return [...byName.values()]
}

/**
 * Resume a past run in the current daemon: the agents that were still running when it ended
 * come back with their native sessions (adapters that support resume) and their worktrees.
 * Only lifecycle events and each agent's latest events are read, so a big run resumes quickly.
 */
export async function resumeRun(rt: Runtime, runId: string): Promise<string[]> {
  const events = rt.store.query({ runId, types: LIFECYCLE_TYPES })
  if (!events.length) throw new Error(`no run ${runId}`)
  const history = (oldId: string, newId: string) => {
    // the old feed as the screen showed it, rebuilt from the agent's latest events only
    const st = new RunState()
    const spawned = events.find((e) => e.type === "agent.spawned" && e.data.agentId === oldId)
    if (spawned) st.apply(spawned)
    for (const e of rt.store.query({ runId, agentId: oldId, last: HISTORY_EVENTS })) st.apply(e)
    const items = st.feed(oldId).items.slice(-HISTORY_ITEMS).map(slimItem)
    if (items.length) rt.emit({ type: "agent.history", data: { fromRun: runId, items: items as unknown as Record<string, unknown>[] } }, newId)
  }
  const started: string[] = []
  const live = new Set([...rt.agents.values()].filter((a) => !a.closing).map((a) => a.info.name.toLowerCase()))
  for (const { oldId, agent } of resumableAgents(events)) {
    const info = agent.info
    if (info.isOrchestrator) {
      // a lead that hasn't done anything yet makes way for the resumed one (which remembers the conversation)
      const cur = rt.orchestrator()
      if (cur && !rt.state.feed(cur.info.agentId).items.some((it) => it.kind === "user" || it.kind === "message")) await rt.kill(cur.info.agentId)
      const lead = rt.orchestrator()
      if (!lead) {
        const a = await rt.spawn({ adapter: info.adapter, isOrchestrator: true, model: info.model, label: info.label, resumeId: agent.session })
        history(oldId, a.agentId)
        started.push(a.name)
      } else history(oldId, lead.info.agentId)
      continue
    }
    if (live.has(info.name.toLowerCase())) continue
    const ws = agent.workspace
    const adopt = ws?.mode === "worktree" && existsSync(ws.path) ? ws : undefined
    try {
      const a = await rt.spawn({
        adapter: info.adapter,
        name: info.name,
        label: info.label,
        model: info.model,
        role: info.role,
        approval: info.approval as never,
        resumeId: agent.session,
        adoptWorkspace: adopt ? { path: adopt.path, branch: adopt.branch, base: adopt.base } : undefined,
      })
      history(oldId, a.agentId)
      started.push(a.name)
    } catch (e) {
      rt.emit({ type: "log", data: { level: "warn", message: `resume ${info.name}: ${e instanceof Error ? e.message : e}` } })
    }
  }
  return started
}

/** How much of each agent's earlier conversation a resume brings back. */
const HISTORY_ITEMS = 150
/** The events read per agent to rebuild it (its latest ones). */
const HISTORY_EVENTS = 4000
/** History is for reading back: long outputs and diffs are cut to what a card shows. */
const HISTORY_OUTPUT = 2000
const HISTORY_DIFF_LINES = 60

function slimItem(it: FeedItem): FeedItem {
  if (it.kind !== "tool") return it
  return {
    ...it,
    ...(it.output && it.output.length > HISTORY_OUTPUT ? { output: it.output.slice(-HISTORY_OUTPUT) } : {}),
    diffs: it.diffs.map((d) => (d.lines.length > HISTORY_DIFF_LINES ? { ...d, lines: d.lines.slice(0, HISTORY_DIFF_LINES) } : d)),
  }
}

// ───────────────────────────── HTML export ─────────────────────────────

const BRAND: Record<string, string> = {
  claude: "#d97757",
  codex: "#9aa3b2",
  opencode: "#f5a623",
  gemini: "#4f8ef7",
  cursor: "#a78bfa",
  copilot: "#6cc644",
  goose: "#ff6f61",
  qwen: "#7c5cff",
  amp: "#f59e0b",
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c)

/** A run as one self-contained, shareable page: summary, then every agent's work on one timeline. */
function exportHtml(rt: Runtime, runId: string, events: BatonEvent[]): string {
  const st = fold(events)
  const s = summarize(rt, runId)
  // senders are recorded by id or by name
  const find = (ref?: string) => (ref ? (st.agents.get(ref) ?? st.findAgent(ref)) : undefined)
  const agentName = (id?: string) => (id ? (find(id)?.name ?? id) : "baton")
  const color = (id?: string) => {
    const a = find(id)
    if (!a) return "#8a93a5"
    if (a.isOrchestrator) return "#e8774e"
    const key = Object.keys(BRAND).find((k) => a.adapter.startsWith(k))
    return key ? (BRAND[key] as string) : "#7aa2f7"
  }
  const who = (id?: string) => `<span class="who" style="color:${color(id)}">${esc(agentName(id))}</span>`
  type Row = { ts: number; html: string }
  const rows: Row[] = []
  for (const [id] of st.agents) {
    for (const it of st.feed(id).items) {
      switch (it.kind) {
        case "user":
          if (it.text.startsWith("[baton]")) break
          rows.push({
            ts: it.ts,
            html: `<div class="ev user">${who(it.from && it.from !== "user" ? it.from : undefined).replace(">baton<", ">you<")} → ${who(id)}<div class="txt">${esc(it.text)}</div></div>`,
          })
          break
        case "message":
          if (it.role === "assistant" && it.text.trim())
            rows.push({ ts: it.ts, html: `<div class="ev msg">${who(id)}<div class="txt md">${mdToHtml(it.text)}</div></div>` })
          break
        case "tool": {
          const diffs = it.diffs
            .map(
              (d) =>
                `<div class="path">${esc(d.path)} <span class="add">+${d.added}</span> <span class="del">−${d.removed}</span></div><pre class="diff">${d.lines
                  .slice(0, 200)
                  .map((l) => `<span class="${l.kind}">${l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "} ${esc(l.text)}</span>`)
                  .join("\n")}</pre>`,
            )
            .join("")
          const body = diffs || (it.output ? `<pre>${esc(it.output.slice(-4000))}</pre>` : "")
          const mark = it.status === "completed" ? "✓" : it.status === "failed" ? "✗" : "●"
          const head = `${who(id)} <span class="st ${it.status}">${mark}</span> <code>${esc(it.title)}</code>${it.summary ? ` <span class="muted">${esc(it.summary)}</span>` : ""}`
          rows.push({ ts: it.ts, html: body ? `<details class="ev tool"><summary>${head}</summary>${body}</details>` : `<div class="ev tool">${head}</div>` })
          break
        }
        case "error":
          rows.push({ ts: it.ts, html: `<div class="ev err">${who(id)} ✗ ${esc(it.text)}</div>` })
          break
      }
    }
  }
  for (const m of st.bus) {
    if (m.kind === "heartbeat" || m.kind === "progress") continue
    rows.push({ ts: m.ts, html: `<div class="ev bus">⇄ ${who(m.from)} → ${who(m.to)} <span class="muted">${esc(m.body.split("\n")[0] ?? "")}</span></div>` })
  }
  for (const e of events) {
    if (
      e.type === "workspace.merge" &&
      (e.data.status === "merged" || e.data.status === "failed" || e.data.status === "conflict" || e.data.status === "undone")
    )
      rows.push({
        ts: e.ts,
        html: `<div class="ev merge ${e.data.status}">⎇ merge ${e.data.status} · ${who(e.agentId)}${e.data.files?.length ? ` <span class="muted">${esc(e.data.files.join(", "))}</span>` : ""}${e.data.detail ? `<div class="txt">${esc(e.data.detail)}</div>` : ""}</div>`,
      })
    if (e.type === "review.verdict")
      rows.push({
        ts: e.ts,
        html: `<div class="ev review">✎ review of ${who(e.data.author)} by ${who(e.data.reviewer)}: <b>${esc(e.data.verdict)}</b><div class="txt md">${mdToHtml(e.data.notes)}</div></div>`,
      })
  }
  rows.sort((a, b) => a.ts - b.ts)
  const agents = [...st.agents.values()]
    .map(
      (a) =>
        `<span class="chip" style="border-color:${color(a.agentId)}"><b style="color:${color(a.agentId)}">${esc(a.name)}</b> ${esc(a.adapter)}${a.model ? `/${esc(a.model)}` : ""}</span>`,
    )
    .join(" ")
  const title = s?.title ?? runId
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · baton</title>
<style>
:root{--bg:#0f1117;--panel:#171a22;--line:#2a2f3d;--text:#e6e8ee;--muted:#9aa3b2;--ok:#8bd17c;--err:#f07178;--warn:#e6c15a}
@media (prefers-color-scheme:light){:root{--bg:#f6f7f9;--panel:#fff;--line:#dfe3ea;--text:#1d2230;--muted:#5b6475;--ok:#2f8a3a;--err:#c8333d;--warn:#a77b00}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:900px;margin:0 auto;padding:28px 18px 60px}
h1{font-size:22px;margin:0 0 6px} .meta{color:var(--muted);font-size:14px} .logo{color:#e8774e;font-weight:800}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0} .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 12px}
.stat b{display:block;font-size:18px} .chip{display:inline-block;border:1px solid;border-radius:999px;padding:2px 10px;margin:2px;font-size:13px}
.ev{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px 12px;margin:8px 0}
.ev.bus,.ev.tool{background:transparent;border-style:dashed} .who{font-weight:700} .muted{color:var(--muted)}
.txt{white-space:pre-wrap;margin-top:4px} code{font:13px ui-monospace,Menlo,monospace} .txt.md{white-space:normal} .md p,.md ul,.md ol,.md pre{margin:4px 0} .md code{background:#8882;padding:1px 4px;border-radius:4px} .md pre{background:#8881;padding:8px;border-radius:6px;overflow:auto} .md blockquote{border-left:3px solid #8886;margin:4px 0;padding-left:10px}
summary{cursor:pointer} .st.completed{color:var(--ok)} .st.failed{color:var(--err)}
pre{font:12.5px/1.4 ui-monospace,Menlo,monospace;overflow:auto;background:var(--bg);border-radius:8px;padding:8px;margin:6px 0 0}
.diff .add{color:var(--ok)} .diff .del{color:var(--err)} .diff .ctx{color:var(--muted)} .path{margin-top:8px;font:13px ui-monospace,Menlo,monospace}
.add{color:var(--ok)} .del{color:var(--err)} .merge.merged{border-color:var(--ok)} .merge.failed,.merge.conflict,.err{border-color:var(--err)} .review{border-color:var(--warn)}
footer{margin-top:30px;color:var(--muted);font-size:13px}
</style></head><body><main>
<div class="meta"><span class="logo">baton</span> · ${esc(st.projectName || rt.state.projectName || "project")} · ${new Date(s?.startedAt ?? 0).toLocaleString()}${s?.endedAt && s.startedAt ? ` · ${formatDuration(s.endedAt - s.startedAt)}` : ""}</div>
<h1>${esc(title)}</h1>
<div class="stats">
<div class="stat"><b>${st.agents.size}</b>agents</div><div class="stat"><b>${st.totals.toolCalls}</b>tool calls</div>
<div class="stat"><b><span class="add">+${st.totals.added}</span> <span class="del">−${st.totals.removed}</span></b>lines</div>
<div class="stat"><b>${s?.merged ?? 0}</b>merges</div><div class="stat"><b>${esc(formatCost(st.totals.costUsd))}</b>cost</div>
</div>
<div>${agents}</div>
${rows.map((r) => r.html).join("\n")}
<footer>Exported from Baton · run ${esc(runId)}</footer>
</main></body></html>
`
}
