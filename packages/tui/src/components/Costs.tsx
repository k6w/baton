/** Costs: spend and tokens per agent and vendor, burn rate, budget gauges. */

import { formatCost, formatDuration, formatTokens } from "@batonsh/kernel"
import { useKeyboard } from "@opentui/solid"
import { createMemo } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { useUi } from "../context.ts"
import type { Line, Seg } from "../lines.ts"
import { clip } from "../lines.ts"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { Modal } from "./Overlays.tsx"

function gauge(used: number, limit: number, width: number, colors: { ok: string; warn: string; bad: string; empty: string }): Seg[] {
  const frac = Math.max(0, Math.min(1, used / limit))
  const filled = Math.round(frac * width)
  const fg = frac >= 1 ? colors.bad : frac >= 0.8 ? colors.warn : colors.ok
  return [
    { text: "█".repeat(filled), fg },
    { text: "░".repeat(width - filled), fg: colors.empty },
    { text: ` ${Math.round(frac * 100)}%`, fg },
  ]
}

export function CostsOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q") props.onClose()
  })
  const W = 96
  const lines = createMemo<Line[]>(() => {
    ui.version()
    ui.now()
    const t = ui.theme()
    const run = ui.run
    const out: Line[] = []
    const agents = [...run.agents.values()].sort(
      (a, b) => b.usage.costUsd - a.usage.costUsd || b.usage.input + b.usage.output - (a.usage.input + a.usage.output),
    )
    out.push({
      segs: [
        { text: "agent".padEnd(18), fg: t.textSubtle },
        { text: "model".padEnd(18), fg: t.textSubtle },
        { text: "tokens in".padStart(10), fg: t.textSubtle },
        { text: "out".padStart(8), fg: t.textSubtle },
        { text: "cost".padStart(9), fg: t.textSubtle },
        { text: "$/min".padStart(8), fg: t.textSubtle },
        { text: "   running for", fg: t.textSubtle },
      ],
    })
    const vendors = new Map<string, { cost: number; tokens: number }>()
    for (const a of agents) {
      const look = agentLook(ui, a)
      const mins = Math.max(1 / 60, (ui.now() - a.startedAt) / 60000)
      const rate = a.usage.costUsd / mins
      const v = vendors.get(look.icon.label) ?? { cost: 0, tokens: 0 }
      v.cost += a.usage.costUsd
      v.tokens += a.usage.input + a.usage.output
      vendors.set(look.icon.label, v)
      out.push({
        segs: [
          { text: `${look.glyph} `, fg: look.color },
          { text: clip(a.name, 15).padEnd(16), fg: a.status === "exited" ? t.textSubtle : t.text },
          { text: clip(a.model ?? a.adapter, 17).padEnd(18), fg: t.textMuted },
          { text: formatTokens(a.usage.input).padStart(10), fg: t.textMuted },
          { text: formatTokens(a.usage.output).padStart(8), fg: t.textMuted },
          { text: (a.usage.costUsd ? formatCost(a.usage.costUsd) : "—").padStart(9), fg: a.usage.costUsd ? t.text : t.textSubtle },
          { text: (a.usage.costUsd ? `$${rate.toFixed(2)}` : "").padStart(8), fg: t.textMuted },
          { text: `   ${formatDuration(ui.now() - a.startedAt)}`, fg: t.textSubtle },
        ],
      })
    }
    if (!agents.length) out.push({ segs: [{ text: "No agents yet.", fg: t.textMuted }] })
    out.push({ segs: [] })
    out.push({ segs: [{ text: "By vendor", fg: t.primary, bold: true }] })
    for (const [name, v] of [...vendors].sort((a, b) => b[1].cost - a[1].cost))
      out.push({
        segs: [
          { text: `  ${name.padEnd(20)}`, fg: t.text },
          { text: formatTokens(v.tokens).padStart(8), fg: t.textMuted },
          { text: " tokens  ", fg: t.textSubtle },
          { text: formatCost(v.cost), fg: t.text },
        ],
      })
    out.push({ segs: [] })
    const total = run.totals.costUsd
    out.push({
      segs: [
        { text: "Total  ", fg: t.primary, bold: true },
        { text: formatCost(total), fg: t.text, bold: true },
        { text: `   ${formatTokens(run.totals.input + run.totals.output)} tokens`, fg: t.textMuted },
      ],
    })
    const b = ui.config.budget
    const colors = { ok: t.success, warn: t.warning, bad: t.error, empty: t.borderSubtle }
    if (b.run_usd)
      out.push({
        segs: [{ text: "Run budget    ", fg: t.textMuted }, ...gauge(total, b.run_usd, 40, colors), { text: `  of $${b.run_usd}`, fg: t.textSubtle }],
      })
    if (b.per_agent_usd) {
      const top = agents[0]
      if (top)
        out.push({
          segs: [
            { text: "Top agent     ", fg: t.textMuted },
            ...gauge(top.usage.costUsd, b.per_agent_usd, 40, colors),
            { text: `  ${top.name} of $${b.per_agent_usd}/agent`, fg: t.textSubtle },
          ],
        })
    }
    if (!b.run_usd && !b.per_agent_usd) out.push({ segs: [{ text: "No budget set — settings (ctrl+s) → Safety & budget.", fg: t.textSubtle }] })
    out.push({ segs: [{ text: "Subscription agents (Codex, OpenCode free tiers…) may not report $ — tokens are still counted.", fg: t.textSubtle }] })
    return out
  })
  return (
    <Modal title="Costs" width={W} height={Math.min(34, lines().length + 3)} hint="esc close">
      <Txt value={toStyled(lines(), W - 4)} />
    </Modal>
  )
}
