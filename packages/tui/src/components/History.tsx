/** History: past runs of this project — resume, export to Markdown. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { formatCost, formatDuration } from "@batonsh/kernel"
import { useKeyboard } from "@opentui/solid"
import { createMemo, createResource, createSignal, Show } from "solid-js"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { clip, type Line } from "../lines.ts"
import { segs, toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { ListView, Modal } from "./Overlays.tsx"

function ago(ts: number, now: number): string {
  const d = now - ts
  if (d < 60_000) return "just now"
  if (d < 3600_000) return `${Math.round(d / 60_000)}m ago`
  if (d < 86_400_000) return `${Math.round(d / 3600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}

export function HistoryOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  const [sel, setSel] = createSignal(0)
  const [runs] = createResource(async () => (ui.client ? (await ui.client.call("runs.list", { limit: 50 }).catch(() => ({ runs: [] }))).runs : []))
  const current = () => runs()?.[sel()]
  const act = async <T,>(p: Promise<T> | undefined, ok: (v: T) => string) => {
    if (!p) return
    try {
      ui.toast(ok(await p))
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error")
    }
  }
  useKeyboard((k) => {
    const n = runs()?.length ?? 0
    const ks = keyString(k)
    const r = current()
    if (k.name === "escape") props.onClose()
    else if (k.name === "down" || ks === "j") setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "up" || ks === "k") setSel((s) => (n ? (s - 1 + n) % n : 0))
    else if (!r) return
    else if ((k.name === "return" || k.name === "enter" || ks === "r") && !r.current) {
      props.onClose()
      void act(ui.client?.call("run.resume", { runId: r.runId }), (v) =>
        v.agents.length ? `resumed ${v.agents.join(", ")}` : "nothing to resume (agents already running)",
      )
    } else if (ks === "e" || ks === "shift+e" || ks === "h") {
      const format = ks === "e" ? "md" : ks === "h" ? "html" : "jsonl"
      void act(ui.client?.call("run.export", { runId: r.runId, format }), (v) => {
        const dir = join(ui.run.projectRoot || process.cwd(), ".baton", "exports")
        mkdirSync(dir, { recursive: true })
        const path = join(dir, `${r.runId}.${format}`)
        writeFileSync(path, v.text)
        return `exported ${path}`
      })
    }
  })
  const detail = createMemo<Line[]>(() => {
    const r = current()
    const t = ui.theme()
    if (!r) return []
    return [
      { segs: [{ text: r.title, fg: t.text, bold: true }] },
      {
        segs: [
          { text: `${new Date(r.startedAt).toLocaleString()}`, fg: t.textMuted },
          { text: r.endedAt ? ` · ${formatDuration(r.endedAt - r.startedAt)}` : r.current ? " · running now" : "", fg: t.textMuted },
          { text: ` · ${r.agents} agent${r.agents === 1 ? "" : "s"} (${r.adapters.join(", ")})`, fg: t.textMuted },
        ],
      },
      {
        segs: [
          { text: `${r.toolCalls} tool calls · `, fg: t.textMuted },
          { text: `+${r.added}`, fg: t.success },
          { text: ` −${r.removed}`, fg: t.error },
          { text: ` · ${r.merged} merge${r.merged === 1 ? "" : "s"} · ${formatCost(r.costUsd)}`, fg: t.textMuted },
        ],
      },
      { segs: [] },
      {
        segs: [
          {
            text: r.current
              ? "this is the current run · e export markdown · h shareable html · E jsonl"
              : "enter resume (agents restart with their sessions) · e markdown · h html · E jsonl",
            fg: t.textSubtle,
          },
        ],
      },
    ]
  })
  return (
    <Modal title="History" width={96} height={24} hint="↑↓ select · enter resume · e export · esc close">
      <Show when={(runs()?.length ?? 0) > 0} fallback={<Txt value={segs({ text: runs.loading ? "loading…" : "No runs yet.", fg: ui.theme().textMuted })} />}>
        <ListView
          items={(runs() ?? []).map((r) => ({
            label: [
              { text: r.current ? "● " : "  ", fg: ui.theme().success },
              { text: ago(r.startedAt, ui.now()).padEnd(12), fg: ui.theme().textMuted },
              { text: clip(r.title, 52), fg: ui.theme().text },
            ],
            right: `${r.agents}⚇ ${formatCost(r.costUsd)}`,
          }))}
          selected={sel()}
          width={92}
          height={Math.min(12, Math.max(1, runs()?.length ?? 1))}
        />
        <Txt value={segs({ text: "─".repeat(92), fg: ui.theme().borderSubtle })} />
        <Txt value={toStyled(detail(), 92, 5)} height={5} />
      </Show>
    </Modal>
  )
}
