/**
 * Feed → styled lines. Pure functions (no OpenTUI), so every visual decision is unit-testable.
 *
 * Two native looks, mirroring the agents' own CLIs:
 *   claude  ● Read(LoginButton.tsx)        codex  • Ran git diff --stat
 *           ⎿  Read 314 lines                     └ 1 file +1 -1
 */
import type { AgentView } from "@batonsh/protocol"
import type { FeedItem } from "@batonsh/kernel"
import { formatClock, formatDuration, formatTokens } from "@batonsh/kernel"
import type { ResolvedTheme } from "@batonsh/themes"

export interface Seg {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  italic?: boolean
  dim?: boolean
  underline?: boolean
}

export interface Line {
  segs: Seg[]
  /** Fill the remaining width with this background (diff rows). */
  bg?: string
}

export type LookStyle = "claude" | "codex"

export interface RenderCtx {
  theme: ResolvedTheme
  width: number
  look: LookStyle
  showThoughts: boolean
  /** Max diff rows per tool call (Infinity in zoom view). */
  maxDiffLines: number
  /** Max output rows per tool call. */
  maxOutputLines: number
  /** Resolve agent ids / names to display names + colors (for bus lines). */
  who: (idOrName: string) => { name: string; color: string }
  compact?: boolean
}

export const width = (s: string): number => Bun.stringWidth(s)

/** Truncate to a display width, adding an ellipsis. */
export function clip(s: string, w: number): string {
  if (w <= 0) return ""
  if (width(s) <= w) return s
  let out = ""
  let used = 0
  for (const ch of s) {
    const cw = width(ch)
    if (used + cw > w - 1) break
    out += ch
    used += cw
  }
  return `${out}…`
}

/** Word-wrap one paragraph to `w` display columns (hard-breaks long words). */
export function wrap(text: string, w: number): string[] {
  if (w <= 1) return [text]
  const out: string[] = []
  for (const para of text.replace(/\t/g, "  ").split("\n")) {
    if (para.length === 0) {
      out.push("")
      continue
    }
    let line = ""
    let lw = 0
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue
      const ww = width(word)
      if (lw + ww <= w) {
        line += word
        lw += ww
        continue
      }
      if (/^\s+$/.test(word)) {
        out.push(line)
        line = ""
        lw = 0
        continue
      }
      if (line.trim()) out.push(line.trimEnd())
      line = ""
      lw = 0
      if (ww <= w) {
        line = word
        lw = ww
      } else {
        for (const ch of word) {
          const cw = width(ch)
          if (lw + cw > w) {
            out.push(line)
            line = ""
            lw = 0
          }
          line += ch
          lw += cw
        }
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

export function lineWidth(l: Line): number {
  let n = 0
  for (const s of l.segs) n += width(s.text)
  return n
}

/** Clip a styled line to `w` columns. */
export function clipLine(l: Line, w: number): Line {
  if (lineWidth(l) <= w) return l
  const segs: Seg[] = []
  let used = 0
  for (const s of l.segs) {
    const sw = width(s.text)
    if (used + sw <= w - 1) {
      segs.push(s)
      used += sw
      continue
    }
    segs.push({ ...s, text: clip(s.text, w - used) })
    break
  }
  return { ...l, segs }
}

// ───────────────────────────── helpers ─────────────────────────────

function splitTitle(title: string): { name: string; args: string } {
  const m = /^([\w.\- ]+?)\((.*)\)$/s.exec(title.trim())
  if (m) return { name: m[1] as string, args: m[2] as string }
  return { name: title, args: "" }
}

const CODEX_VERBS: Record<string, string> = {
  execute: "Ran",
  edit: "Edited",
  read: "Read",
  search: "Searched",
  fetch: "Fetched",
  delegate: "Delegated",
  think: "Thought",
  delete: "Deleted",
  move: "Moved",
}

function statusColor(t: ResolvedTheme, status: string): string {
  if (status === "completed") return t.success
  if (status === "failed") return t.error
  return t.textMuted
}

function batonToolTitle(item: Extract<FeedItem, { kind: "tool" }>): { name: string; args: string; extra: string[] } | undefined {
  const n = item.name.replace(/^mcp__baton__/, "").replace(/^baton[_ -]+/, "")
  const isBaton = item.name.startsWith("mcp__baton__") || /^baton\b/.test(item.name) || /^baton - /.test(item.title)
  if (!isBaton) return undefined
  const input = (item.input ?? {}) as Record<string, unknown>
  const tool = /send_message|spawn_agent|wait_for_results|list_agents|read_inbox|report_progress|interrupt_agent|kill_agent|set_label/.exec(
    `${n} ${item.title}`,
  )?.[0]
  const extra: string[] = []
  switch (tool) {
    case "spawn_agent": {
      const count = typeof input.count === "number" && input.count > 1 ? ` ×${input.count}` : ""
      const model = input.model ? ` · ${input.model}` : ""
      const spawned = /spawned: ([^\n(]+)/.exec(item.output ?? "")?.[1]
      if (spawned) for (const nm of spawned.split(",").map((s) => s.trim())) extra.push(`${nm}${input.label ? ` ${input.label}` : ""}`)
      return { name: "Task", args: `spawn ${input.adapter ?? "agent"}${count}${model}`, extra }
    }
    case "send_message":
      return { name: "Message", args: `→ ${input.to ?? "?"}`, extra: input.body ? [String(input.body)] : [] }
    case "wait_for_results":
      return { name: "Wait", args: Array.isArray(input.agents) ? (input.agents as string[]).join(", ") : "results", extra }
    case "list_agents":
      return { name: "Agents", args: "", extra }
    case "read_inbox":
      return { name: "Inbox", args: "", extra }
    case "report_progress":
      return { name: "Progress", args: `${input.percent ?? "?"}%`, extra }
    case "interrupt_agent":
      return { name: "Interrupt", args: String(input.name ?? ""), extra }
    case "kill_agent":
      return { name: "Kill", args: String(input.name ?? ""), extra }
    case "set_label":
      return { name: "Label", args: `${input.name ?? ""}: ${input.label ?? ""}`, extra }
    default:
      return undefined
  }
}

// ───────────────────────────── feed rendering ─────────────────────────────

export function renderFeed(items: readonly FeedItem[], ctx: RenderCtx): Line[] {
  const out: Line[] = []
  for (const it of items) renderItem(it, ctx, out)
  return out
}

export function renderItem(it: FeedItem, ctx: RenderCtx, out: Line[]): void {
  const t = ctx.theme
  const w = Math.max(8, ctx.width)
  const claude = ctx.look === "claude"
  switch (it.kind) {
    case "user": {
      // messages delivered by the bus render as bus lines, not as typed prompts
      const bus = /^\[baton\] (Message|Result) from ([^:\n]+):\n([\s\S]*?)(?:\n\n\(Reply with[\s\S]*)?$/.exec(it.text)
      if (bus) {
        const from = ctx.who(bus[2] as string)
        const body = (bus[3] ?? "").split("\n")[0] ?? ""
        out.push(
          clipLine(
            {
              segs: [
                { text: "⇄ ", fg: t.textMuted },
                { text: from.name, fg: from.color },
                { text: bus[1] === "Result" ? " ⏎ " : " → ", fg: t.textMuted },
                { text: body, fg: bus[1] === "Result" ? t.success : t.text },
              ],
            },
            w,
          ),
        )
        return
      }
      const prefix = claude ? "> " : "› "
      const lines = wrap(it.text.replace(/^\[baton\]\s*/, ""), w - 2)
      lines.slice(0, ctx.compact ? 2 : 12).forEach((l, i) =>
        out.push({ segs: [{ text: i === 0 ? prefix : "  ", fg: t.textMuted }, { text: l, fg: t.text, bold: true }] }),
      )
      return
    }
    case "message": {
      if (it.role === "thought") {
        if (!ctx.showThoughts) return
        const lines = wrap(it.text, w - 2)
        lines.slice(-6).forEach((l, i) => out.push({ segs: [{ text: i === 0 ? "✻ " : "  ", fg: t.thought }, { text: l, fg: t.thought, italic: true }] }))
        return
      }
      const text = it.text.trim()
      if (!text) return
      const lines = wrap(text, w - 2)
      const shown = ctx.compact ? lines.slice(-4) : lines
      shown.forEach((l, i) =>
        out.push({
          segs: [{ text: i === 0 && shown.length === lines.length ? (claude ? "● " : "• ") : "  ", fg: claude ? t.text : t.textMuted }, { text: l, fg: t.text }],
        }),
      )
      return
    }
    case "tool":
      renderTool(it, ctx, out)
      return
    case "bus": {
      const from = ctx.who(it.from)
      const to = ctx.who(it.to)
      const head = [
        { text: "⇄ ", fg: t.textMuted },
        { text: from.name, fg: from.color },
        { text: " → ", fg: t.textMuted },
        { text: to.name, fg: to.color },
        { text: "  ", fg: t.textMuted },
      ]
      const headW = head.reduce((n, s) => n + width(s.text), 0)
      const body = wrap(it.body.split("\n")[0] ?? "", Math.max(8, w - headW))
      out.push({ segs: [...head, { text: body[0] ?? "", fg: t.textMuted }] })
      return
    }
    case "permission": {
      if (it.resolved) {
        const ok = it.resolved.startsWith("allow")
        out.push({ segs: [{ text: ok ? "✓ " : "✗ ", fg: ok ? t.success : t.error }, { text: clip(`${it.title} — ${it.resolved}`, w - 2), fg: t.textMuted }] })
      } else {
        out.push({ segs: [{ text: "? ", fg: t.warning, bold: true }, { text: clip(it.title, w - 12), fg: t.warning, bold: true }, { text: " — allow?", fg: t.warning }] })
        out.push({ segs: [{ text: "  ctrl+a to review · /approve · /deny", fg: t.textMuted }] })
      }
      return
    }
    case "error":
      for (const l of wrap(it.text, w - 2).slice(0, 4)) out.push({ segs: [{ text: "✗ ", fg: t.error }, { text: l, fg: t.error }] })
      return
    case "note":
      out.push({ segs: [{ text: "· ", fg: t.textMuted }, { text: clip(it.text, w - 2), fg: t.textMuted, italic: true }] })
      return
  }
}

function renderTool(it: Extract<FeedItem, { kind: "tool" }>, ctx: RenderCtx, out: Line[]) {
  const t = ctx.theme
  const w = Math.max(8, ctx.width)
  const claude = ctx.look === "claude"
  const indent = it.parentId ? "  " : ""
  const baton = batonToolTitle(it)
  let name: string
  let args: string
  if (baton) {
    name = baton.name
    args = baton.args
  } else if (claude) {
    const s = splitTitle(it.title)
    name = s.name
    args = s.args
  } else {
    const verb = CODEX_VERBS[it.toolKind]
    const s = splitTitle(it.title)
    const raw = s.args || s.name
    if (verb && !raw.startsWith(verb)) {
      name = verb
      args = raw
    } else {
      const [first, ...rest] = raw.split(" ")
      name = first ?? raw
      args = rest.join(" ")
    }
  }
  const dot = claude ? "● " : "• "
  const dotColor = statusColor(t, it.status)
  const head: Seg[] = [
    { text: indent + dot, fg: it.status === "pending" || it.status === "in_progress" ? t.textMuted : dotColor },
    { text: name, fg: t.toolName, bold: true },
  ]
  if (args) head.push(claude && !baton ? { text: `(${args})`, fg: t.toolArgs } : claude ? { text: `(${args})`, fg: t.toolArgs } : { text: ` ${args}`, fg: t.toolArgs })
  out.push(clipLine({ segs: head }, w))

  const branch = claude ? "⎿  " : "└ "
  const sub = (text: string, fg = t.textMuted) => out.push(clipLine({ segs: [{ text: `${indent}  ${branch}`, fg: t.textSubtle }, { text, fg }] }, w))

  if (baton) {
    for (const e of baton.extra.slice(0, ctx.compact ? 3 : 10)) out.push(clipLine({ segs: [{ text: `${indent}  → `, fg: t.textMuted }, { text: e, fg: t.text }] }, w))
    if (it.status === "failed" && it.output) sub(it.output.split("\n")[0] ?? "", t.error)
    return
  }

  // diffs
  let diffShown = 0
  for (const d of it.diffs) {
    const numW = Math.max(3, String(Math.max(0, ...d.lines.map((l) => l.newLine ?? l.oldLine ?? 0))).length)
    for (const l of d.lines) {
      if (l.kind === "ctx" && Number.isFinite(ctx.maxDiffLines) && ctx.maxDiffLines < 12) continue
      if (diffShown >= ctx.maxDiffLines) break
      const ln = String(l.kind === "del" ? (l.oldLine ?? "") : (l.newLine ?? l.oldLine ?? "")).padStart(numW)
      const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "
      const bg = l.kind === "add" ? t.diffAddedBg : l.kind === "del" ? t.diffRemovedBg : undefined
      const fg = l.kind === "add" ? t.diffAdded : l.kind === "del" ? t.diffRemoved : t.diffContext
      out.push(clipLine({ segs: [{ text: `${ln} ${sign} `, fg: l.kind === "ctx" ? t.diffLineNumber : fg, bg }, { text: l.text, fg, bg }], bg }, w))
      diffShown++
    }
  }
  const hidden = it.diffs.reduce((n, d) => n + d.lines.filter((l) => l.kind !== "ctx").length, 0) - diffShown
  if (it.summary) sub(hidden > 0 && !it.summary.includes("lines") ? `${it.summary} (+${hidden} more)` : it.summary)
  else if (it.status === "failed") sub("failed", t.error)

  // terminal output (codex look shows it; claude look only when no summary)
  if (it.output && it.toolKind === "execute" && (!claude || !it.summary)) {
    const lines = it.output.split("\n").filter((l) => l.trim())
    const take = lines.slice(0, ctx.maxOutputLines)
    for (const l of take) if (l.trim() !== it.summary?.trim()) sub(l, it.exitCode && it.exitCode !== 0 ? t.error : t.textMuted)
  }
}

// ───────────────────────────── status / identity lines ─────────────────────────────

export function spinnerVerb(agent: AgentView, verbs: readonly string[]): string {
  let h = 2166136261
  const key = `${agent.agentId}:${agent.turnStartedAt ?? 0}`
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619)
  return verbs[(h >>> 0) % verbs.length] ?? "Working"
}

export function statusLine(
  agent: AgentView,
  ctx: { theme: ResolvedTheme; look: LookStyle; frame: string; verbs: readonly string[]; now: number; orchestrator?: boolean; subagents?: number },
): Line {
  const t = ctx.theme
  const tokens = agent.usage.input + agent.usage.output
  if (agent.status === "busy") {
    const elapsed = agent.turnStartedAt ? formatDuration(ctx.now - agent.turnStartedAt) : "0s"
    const verb = ctx.orchestrator ? "Orchestrating" : ctx.look === "claude" ? spinnerVerb(agent, ctx.verbs) : "Working"
    const parts = [elapsed]
    if (ctx.orchestrator && ctx.subagents) parts.push(`${ctx.subagents} subagents`)
    else parts.push(`↓ ${formatTokens(tokens)}`)
    if (ctx.orchestrator) parts.push("esc to interrupt")
    return {
      segs: [
        { text: `${ctx.frame} `, fg: t.spinner },
        { text: `${verb}${ctx.look === "claude" ? "…" : ""}`, fg: ctx.look === "claude" ? t.spinner : t.text, bold: ctx.look !== "claude" },
        { text: ` (${parts.join(" · ")})`, fg: t.textMuted },
      ],
    }
  }
  if (agent.status === "awaiting_approval") return { segs: [{ text: "◆ ", fg: t.stateWaiting }, { text: "Waiting for approval", fg: t.stateWaiting, bold: true }, { text: " · ctrl+a", fg: t.textMuted }] }
  if (agent.status === "starting") return { segs: [{ text: `${ctx.frame} `, fg: t.textMuted }, { text: "starting…", fg: t.textMuted }] }
  if (agent.status === "error") return { segs: [{ text: "✗ ", fg: t.stateError }, { text: agent.statusDetail ?? "error", fg: t.stateError }] }
  if (agent.status === "exited") return { segs: [{ text: "■ ", fg: t.textSubtle }, { text: `exited${agent.statusDetail ? ` · ${agent.statusDetail}` : ""}`, fg: t.textSubtle }] }
  const extra = tokens > 0 ? ` · ↓ ${formatTokens(tokens)}` : ""
  return { segs: [{ text: "◌ ", fg: t.stateIdle }, { text: `idle · ready${extra}`, fg: t.textMuted }] }
}

const ADAPTER_TITLES: Record<string, string> = {
  claude: "Claude Code",
  codex: "OpenAI Codex",
  opencode: "OpenCode",
  gemini: "Gemini CLI",
  cursor: "Cursor Agent",
  copilot: "GitHub Copilot",
  mock: "Mock Agent",
}

export function identityLines(agent: AgentView, ctx: { theme: ResolvedTheme; glyph: string; fields: readonly string[]; home: string; title?: string }): Line[] {
  const t = ctx.theme
  const out: Line[] = [{ segs: [{ text: `${ctx.glyph} `, fg: t.textMuted }, { text: ctx.title ?? ADAPTER_TITLES[agent.adapter] ?? agent.adapter, fg: t.text, bold: true }] }]
  const dir = agent.cwd.startsWith(ctx.home) ? `~${agent.cwd.slice(ctx.home.length)}` : agent.cwd
  const values: Record<string, string | undefined> = {
    adapter: undefined,
    version: agent.version ? `v${agent.version.replace(/^v/, "")}` : undefined,
    model: agent.model,
    dir,
    approval: agent.approval,
    role: agent.role,
    session: agent.sessionId?.slice(0, 12),
  }
  for (const f of ctx.fields) {
    const v = values[f]
    if (v) out.push({ segs: [{ text: `${f}: `, fg: t.textMuted }, { text: v, fg: t.textMuted }] })
  }
  return out
}

export function busLine(
  m: { ts: number; from: string; to: string; kind: string; body: string },
  ctx: { theme: ResolvedTheme; width: number; who: RenderCtx["who"]; clock: "ss.mmm" | "hh:mm:ss" | "relative"; now: number; short?: boolean },
): Line {
  const t = ctx.theme
  const from = ctx.who(m.from)
  const to = ctx.who(m.to)
  const body = m.kind === "heartbeat" ? "heartbeat" : (m.body.split("\n")[0] ?? "")
  return clipLine(
    {
      segs: [
        { text: `${formatClock(m.ts, ctx.clock, ctx.now)} `, fg: t.busTime },
        { text: from.name, fg: t.busFrom },
        { text: "→", fg: t.textMuted },
        { text: to.name, fg: t.busTo },
        { text: ` ${body}`, fg: m.kind === "result" ? t.success : m.kind === "heartbeat" ? t.textMuted : t.busBody },
      ],
    },
    ctx.width,
  )
}
