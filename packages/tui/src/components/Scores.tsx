/**
 * Track record (/scores): what each agent has delivered in this project — merged work, review
 * verdicts, setbacks and cost per success — overall and per kind of task. The orchestrator ranks
 * agents with the same numbers (pick_agent).
 */
import { TASK_KINDS } from "@batonsh/kernel"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { clip, type Line, type Seg, wrap } from "../lines.ts"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { progress } from "../ui/widgets.ts"
import { Modal } from "./Overlays.tsx"

const KINDS = ["all", ...TASK_KINDS] as const

export function ScoresOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const [kind, setKind] = createSignal(0)
  const [data] = createResource(async () => (ui.client ? (await ui.client.call("scorecards.get", {}).catch(() => ({ rows: [] }))).rows : []))
  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q") props.onClose()
    else if (k.name === "right" || k.name === "l" || k.name === "tab") setKind((i) => (i + 1) % KINDS.length)
    else if (k.name === "left" || k.name === "h") setKind((i) => (i - 1 + KINDS.length) % KINDS.length)
  })
  const W = () => Math.min(110, dims().width - 4)
  const H = () => Math.min(30, dims().height - 2)
  const lines = createMemo<Line[]>(() => {
    const t = ui.theme()
    const w = W() - 4
    const k = KINDS[kind()]!
    const rows = (data() ?? []).filter((r) => r.kind === k)
    const out: Line[] = []
    // kind tabs, with how many agents each has data for
    const tabs: Seg[] = []
    for (const [i, name] of KINDS.entries()) {
      const n = (data() ?? []).filter((r) => r.kind === name).reduce((s, r) => s + r.agents, 0)
      if (name !== "all" && !n && i !== kind()) continue
      const on = i === kind()
      tabs.push({ text: ` ${name}${n ? ` ${n}` : ""} `, fg: on ? t.text : t.textMuted, bg: on ? t.selection : undefined, bold: on }, { text: " " })
    }
    out.push({ segs: tabs })
    out.push({ segs: [] })
    if (data.loading) return [...out, { segs: [{ text: "reading this project's history…", fg: t.textMuted }] }]
    if (!rows.length)
      return [
        ...out,
        { segs: [{ text: k === "all" ? "No track record yet." : `No ${k} tasks yet.`, fg: t.textMuted }] },
        {
          segs: [
            {
              text: "Scores build up as agents get work merged or reviewed in this project. The orchestrator uses them (pick_agent) to choose who does what.",
              fg: t.textSubtle,
            },
          ],
        },
      ]
    const head = ["agent", "runs", "merged", "approved", "setbacks", "track record", "$/success"]
    const cols = [Math.max(16, w - 72), 6, 8, 9, 9, 22, 10]
    const cell = (s: string, i: number, right = false) => (right ? s.padStart(cols[i]!) : clip(s, cols[i]!).padEnd(cols[i]!))
    out.push({ segs: head.map((h, i) => ({ text: cell(h, i, i > 0 && i !== 5), fg: t.textSubtle })) })
    for (const r of rows) {
      const look = agentLook(ui, { adapter: r.adapter, name: r.adapter })
      const setbacks = r.mergeFailed + r.changesRequested + r.failedTurns
      const color = r.score >= 0.7 ? t.success : r.score >= 0.45 ? t.warning : t.error
      const bar = progress(t, Math.round(r.score * 100), 100, 12).map((s, i) => (i === 0 ? { ...s, fg: color } : s))
      const label = `${look.glyph} ${r.key}`
      out.push({
        segs: [
          { text: cell(label, 0), fg: look.color, bold: true },
          { text: cell(String(r.agents), 1, true), fg: t.text },
          { text: cell(String(r.merged), 2, true), fg: r.merged ? t.success : t.textMuted },
          { text: cell(String(r.approved), 3, true), fg: r.approved ? t.success : t.textMuted },
          { text: cell(String(setbacks), 4, true), fg: setbacks ? t.error : t.textMuted },
          { text: "  " },
          ...bar,
          { text: ` ${String(Math.round(r.score * 100)).padStart(3)}%`, fg: color, bold: true },
          { text: cell(r.costPerSuccess !== undefined ? `$${r.costPerSuccess.toFixed(2)}` : "—", 6, true), fg: t.textMuted },
        ],
      })
    }
    out.push({ segs: [] })
    const note =
      "Track record = merged + approved vs. failed merges, requested changes and failed turns (smoothed, so 1 result isn't 100%). Close calls go to the cheaper agent per success."
    for (const l of wrap(note, w)) out.push({ segs: [{ text: l, fg: t.textSubtle }] })
    return out
  })
  return (
    <Modal title="Track record — who delivers what in this project" width={W()} height={H()} hint="←→ task kind · esc close">
      <Txt value={toStyled(lines(), W() - 4, H() - 3)} height={H() - 3} />
    </Modal>
  )
}
