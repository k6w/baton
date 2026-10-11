/**
 * Status bar, driven by format strings (`ui.status_left` / `ui.status_right`) and drawn in one
 * of four styles (`ui.status_style`): plain bar · blocks (chips) · powerline · minimal.
 * Variables: {trust} {autonomy} {attention} {dot} {running} {total} {noun} {calls} {msgs} {cost} {tokens} {added}
 *            {removed} {unmerged} {repo} {branch} {mode} {approvals} {spark} {theme} {layout} {style} {viewers}
 */

import { attentionItems, formatCost, formatCount, formatTokens, urgentCount } from "@batonsh/kernel"
import { mix, type ResolvedTheme, type StatusStyle } from "@batonsh/themes"
import { createMemo } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { AUTONOMY_INFO, anyYoloAgent, currentAutonomy } from "../autonomy.ts"
import { useUi } from "../context.ts"
import { type Line, type Seg, width as sw } from "../lines.ts"
import { onColor } from "../ui/Frame.tsx"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"

const SPARK = "▁▂▃▄▅▆▇█"

/** A status variable; `tone` makes it a highlighted chip of its own in chip styles. */
export type StatusVar = Seg & { tone?: string }

export function sparkline(times: readonly number[], now: number, buckets = 16, bucketMs = 5000): string {
  const counts = new Array<number>(buckets).fill(0)
  for (const t of times) {
    const age = now - t
    const idx = buckets - 1 - Math.floor(age / bucketMs)
    if (idx >= 0 && idx < buckets) counts[idx]!++
  }
  const max = Math.max(1, ...counts)
  return counts.map((c) => (c === 0 ? " " : SPARK[Math.min(SPARK.length - 1, Math.floor((c / max) * (SPARK.length - 1)))])).join("")
}

export function renderTemplate(fmt: string, vars: Record<string, Seg | undefined>, fallback: string): Seg[] {
  const out: Seg[] = []
  for (const part of fmt.split(/(\{\w+\})/)) {
    if (!part) continue
    const m = /^\{(\w+)\}$/.exec(part)
    if (m) {
      const v = vars[m[1] as string]
      if (v?.text) out.push(v)
    } else out.push({ text: part, fg: fallback })
  }
  // collapse separators left dangling by empty variables ("·  ·")
  return out.filter((s, i, arr) => !(s.text.trim() === "·" && (i === arr.length - 1 || arr[i + 1]?.text.trim() === "·")))
}

export interface Chip {
  segs: Seg[]
  tone?: string
}

/** The template as chips: split at "·" / wide gaps; toned variables become chips of their own. */
export function templateChips(fmt: string, vars: Record<string, StatusVar | undefined>, fallback: string): Chip[] {
  const chips: Chip[] = []
  let cur: Seg[] = []
  const flush = () => {
    // trim spaces at the chip edges
    while (cur.length && !cur[0]!.text.trim()) cur.shift()
    while (cur.length && !cur[cur.length - 1]!.text.trim()) cur.pop()
    if (cur.length) {
      cur[0] = { ...cur[0]!, text: cur[0]!.text.trimStart() }
      cur[cur.length - 1] = { ...cur[cur.length - 1]!, text: cur[cur.length - 1]!.text.trimEnd() }
      chips.push({ segs: cur })
    }
    cur = []
  }
  for (const part of fmt.split(/(\{\w+\})/)) {
    if (!part) continue
    const m = /^\{(\w+)\}$/.exec(part)
    if (m) {
      const v = vars[m[1] as string]
      if (!v?.text) continue
      if (v.tone) {
        flush()
        chips.push({ segs: [{ ...v, tone: undefined } as Seg], tone: v.tone })
      } else cur.push(v)
      continue
    }
    // literal text: "·" and wide gaps separate chips
    for (const piece of part.split(/(\s*·\s*|\s{2,})/)) {
      if (!piece) continue
      if (/^\s*·\s*$|^\s{2,}$/.test(piece)) flush()
      else cur.push({ text: piece, fg: fallback })
    }
  }
  flush()
  return chips
}

const PL_RIGHT = "" //  (powerline)
const PL_LEFT = "" //

/** Draw left + right chip groups as one status row of exactly `width` columns. */
export function renderStatusRow(
  left: Chip[],
  right: Chip[],
  opts: { style: StatusStyle; width: number; theme: ResolvedTheme; plainLeft?: Seg[]; plainRight?: Seg[] },
): Line {
  const t = opts.theme
  const solid = (c: string) => (c === "transparent" ? (t.appearance === "dark" ? "#000000" : "#ffffff") : c)
  const elementBg = solid(t.backgroundElement)
  const chipBg = (i: number, tone?: string) => tone ?? (i % 2 === 0 ? elementBg : mix(elementBg, t.primary, 0.18))
  const recolor = (segs: Seg[], bg: string, tone?: string): Seg[] =>
    segs.map((s) => ({ ...s, bg, fg: tone ? onColor(tone) : s.fg, bold: tone ? true : s.bold }))
  const join = (l: Seg[], r: Seg[], barBg?: string): Line => {
    const lw = l.reduce((n, s) => n + sw(s.text), 0)
    const rw = r.reduce((n, s) => n + sw(s.text), 0)
    const gap = Math.max(1, opts.width - lw - rw)
    return { segs: [...l, { text: " ".repeat(gap), bg: barBg }, ...r], bg: barBg }
  }
  switch (opts.style) {
    case "minimal": {
      const sep: Seg = { text: "  ", fg: t.textSubtle }
      const flat = (cs: Chip[]) =>
        cs.flatMap((c, i) => [...(i ? [sep] : []), ...c.segs.map((s) => ({ ...s, fg: c.tone ?? s.fg, bold: c.tone ? true : s.bold }))])
      return join([{ text: " " }, ...flat(left)], [...flat(right), { text: " " }])
    }
    case "blocks": {
      // ▐ chip ▌ ▐ chip ▌ floating on the app background
      const draw = (cs: Chip[]) =>
        cs.flatMap((c, i) => {
          const bg = chipBg(i, c.tone)
          return [{ text: i ? " " : "" }, { text: "▐", fg: bg }, ...recolor(c.segs, bg, c.tone), { text: "▌", fg: bg }]
        })
      return join([{ text: " " }, ...draw(left)], [...draw(right), { text: " " }])
    }
    case "powerline": {
      const barBg = solid(t.statusBar)
      const drawLeft = (cs: Chip[]): Seg[] => {
        const out: Seg[] = []
        cs.forEach((c, i) => {
          const bg = chipBg(i, c.tone)
          out.push({ text: " ", bg }, ...recolor(c.segs, bg, c.tone), { text: " ", bg })
          const next = i + 1 < cs.length ? chipBg(i + 1, cs[i + 1]!.tone) : barBg
          out.push({ text: PL_RIGHT, fg: bg, bg: next })
        })
        return out
      }
      const drawRight = (cs: Chip[]): Seg[] => {
        const out: Seg[] = []
        cs.forEach((c, i) => {
          const bg = chipBg(i + 1, c.tone)
          const prev = i === 0 ? barBg : chipBg(i, cs[i - 1]!.tone)
          out.push({ text: PL_LEFT, fg: bg, bg: prev }, { text: " ", bg }, ...recolor(c.segs, bg, c.tone), { text: " ", bg })
        })
        return out
      }
      return join(drawLeft(left), drawRight(right), barBg)
    }
    default: {
      const barBg = t.statusBar
      const l = opts.plainLeft ?? left.flatMap((c, i) => [...(i ? [{ text: " · ", fg: t.statusText }] : []), ...c.segs])
      const r = opts.plainRight ?? right.flatMap((c, i) => [...(i ? [{ text: " · ", fg: t.statusText }] : []), ...c.segs])
      return join([{ text: " ", bg: barBg }, ...l.map((s) => ({ ...s, bg: barBg }))], [...r.map((s) => ({ ...s, bg: barBg })), { text: " ", bg: barBg }], barBg)
    }
  }
}

export function StatusBar(props: { width: number }) {
  const ui = useUi()
  const content = createMemo(() => {
    ui.version()
    ui.now()
    const t = ui.theme()
    const run = ui.run
    const workers = run.workers()
    const running = workers.filter((w) => w.status === "busy" || w.status === "awaiting_approval").length
    const kinds = new Set(workers.map((w) => agentLook(ui, w).icon.id))
    const noun = workers.length === 0 ? "agents" : kinds.size === 1 ? [...kinds][0]! : "subagents"
    const level = currentAutonomy(ui)
    const autonomy: StatusVar | undefined =
      level !== "normal"
        ? {
            text: `${AUTONOMY_INFO[level].glyph} ${AUTONOMY_INFO[level].label}`,
            fg: t[AUTONOMY_INFO[level].token],
            bold: true,
            tone: t[AUTONOMY_INFO[level].token],
          }
        : anyYoloAgent(ui)
          ? { text: "▲ YOLO agent", fg: t.error, bold: true, tone: t.error }
          : undefined
    const vars: Record<string, StatusVar | undefined> = {
      dot: { text: "●", fg: running ? t.success : t.textSubtle },
      running: { text: String(running), fg: t.text },
      total: { text: String(workers.length), fg: t.text },
      noun: { text: noun, fg: t.statusText },
      calls: { text: formatCount(run.totals.toolCalls), fg: t.text },
      msgs: { text: formatCount(run.busChatCount), fg: t.text },
      cost: run.totals.costUsd > 0 ? { text: formatCost(run.totals.costUsd), fg: t.statusText } : undefined,
      tokens: { text: formatTokens(run.totals.input + run.totals.output), fg: t.statusText },
      added: run.totals.added ? { text: `+${formatCount(run.totals.added)}`, fg: t.success } : undefined,
      removed: run.totals.removed ? { text: `-${formatCount(run.totals.removed)}`, fg: t.error } : undefined,
      repo: { text: run.projectName, fg: t.statusText },
      branch: run.branch ? { text: run.branch, fg: t.statusText } : undefined,
      mode: { text: run.mode, fg: t.statusText },
      approvals: run.approvals.size ? { text: `▲ ${run.approvals.size}`, fg: t.warning, tone: t.warning } : undefined,
      trust: autonomy,
      autonomy,
      attention: (() => {
        const n = urgentCount(attentionItems(run))
        return n ? { text: `⚑ ${n}`, fg: t.warning, bold: true, tone: t.warning } : undefined
      })(),
      spark: { text: sparkline(run.activity, ui.now()), fg: t.accent },
      theme: { text: t.name, fg: t.statusText },
      layout: { text: ui.prefs.layout, fg: t.statusText },
      style: { text: ui.prefs.style, fg: t.statusText },
      focus: (() => {
        const until = ui.focusUntil()
        if (until === undefined) return undefined
        const mins = Math.max(1, Math.ceil((until - ui.now()) / 60_000))
        return { text: `◐ focus ${mins}m`, fg: t.accent, bold: true, tone: t.accent }
      })(),
      // shared runs: who else is watching
      viewers: (() => {
        const others = [...new Set(run.viewers.map((v) => v.name))].filter((n) => n !== ui.me)
        if (!others.length) return undefined
        return { text: `◎ ${others.slice(0, 2).join(", ")}${others.length > 2 ? ` +${others.length - 2}` : ""}`, fg: t.info }
      })(),
      unmerged: (() => {
        let files = 0
        let conflicts = 0
        for (const w of run.workspaces.values()) {
          files += w.files.length
          conflicts += w.conflicts.length ? 1 : 0
        }
        if (conflicts) return { text: `▲ ${conflicts} conflict${conflicts > 1 ? "s" : ""}`, fg: t.warning, tone: t.warning }
        return files ? { text: `⎇ ${files} unmerged`, fg: t.accent } : undefined
      })(),
    }
    const style = ui.prefs.status_style ?? "plain"
    const noBranch = (segs: Seg[]) => (run.branch ? segs : segs.filter((s) => s.text !== "@"))
    const line = renderStatusRow(
      templateChips(ui.config.ui.status_left, vars, t.statusText),
      templateChips(ui.config.ui.status_right, vars, t.statusText).map((c) => ({ ...c, segs: noBranch(c.segs) })),
      {
        style,
        width: props.width,
        theme: t,
        // plain keeps the template's own punctuation exactly
        plainLeft: renderTemplate(ui.config.ui.status_left, vars, t.statusText),
        plainRight: noBranch(renderTemplate(ui.config.ui.status_right, vars, t.statusText)),
      },
    )
    return toStyled([line], props.width)
  })
  const bg = () => (ui.prefs.status_style === "plain" || ui.prefs.status_style === "powerline" ? ui.theme().statusBar : ui.theme().background)
  return (
    <box height={1} width={props.width} backgroundColor={bg()}>
      <Txt value={content()} />
    </box>
  )
}
