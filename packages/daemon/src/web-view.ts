/**
 * What the web view shows, worked out on the daemon (where it can be tested) so the page
 * only has to draw it:
 * - tool calls as a verb and a target ("Run" `npm test`, "Edit" src/app.ts), with Baton's own
 *   coordination calls (send_message, wait_for_results…) marked so the page can fold them away;
 * - messages Baton relays between agents ("[baton] Result from claude-4: …") as structured
 *   handoffs: who, what kind, the outcome, lines changed, acceptance checks — without the
 *   instructions meant for the agent;
 * - worktree and project paths shortened to the part that means something;
 * - command output without terminal escape codes.
 */
import { type AttentionItem, attentionItems, type FeedItem, type RunState } from "@batonsh/kernel"
import type { ToolKind } from "@batonsh/protocol"

// ───────────────────────────── text ─────────────────────────────

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "").replace(/\r(?!\n)/g, "\n")
}

/**
 * Paths inside Baton worktrees (…/worktrees/<project>-<hash>/<agent>/src/x.ts) and the project
 * (C:\Users\me\project\src\x.ts) as the part that means something: src/x.ts.
 */
export function shortenPaths(s: string, projectRoot?: string): string {
  let out = s.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/"'`]+[\\/])*?worktrees[\\/][^\s\\/"'`]+[\\/][^\s\\/"'`]+[\\/]?/g, "")
  if (projectRoot) {
    const variants = new Set([projectRoot, projectRoot.replace(/\\/g, "/"), projectRoot.replace(/\//g, "\\")])
    for (const v of variants) {
      if (v.length < 4) continue
      const re = new RegExp(`${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\\\/]?`, "gi")
      out = out.replace(re, "")
    }
  }
  return out
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const tail = (s: string, n: number) => (s.length > n ? `…${s.slice(-(n - 1))}` : s)

// ───────────────────────────── tools ─────────────────────────────

export interface ToolLook {
  verb: string
  target?: string
  /** Baton's own coordination calls (messages, waiting, merges): folded away by default. */
  coord?: boolean
}

/** What Baton's own MCP tools do, in words. */
const BATON_TOOLS: Record<string, string> = {
  send_message: "Message",
  wait_for_results: "Wait for results",
  read_inbox: "Check inbox",
  spawn_agent: "Start agent",
  kill_agent: "Stop agent",
  list_agents: "List agents",
  merge: "Merge",
  request_review: "Ask for review",
  submit_review: "Review",
  claim_files: "Claim files",
  release_files: "Release files",
  report_progress: "Report progress",
  note: "Note",
  get_diff: "Look at changes",
  update_task: "Update task",
  plan_tasks: "Plan tasks",
  sync: "Sync with project",
  ask_user: "Ask you",
}

function unwrapShell(cmd: string): string {
  // "C:\...\powershell.exe" -Command '...'  ·  bash -lc "..."  ·  cmd /c ...
  const ps = /^"?[^"]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-(?:Command|c)\s+(['"]?)([\s\S]*)\1\s*$/i.exec(cmd)
  if (ps) return ps[2] ?? cmd
  const sh = /^(?:\/\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd)
  if (sh) return sh[2] ?? cmd
  const c = /^cmd(?:\.exe)?\s+\/[cC]\s+([\s\S]*)$/.exec(cmd)
  return c ? (c[1] ?? cmd) : cmd
}

const inputCommand = (input: unknown): string | undefined => {
  const o = input as { command?: unknown; cmd?: unknown } | undefined
  const c = o?.command ?? o?.cmd
  return typeof c === "string" ? c : Array.isArray(c) ? c.join(" ") : undefined
}

export function describeTool(t: { name: string; title: string; toolKind?: ToolKind; input?: unknown }, projectRoot?: string): ToolLook {
  const short = (s: string) => shortenPaths(s, projectRoot).trim()
  const name = t.name
  const title = t.title.trim()
  // Baton's coordination tools, however the agent names them
  const baton = /^mcp__baton__(\w+)$/.exec(name) ?? /^baton(?:\s+-\s+|\.)(\w+)/.exec(title)
  if (baton) {
    const id = baton[1] ?? ""
    return { verb: BATON_TOOLS[id] ?? id.replace(/_/g, " "), coord: true }
  }
  const mcp = /^(.+?)\s+-\s+(.+?)\s+\(MCP\)$/.exec(title)
  if (mcp) return { verb: (mcp[2] ?? "").replace(/_/g, " "), target: mcp[1] }
  if (name === "acceptance" || title.startsWith("Acceptance: ")) return { verb: "Check", target: short(title.replace(/^Acceptance:\s*/, "")) }
  const call = /^([A-Za-z][\w ]*?)\(([\s\S]*)\)$/.exec(title)
  if (call) {
    const fn = call[1] ?? ""
    const arg = short(call[2] ?? "")
    switch (fn) {
      case "Bash":
      case "Shell":
        return { verb: "Run", target: short(unwrapShell(inputCommand(t.input) ?? arg)) }
      case "Read":
        return { verb: "Read", target: arg }
      case "Write":
        return { verb: "Write", target: arg }
      case "Update":
      case "Edit":
      case "MultiEdit":
        return { verb: "Edit", target: arg }
      case "WebSearch":
        return { verb: "Search the web", target: arg }
      case "Fetch":
      case "WebFetch":
        return { verb: "Fetch", target: arg }
      case "Grep":
      case "Search":
        return { verb: "Search", target: arg }
      case "Glob":
        return { verb: "Find files", target: arg }
      default:
        return { verb: fn, target: arg || undefined }
    }
  }
  if (/^"?[^"\s]*(?:powershell|pwsh)(?:\.exe)?"?\s+-/i.test(title) || name === "PowerShell" || name === "shell" || name === "exec_command") {
    const cmd = inputCommand(t.input) ?? (title === name ? "" : title)
    return { verb: "Run", target: short(unwrapShell(cmd)) || undefined }
  }
  const ran = /^(Ran|Run|Running)\s+([\s\S]+)$/.exec(title)
  if (ran) return { verb: "Run", target: short(unwrapShell(ran[2] ?? "")) }
  const edit = /^(Edit|Edited|Editing|Write|Wrote|Create|Created|Delete|Deleted)\s+([\s\S]+)$/.exec(title)
  if (edit)
    return { verb: /^(Write|Wrote|Create)/.test(edit[1] ?? "") ? "Write" : /^Delete/.test(edit[1] ?? "") ? "Delete" : "Edit", target: short(edit[2] ?? "") }
  if (t.toolKind === "execute") return { verb: "Run", target: short(unwrapShell(inputCommand(t.input) ?? title)) }
  return { verb: short(title) || name }
}

// ───────────────────────────── relayed messages ─────────────────────────────

export interface Handoff {
  from: string
  kind: string
  text: string
  outcome?: "ok" | "failed" | "interrupted"
  diff?: { added: number; removed: number }
  checks?: { command: string; ok: boolean; detail?: string }[]
  /** The worker's changes wait in its worktree for a merge. */
  unmerged?: boolean
}

/** A result body ("result ok (+12 −5)\n…\nacceptance ✓ `cmd` passed\n[changes are in …]") taken apart. */
export function parseBody(from: string, kind: string, body: string): Handoff {
  const h: Handoff = { from, kind, text: body }
  let text = body
  const res = /^result (ok|failed|interrupted)(?: \(\+(\d+) −(\d+)\))?\n?/.exec(text)
  if (res) {
    h.kind = "result"
    h.outcome = res[1] as Handoff["outcome"]
    if (res[2]) h.diff = { added: Number(res[2]), removed: Number(res[3]) }
    text = text.slice(res[0].length)
  }
  const checks: NonNullable<Handoff["checks"]> = []
  text = text.replace(/\n?acceptance ✓ `([^`]+)` passed/g, (_m, cmd: string) => {
    checks.push({ command: cmd, ok: true })
    return ""
  })
  text = text.replace(
    /\n?acceptance ✗ `([^`]+)` (still failing[^\n]*)(?::\n([\s\S]*?))?(?=\n\[changes are in|$)/g,
    (_m, cmd: string, why: string, out?: string) => {
      checks.push({ command: cmd, ok: false, detail: `${why}${out ? `\n${out}` : ""}` })
      return ""
    },
  )
  if (checks.length) h.checks = checks
  text = text.replace(/\n?\[changes are in [^\]]*'s own worktree — call merge\("[^"]*"\) to bring them into the project\]/g, () => {
    h.unmerged = true
    return ""
  })
  h.text = text.trim()
  return h
}

/**
 * Text an agent was given, as the person reading it wants it: a prompt from you is just
 * text; anything Baton relayed between agents becomes one or more handoffs.
 */
export function parseRelay(text: string): { from?: string; handoffs?: Handoff[]; text: string } {
  let t = text.replace(/\r\n/g, "\n")
  let from: string | undefined
  const via = /^\[message from ([^\]\n]+)\]\n/.exec(t)
  if (via) {
    from = via[1]
    t = t.slice(via[0].length)
  }
  // the instructions Baton appends for the agent
  t = t.replace(/\n*\(Reply with the baton send_message tool[^)]*\)\s*$/, "")
  const one = /^\[baton\] (Result|Message) from ([^:\n]+):\n/.exec(t)
  if (one) {
    const who = one[2] ?? from ?? "agent"
    return { from: who, handoffs: [parseBody(who, one[1] === "Result" ? "result" : "message", t.slice(one[0].length))], text: t }
  }
  const many = /^\[baton\] \d+ messages:\n\n/.exec(t)
  if (many) {
    const parts = t.slice(many[0].length).split(/\n\n(?=— from )/)
    const handoffs = parts
      .map((p) => {
        const m = /^— from ([^\n(]+?) \((\w+)\):\n?/.exec(p)
        return m ? parseBody(m[1] ?? "agent", m[2] ?? "message", p.slice(m[0].length)) : undefined
      })
      .filter((x): x is Handoff => !!x)
    if (handoffs.length) return { from, handoffs, text: t }
  }
  if (t.startsWith("[baton] ")) return { from: from ?? "baton", handoffs: [{ from: "baton", kind: "system", text: t.slice(8).trim() }], text: t }
  return { from, text: t }
}

// ───────────────────────────── feed items ─────────────────────────────

export type WebItem =
  | { k: "text"; id: string; role: "assistant" | "thought"; text: string; done: boolean; ts: number }
  | { k: "prompt"; id: string; text: string; from?: string; ts: number }
  | { k: "handoff"; id: string; to?: string; h: Handoff; ts: number }
  | {
      k: "tool"
      id: string
      tk: ToolKind
      verb: string
      target?: string
      coord?: boolean
      status: string
      summary?: string
      output?: string
      exit?: number | null
      diffs: { path: string; added: number; removed: number; lines: [kind: "a" | "d" | "c", text: string][]; more: number }[]
      parent?: string
      ts: number
    }
  | { k: "ask"; id: string; text: string; resolved?: string; ts: number }
  | { k: "note" | "error"; id: string; text: string; ts: number }

export interface ViewContext {
  projectRoot?: string
  name: (id: string) => string
}

const MAX_TEXT = 16_000
const MAX_OUTPUT = 6_000
const MAX_DIFF_LINES = 120

export function webItem(it: FeedItem, ctx: ViewContext): WebItem[] {
  const short = (s: string) => shortenPaths(s, ctx.projectRoot)
  switch (it.kind) {
    case "message":
      return it.text.trim() ? [{ k: "text", id: it.id, role: it.role, text: tail(it.text, MAX_TEXT), done: it.done, ts: it.ts }] : []
    case "user": {
      const r = parseRelay(it.text)
      if (r.handoffs) return r.handoffs.map((h, i) => ({ k: "handoff" as const, id: `${it.id}:${i}`, h: { ...h, text: clip(h.text, MAX_TEXT) }, ts: it.ts }))
      const from = it.from ? ctx.name(it.from) : r.from
      return [{ k: "prompt", id: it.id, text: clip(r.text, MAX_TEXT), from: from && from !== "you" && from !== "user" ? from : undefined, ts: it.ts }]
    }
    case "tool": {
      const look = describeTool({ name: it.name, title: it.title, toolKind: it.toolKind, input: it.input }, ctx.projectRoot)
      return [
        {
          k: "tool",
          id: it.id,
          tk: it.toolKind,
          verb: look.verb,
          target: look.target ? clip(look.target, 600) : undefined,
          coord: look.coord,
          status: it.status,
          summary: it.summary ? clip(short(it.summary), 200) : undefined,
          output: it.output ? tail(short(stripAnsi(it.output)), MAX_OUTPUT) : undefined,
          exit: it.exitCode,
          parent: it.parentId,
          diffs: it.diffs.slice(0, 8).map((d) => {
            const lines = d.lines.map((l): [kind: "a" | "d" | "c", text: string] => [l.kind === "add" ? "a" : l.kind === "del" ? "d" : "c", l.text])
            return {
              path: short(d.path),
              added: d.added,
              removed: d.removed,
              lines: lines.slice(0, MAX_DIFF_LINES),
              more: Math.max(0, lines.length - MAX_DIFF_LINES),
            }
          }),
          ts: it.ts,
        },
      ]
    }
    case "bus": {
      const h = parseBody(ctx.name(it.from), "message", it.body)
      return [{ k: "handoff", id: it.id, to: ctx.name(it.to), h: { ...h, text: clip(h.text, MAX_TEXT) }, ts: it.ts }]
    }
    case "permission":
      return [{ k: "ask", id: it.id, text: short(it.title), resolved: it.resolved, ts: it.ts }]
    case "error":
      return [{ k: "error", id: it.id, text: short(it.text), ts: it.ts }]
    case "note":
      return [{ k: "note", id: it.id, text: short(it.text), ts: it.ts }]
  }
}

// ───────────────────────────── the view ─────────────────────────────

/** Items per feed sent to the page (the newest). */
const FEED_ITEMS = 150

export interface ViewOptions {
  projectRoot?: string
  /** Per connection: the feed version last sent for each agent; only changed feeds are sent again. */
  sent?: Map<string, number>
}

export function buildView(s: RunState, opts: ViewOptions = {}) {
  const name = (id: string) =>
    id === "user" ? "you" : id === s.orchestratorId ? "lead" : (s.agents.get(id)?.name ?? s.findAgent(id)?.name ?? (id === "baton" ? "baton" : id))
  const ctx: ViewContext = { projectRoot: opts.projectRoot ?? s.projectRoot, name }
  const feeds: Record<string, WebItem[]> = {}
  const shown = [...s.agents.values()].filter((a) => a.isOrchestrator || a.status !== "exited" || s.workspaces.get(a.agentId)?.files.length)
  for (const a of shown) {
    const v = s.agentVersions.get(a.agentId) ?? 0
    if (opts.sent && opts.sent.get(a.agentId) === v) continue
    opts.sent?.set(a.agentId, v)
    feeds[a.agentId] = s
      .feed(a.agentId)
      .items.slice(-FEED_ITEMS)
      .flatMap((it) => webItem(it, ctx))
  }
  const lead = s.orchestratorId
  const attention = attentionItems(s).map((a: AttentionItem) => {
    const p = a.requestId ? s.approvals.get(a.requestId) : undefined
    return {
      ...a,
      title: shortenPaths(a.title, ctx.projectRoot),
      detail: (a.detail ?? p?.detail) ? shortenPaths((a.detail ?? p?.detail) as string, ctx.projectRoot) : undefined,
      agent: a.agentId ? name(a.agentId) : undefined,
      toolKind: p?.kind,
      options: p?.options,
    }
  })
  return {
    v: 2,
    project: s.projectName,
    branch: s.branch,
    autonomy: s.autonomy,
    mode: s.mode,
    viewers: [...new Set(s.viewers.map((v) => v.name))],
    totals: s.totals,
    lead: lead ? agentOf(s, lead) : undefined,
    agents: shown.filter((a) => !a.isOrchestrator).map((a) => agentOf(s, a.agentId)),
    attention,
    plan: s.plan ? { status: s.plan.status, notes: s.plan.notes } : undefined,
    tasks: [...s.tasks.values()].map((t) => ({ id: t.taskId, title: t.title, state: t.state, owner: t.owner ? name(t.owner) : undefined })),
    // the conversation between agents, without the heartbeats
    bus: s.bus
      .filter((m) => m.kind !== "heartbeat" && m.kind !== "progress")
      .slice(-120)
      .map((m) => ({ id: m.messageId, from: name(m.from), to: name(m.to), kind: m.kind, h: parseBody(name(m.from), m.kind, clip(m.body, 4000)), ts: m.ts })),
    feeds,
    now: Date.now(),
  }
}

function agentOf(s: RunState, id: string) {
  const a = s.agents.get(id)!
  const ws = s.workspaces.get(id)
  return {
    id,
    name: a.name,
    adapter: a.adapter,
    model: a.model,
    label: a.label,
    role: a.role,
    lead: !!a.isOrchestrator,
    status: a.status,
    detail: a.statusDetail,
    approval: a.approval,
    access: a.access,
    cost: a.usage.costUsd,
    tokens: a.usage.input + a.usage.output,
    toolCalls: a.toolCalls,
    diff: a.diff,
    progress: a.progress,
    startedAt: a.startedAt,
    turnStartedAt: a.turnStartedAt,
    lastEventAt: a.lastEventAt,
    activity: activityOf(s, id),
    attention: a.attention?.reason,
    workspace: ws
      ? {
          mode: ws.mode,
          branch: ws.branch,
          files: ws.files.slice(0, 200),
          added: ws.added,
          removed: ws.removed,
          merge: ws.merge ? { status: ws.merge.status, detail: ws.merge.detail } : undefined,
          conflicts: ws.conflicts.map((c) => ({ with: s.agents.get(c.with)?.name ?? c.with, files: c.files.slice(0, 20) })),
          review: ws.review,
        }
      : undefined,
  }
}

/** An agent's latest action in the same words as its feed (its last tool call, input and all). */
function activityOf(s: RunState, id: string): string | undefined {
  const title = s.agents.get(id)?.lastActivity
  if (!title) return undefined
  if (title === "writing") return "Writing"
  const items = s.feed(id).items
  let tool: Extract<FeedItem, { kind: "tool" }> | undefined
  for (let i = items.length - 1; i >= 0 && i >= items.length - 40; i--) {
    const it = items[i]
    if (it?.kind === "tool") {
      tool = it
      break
    }
  }
  const look = tool
    ? describeTool({ name: tool.name, title: tool.title, toolKind: tool.toolKind, input: tool.input }, s.projectRoot)
    : describeTool({ name: title, title }, s.projectRoot)
  return clip(look.target ? `${look.verb} ${look.target}` : look.verb, 160)
}

export type WebView = ReturnType<typeof buildView>
