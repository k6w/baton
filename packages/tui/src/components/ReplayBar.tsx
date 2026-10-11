/**
 * Replay timeline: play/pause, speed, position, and markers for the moments that matter
 * (agents starting, merges, failures, approvals, reviews, plans). Keys: space play/pause,
 * [ ] ±10s, , . previous/next moment, - + speed, 0 start, esc leave.
 */
import { formatDuration } from "@batonsh/kernel"
import { useKeyboard } from "@opentui/solid"
import { createSignal, onCleanup } from "solid-js"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import type { Seg } from "../lines.ts"
import type { Replay } from "../replay.ts"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { keycap } from "../ui/widgets.ts"

const MARK: Record<string, { ch: string; token: "success" | "error" | "warning" | "info" | "accent" | "primary" }> = {
  spawn: { ch: "+", token: "info" },
  merge: { ch: "✓", token: "success" },
  fail: { ch: "✗", token: "error" },
  ask: { ch: "?", token: "warning" },
  review: { ch: "✎", token: "accent" },
  task: { ch: "◆", token: "primary" },
}

export function ReplayBar(props: { replay: Replay; width: number; onExit: () => void }) {
  const ui = useUi()
  const [tick, setTick] = createSignal(0)
  const off = props.replay.onChange(() => {
    setTick((t) => t + 1)
    ui.bump()
  })
  onCleanup(off)
  useKeyboard((k) => {
    if (ui.overlay()) return
    const ks = keyString(k)
    const r = props.replay
    if (ks === "space") r.toggle()
    else if (ks === "]") r.seekTime(10_000)
    else if (ks === "[") r.seekTime(-10_000)
    else if (ks === ".") r.seekMarker(1)
    else if (ks === ",") r.seekMarker(-1)
    else if (ks === "+" || ks === "=") r.faster(1)
    else if (ks === "-") r.faster(-1)
    else if (ks === "0") r.seek(0)
    else if (k.name === "escape" && !ui.zoomed()) props.onExit()
  })
  const lines = () => {
    tick()
    const t = ui.theme()
    const r = props.replay
    const total = Math.max(1, r.endTs - r.startTs)
    const pos = r.nowTs - r.startTs
    const head: Seg[] = [
      { text: " ", bg: t.backgroundElement === "transparent" ? undefined : t.backgroundElement },
      { text: r.playing ? "► " : "‖ ", fg: r.playing ? t.success : t.warning, bold: true },
      { text: `REPLAY ${r.speed}× `, fg: t.text, bold: true },
    ]
    const time = ` ${formatDuration(pos)} / ${formatDuration(total)} `
    const barW = Math.max(10, props.width - 30 - time.length)
    const cells: Seg[] = Array.from({ length: barW }, () => ({ text: "─", fg: t.borderSubtle }))
    for (const m of r.markers) {
      const e = r.events[m.index]
      if (!e) continue
      const x = Math.min(barW - 1, Math.floor(((e.ts - r.startTs) / total) * barW))
      const mk = MARK[m.kind]!
      cells[x] = { text: mk.ch, fg: t[mk.token] }
    }
    const cur = Math.min(barW - 1, Math.floor((pos / total) * barW))
    for (let i = 0; i < cur; i++) if (cells[i]!.text === "─") cells[i] = { text: "━", fg: t.accent }
    cells[cur] = { text: "●", fg: t.text, bold: true }
    const keys: Seg[] = [keycap(t, "space"), { text: " ", fg: t.textMuted }, keycap(t, ", ."), { text: " moments ", fg: t.textMuted }, keycap(t, "esc")]
    return toStyled(
      [
        { segs: [...head, ...cells, { text: time, fg: t.textMuted }] },
        {
          segs: [
            { text: ` ${props.replay.title}`.slice(0, Math.max(0, props.width - 44)), fg: t.textSubtle },
            { text: "   " },
            ...keys,
            { text: "  [ ] ±10s  - + speed", fg: t.textSubtle },
          ],
        },
      ],
      props.width,
      2,
    )
  }
  return (
    <box height={2} width={props.width}>
      <Txt height={2} value={lines()} />
    </box>
  )
}
