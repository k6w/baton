/**
 * Compare: candidates side by side (best-of-N, competing fixes). Shows each worker's changes,
 * cost, time and review verdict; `p` picks the selected one — merges it and stops the rest.
 */

import { formatCost, formatDuration } from "@batonsh/kernel"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { clip, type Line } from "../lines.ts"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { Modal } from "./Overlays.tsx"

export function CompareOverlay(props: { onClose: () => void; onDiff: (agentId: string) => void }) {
  const ui = useUi()
  const [sel, setSel] = createSignal(0)
  const [confirm, setConfirm] = createSignal(false)
  // candidates: workers with worktree changes (or labelled "candidate …")
  const candidates = createMemo(() => {
    ui.version()
    return [...ui.run.agents.values()].filter((a) => {
      if (a.isOrchestrator || a.status === "exited") return false
      const ws = ui.run.workspaces.get(a.agentId)
      return (ws?.mode === "worktree" && ws.files.length > 0) || /candidate/i.test(a.label ?? "")
    })
  })
  const pick = async () => {
    const winner = candidates()[sel()]
    if (!winner || !ui.client) return
    try {
      const r = await ui.client.call("workspace.merge", { agentId: winner.agentId })
      if (r.status !== "merged") return ui.toast(`merge ${r.status}: ${r.detail ?? ""}`, "error")
      for (const c of candidates()) if (c.agentId !== winner.agentId) await ui.client.kill(c.agentId)
      ui.toast(`picked ${winner.name}: merged ${r.files.length} file(s), stopped the others`)
      props.onClose()
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error")
    }
  }
  useKeyboard((k) => {
    const ks = keyString(k)
    const n = candidates().length
    if (confirm()) {
      if (ks === "y") void pick()
      setConfirm(false)
      return
    }
    if (k.name === "escape" || ks === "q") props.onClose()
    else if (k.name === "right" || k.name === "down" || ks === "l" || ks === "j") setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "left" || k.name === "up" || ks === "h" || ks === "k") setSel((s) => (n ? (s - 1 + n) % n : 0))
    else if (/^[1-9]$/.test(ks) && candidates()[Number(ks) - 1]) props.onDiff(candidates()[Number(ks) - 1]!.agentId)
    else if ((k.name === "return" || k.name === "enter") && candidates()[sel()]) props.onDiff(candidates()[sel()]!.agentId)
    else if (ks === "p" && n) setConfirm(true)
  })
  const W = 100
  const lines = createMemo<Line[]>(() => {
    const t = ui.theme()
    const list = candidates()
    if (!list.length)
      return [{ segs: [{ text: 'No candidates yet — workers with unmerged changes (or labelled "candidate") show up here.', fg: t.textMuted }] }]
    const colW = Math.max(18, Math.floor((W - 4 - 12) / list.length))
    const cell = (s: string, fg: string, i: number, bold = false) => ({
      text: clip(s, colW - 1).padEnd(colW),
      fg,
      bold,
      bg: i === sel() ? t.selection : undefined,
    })
    const row = (label: string, f: (i: number) => { text: string; fg: string; bold?: boolean }) => ({
      segs: [{ text: label.padEnd(12), fg: t.textSubtle }, ...list.map((_, i) => cell(f(i).text, f(i).fg, i, f(i).bold))],
    })
    const ws = (i: number) => ui.run.workspaces.get(list[i]!.agentId)
    return [
      row("", (i) => ({ text: `${i + 1}  ${agentLook(ui, list[i]!).glyph} ${list[i]!.name}`, fg: t.text, bold: true })),
      row("vendor", (i) => ({ text: `${list[i]!.adapter}${list[i]!.model ? `/${list[i]!.model}` : ""}`, fg: t.textMuted })),
      row("label", (i) => ({ text: list[i]!.label ?? "", fg: t.textMuted })),
      row("status", (i) => ({ text: list[i]!.status, fg: list[i]!.status === "busy" ? t.stateBusy : t.textMuted })),
      row("changes", (i) => ({ text: ws(i)?.files.length ? `${ws(i)!.files.length} files +${ws(i)!.added} −${ws(i)!.removed}` : "—", fg: t.accent })),
      row("conflicts", (i) => ({
        text: ws(i)?.conflicts.length ? `⚠ ${ws(i)!.conflicts.length}` : "none",
        fg: ws(i)?.conflicts.length ? t.warning : t.textSubtle,
      })),
      row("review", (i) => {
        const r = ws(i)?.review
        return {
          text: r ? (r.status === "approve" ? "✓ approved" : r.status === "changes_requested" ? "changes requested" : "in review") : "—",
          fg: r?.status === "approve" ? t.success : r ? t.warning : t.textSubtle,
        }
      }),
      row("cost", (i) => ({ text: formatCost(list[i]!.usage.costUsd), fg: t.textMuted })),
      row("time", (i) => ({ text: formatDuration((list[i]!.lastEventAt ?? ui.now()) - list[i]!.startedAt), fg: t.textMuted })),
      row("files", (i) => ({ text: (ws(i)?.files ?? []).map((f) => f.path.split("/").pop()).join(", ") || "—", fg: t.textSubtle })),
      { segs: [] },
      {
        segs: [
          {
            text: confirm()
              ? `Merge ${list[sel()]?.name} and stop the other ${list.length - 1}? y / any key to cancel`
              : "←→ select · 1-9 / enter diff · p pick the winner (merge it, stop the rest) · esc",
            fg: confirm() ? t.warning : t.textSubtle,
            bold: confirm(),
          },
        ],
      },
    ]
  })
  return (
    <Modal title={`Compare (${candidates().length})`} width={W} height={Math.min(20, lines().length + 3)} hint="request reviews first: r in ctrl+d">
      <Txt value={toStyled(lines(), W - 4)} />
    </Modal>
  )
}
