/**
 * Status bar, driven by format strings (`ui.status_left` / `ui.status_right`).
 * Variables: {dot} {running} {total} {noun} {calls} {msgs} {cost} {tokens} {added} {removed} {unmerged}
 *            {repo} {branch} {mode} {approvals} {spark} {theme} {layout}
 */

import { attentionItems, formatCost, formatCount, formatTokens, urgentCount } from "@batonsh/kernel"
import { createMemo } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { type Seg, width as sw } from "../lines.ts"
import { segs } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"

const SPARK = "▁▂▃▄▅▆▇█"

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
    const vars: Record<string, Seg | undefined> = {
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
      approvals: run.approvals.size ? { text: `⚠ ${run.approvals.size}`, fg: t.warning } : undefined,
      attention: (() => {
        const n = urgentCount(attentionItems(run))
        return n ? { text: `⚑ ${n}`, fg: t.warning } : undefined
      })(),
      spark: { text: sparkline(run.activity, ui.now()), fg: t.accent },
      theme: { text: t.name, fg: t.statusText },
      layout: { text: ui.prefs.layout, fg: t.statusText },
      unmerged: (() => {
        let files = 0
        let conflicts = 0
        for (const w of run.workspaces.values()) {
          files += w.files.length
          conflicts += w.conflicts.length ? 1 : 0
        }
        if (conflicts) return { text: `⚠ ${conflicts} conflict${conflicts > 1 ? "s" : ""}`, fg: t.warning }
        return files ? { text: `⎇ ${files} unmerged`, fg: t.accent } : undefined
      })(),
    }
    const left = renderTemplate(ui.config.ui.status_left, vars, t.statusText)
    let right = renderTemplate(ui.config.ui.status_right, vars, t.statusText)
    if (!run.branch) right = right.filter((s) => s.text !== "@")
    const lw = left.reduce((n, s) => n + sw(s.text), 0)
    const rw = right.reduce((n, s) => n + sw(s.text), 0)
    const gap = Math.max(1, props.width - lw - rw - 2)
    return segs({ text: " " }, ...left, { text: " ".repeat(gap) }, ...right, { text: " " })
  })
  return (
    <box height={1} width={props.width} backgroundColor={ui.theme().statusBar}>
      <Txt value={content()} />
    </box>
  )
}
