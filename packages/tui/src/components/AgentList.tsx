/** "list" layout: one dense row per agent — best for many agents or narrow terminals. */

import { attentionItems, formatCost, formatDuration } from "@batonsh/kernel"
import { createMemo } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { clip, type Line, type Seg, width as sw } from "../lines.ts"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { attentionGlyph } from "./Overlays.tsx"

export function AgentList(props: { width: number; height: number; agentIds: string[] }) {
  const ui = useUi()
  const lines = createMemo<Line[]>(() => {
    ui.version()
    ui.frame()
    const t = ui.theme()
    const W = props.width
    const focused = ui.focus().kind === "agent" ? (ui.focus() as { agentId: string }).agentId : undefined
    const attn = attentionItems(ui.run)
    const frames = ui.spinnerFrames()
    const header: Line = {
      segs: [
        { text: "   agent".padEnd(20), fg: t.textSubtle },
        { text: "state".padEnd(18), fg: t.textSubtle },
        { text: "task".padEnd(22), fg: t.textSubtle },
        { text: "changes".padEnd(16), fg: t.textSubtle },
        { text: "cost".padStart(8), fg: t.textSubtle },
        { text: "   now", fg: t.textSubtle },
      ],
    }
    const rows: Line[] = [header]
    for (const id of props.agentIds) {
      const a = ui.run.agents.get(id)
      if (!a) continue
      const look = agentLook(ui, a)
      const ws = ui.run.workspaces.get(id)
      const it = attn.find((x) => x.agentId === id && x.kind !== "ready")
      const sel = id === focused
      const bg = sel ? t.selection : undefined
      const state: Seg = it
        ? { text: `${attentionGlyph(it.kind).glyph} ${it.kind}`, fg: t[attentionGlyph(it.kind).token], bold: true }
        : a.status === "busy"
          ? { text: `${frames[ui.frame() % frames.length]} ${a.turnStartedAt ? formatDuration(ui.now() - a.turnStartedAt) : "working"}`, fg: t.stateBusy }
          : a.status === "ready"
            ? { text: "◌ idle", fg: t.stateIdle }
            : { text: a.status, fg: t.textMuted }
      const changes =
        ws?.mode === "worktree" && ws.files.length ? `⎇${ws.files.length} +${ws.added} −${ws.removed}` : ws?.merge?.status === "merged" ? "✓ merged" : ""
      const segs: Seg[] = [
        { text: sel ? "▸ " : "  ", fg: t.primary, bg },
        { text: `${look.glyph} `, fg: look.color, bg },
        { text: clip(a.name, 15).padEnd(16), fg: t.text, bold: sel, bg },
        { text: clip(state.text, 17).padEnd(18), fg: state.fg, bold: state.bold, bg },
        { text: clip(a.label ?? "", 21).padEnd(22), fg: t.textMuted, bg },
        { text: clip(changes, 15).padEnd(16), fg: ws?.merge?.status === "merged" && !ws.files.length ? t.success : t.accent, bg },
        { text: (a.usage.costUsd ? formatCost(a.usage.costUsd) : "").padStart(8), fg: t.textMuted, bg },
        { text: "   ", bg },
      ]
      const used = segs.reduce((n, s) => n + sw(s.text), 0)
      segs.push({ text: clip(a.lastActivity ?? "", Math.max(0, W - used)), fg: t.textSubtle, bg })
      rows.push({ segs, bg })
    }
    if (rows.length === 1) rows.push({ segs: [{ text: "  no agents yet", fg: t.textMuted }] })
    return rows.slice(0, props.height)
  })
  return (
    <box width={props.width} height={props.height} backgroundColor={ui.theme().background}>
      <Txt value={toStyled(lines(), props.width, props.height)} />
    </box>
  )
}
