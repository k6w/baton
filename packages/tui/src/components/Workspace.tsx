/** Workspace overlays: Changes (per-worker branches), Diff viewer, Task plan. */

import type { WorkspaceView } from "@batonsh/kernel"
import { parseUnifiedDiff } from "@batonsh/protocol"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { agentLook, whoFn } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { clip, type Line, type Seg } from "../lines.ts"
import { segs, toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { ListView, Modal } from "./Overlays.tsx"

async function act<T>(ui: ReturnType<typeof useUi>, p: Promise<T> | undefined, ok: (v: T) => string | undefined) {
  if (!p) return
  try {
    const msg = ok(await p)
    if (msg) ui.toast(msg)
  } catch (e) {
    ui.toast(e instanceof Error ? e.message : String(e), "error")
  }
}

export function ChangesOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  const [sel, setSel] = createSignal(0)
  const rows = createMemo(() => {
    ui.version()
    return [...ui.run.workspaces.entries()]
      .filter(([, w]) => w.mode === "worktree")
      .map(([agentId, w]) => ({ agentId, w, agent: ui.run.agents.get(agentId) }))
      .filter((r) => r.agent)
      .sort((a, b) => b.w.files.length - a.w.files.length)
  })
  const current = () => rows()[Math.min(sel(), rows().length - 1)]
  useKeyboard((k) => {
    const n = rows().length
    const ks = keyString(k)
    const cur = current()
    if (k.name === "escape" || ks === "q") props.onClose()
    else if (k.name === "down" || ks === "j") setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "up" || ks === "k") setSel((s) => (n ? (s - 1 + n) % n : 0))
    else if (!cur) return
    else if (k.name === "return" || k.name === "enter" || ks === "v") {
      ui.setDiffAgent(cur.agentId)
      ui.setOverlay("diff")
    } else if (ks === "m")
      void act(ui, ui.client?.call("workspace.merge", { agentId: cur.agentId }), (r) =>
        r.status === "merged"
          ? `merged ${cur.agent!.name}: ${r.files.length} file(s)`
          : r.status === "empty"
            ? "nothing to merge"
            : `${r.status}: ${r.detail ?? ""}`,
      )
    else if (ks === "s")
      void act(ui, ui.client?.call("workspace.sync", { agentId: cur.agentId }), (r) =>
        r.clean ? `${cur.agent!.name} is up to date` : `conflicts in ${r.conflicts.join(", ")} — agent asked to resolve`,
      )
    else if (ks === "r") void act(ui, ui.client?.call("review.request", { agentId: cur.agentId }), (r) => `${r.reviewer} is reviewing ${cur.agent!.name}`)
    else if (ks === "u") void act(ui, ui.client?.submit(`/undo ${cur.agent!.name}`), (r) => r.output)
  })
  const detail = createMemo<Line[]>(() => {
    const t = ui.theme()
    const cur = current()
    if (!cur) return [{ segs: [{ text: "No worker worktrees yet — workers get one when they start.", fg: t.textMuted }] }]
    const out: Line[] = []
    out.push({
      segs: [
        { text: cur.w.branch ?? "", fg: t.accent },
        { text: `  ${cur.w.path}`, fg: t.textSubtle },
      ],
    })
    for (const f of cur.w.files.slice(0, 8))
      out.push({
        segs: [
          { text: `  ${f.path}  `, fg: t.text },
          { text: `+${f.added}`, fg: t.success },
          { text: ` −${f.removed}`, fg: t.error },
        ],
      })
    if (cur.w.files.length > 8) out.push({ segs: [{ text: `  … ${cur.w.files.length - 8} more`, fg: t.textMuted }] })
    for (const c of cur.w.conflicts)
      out.push({
        segs: [{ text: `⚠ ${c.kind === "lease" ? "claimed by" : "conflicts with"} ${whoFn(ui)(c.with).name}: ${c.files.join(", ")}`, fg: t.warning }],
      })
    if (cur.w.review?.notes) out.push({ segs: [{ text: `review: ${cur.w.review.notes.split("\n")[0]}`, fg: t.textMuted }] })
    if (cur.w.merge?.detail && cur.w.merge.status !== "merged") out.push({ segs: [{ text: cur.w.merge.detail.split("\n")[0] ?? "", fg: t.error }] })
    return out
  })
  const status = (w: WorkspaceView): string => {
    if (w.conflicts.length) return "⚠ conflict"
    if (w.merge?.status === "verifying" || w.merge?.status === "queued") return "◐ merging"
    if (w.merge?.status === "failed" || w.merge?.status === "conflict") return "✗ merge failed"
    if (w.review?.status === "approve") return "✓ approved"
    if (w.review?.status === "changes_requested") return "changes requested"
    if (w.review?.status === "requested") return "◐ in review"
    if (!w.files.length && w.merge?.status === "merged") return "✓ merged"
    return w.files.length ? "unmerged" : "clean"
  }
  return (
    <Modal title="Changes" width={96} height={26} hint="enter diff · m merge · u undo merge · s sync · r review · esc">
      <ListView
        items={rows().map((r) => {
          const look = agentLook(ui, r.agent!)
          return {
            label: [
              { text: `${look.glyph} `, fg: look.color },
              { text: r.agent!.name.padEnd(14), fg: ui.theme().text },
              { text: `${String(r.w.files.length).padStart(3)} files `, fg: ui.theme().textMuted },
              { text: `+${r.w.added}`.padStart(6), fg: ui.theme().success },
              { text: ` −${r.w.removed}`.padEnd(7), fg: ui.theme().error },
            ],
            right: status(r.w),
          }
        })}
        selected={sel()}
        width={92}
        height={Math.max(1, Math.min(10, rows().length || 1))}
      />
      <Txt wrapMode="none" value={segs({ text: "─".repeat(92), fg: ui.theme().borderSubtle })} />
      <Txt wrapMode="none" height={12} value={toStyled(detail(), 92, 12)} />
    </Modal>
  )
}

export function DiffOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const agentId = ui.diffAgent()
  const name = agentId ? (ui.run.agents.get(agentId)?.name ?? "agent") : "agent"
  const [patch] = createResource(async () => (agentId && ui.client ? (await ui.client.call("workspace.diff", { agentId })).patch : ""))
  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q") props.onClose()
    else if (keyString(k) === "m" && agentId)
      void act(ui, ui.client?.call("workspace.merge", { agentId }), (r) => (r.status === "merged" ? `merged ${name}` : `${r.status}: ${r.detail ?? ""}`))
  })
  const w = () => Math.max(40, dims().width - 4)
  const lines = createMemo<Line[]>(() => {
    const t = ui.theme()
    const p = patch()
    if (patch.loading) return [{ segs: [{ text: "loading diff…", fg: t.textMuted }] }]
    if (!p?.trim()) return [{ segs: [{ text: `${name} has no unmerged changes.`, fg: t.textMuted }] }]
    const out: Line[] = []
    const width = w() - 4
    for (const f of parseUnifiedDiff(p)) {
      const added = f.lines.filter((l) => l.kind === "add").length
      const removed = f.lines.filter((l) => l.kind === "del").length
      out.push({
        segs: [
          { text: "▸ ", fg: t.accent },
          { text: f.path ?? "?", fg: t.text, bold: true },
          { text: `  +${added}`, fg: t.success },
          { text: ` −${removed}`, fg: t.error },
        ],
      })
      const numW = Math.max(3, String(Math.max(0, ...f.lines.map((l) => l.newLine ?? l.oldLine ?? 0))).length)
      for (const l of f.lines) {
        const bg = l.kind === "add" ? t.diffAddedBg : l.kind === "del" ? t.diffRemovedBg : undefined
        const fg = l.kind === "add" ? t.diffAdded : l.kind === "del" ? t.diffRemoved : t.diffContext
        const ln = String(l.kind === "del" ? (l.oldLine ?? "") : (l.newLine ?? "")).padStart(numW)
        const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "
        out.push({
          bg,
          segs: [
            { text: `${ln} ${sign} `, fg: l.kind === "ctx" ? t.diffLineNumber : fg, bg },
            { text: clip(l.text, width - numW - 3), fg, bg },
          ],
        })
      }
      out.push({ segs: [] })
    }
    return out
  })
  return (
    <Modal title={`Diff · ${name}`} width={w()} height={dims().height - 2} hint="↑↓ scroll · m merge · esc back">
      <scrollbox flexGrow={1} focused scrollY>
        <Txt wrapMode="none" value={toStyled(lines(), w() - 4)} />
      </scrollbox>
    </Modal>
  )
}

const STATE_ICON: Record<string, string> = {
  submitted: "○",
  working: "◐",
  input_required: "?",
  auth_required: "🔒",
  completed: "✓",
  failed: "✗",
  canceled: "⊘",
  rejected: "⊘",
}

export function TasksOverlay(props: { onClose: () => void; onPrefill: (text: string) => void }) {
  const ui = useUi()
  const [sel, setSel] = createSignal(0)
  const tasks = createMemo(() => {
    ui.version()
    return [...ui.run.tasks.values()]
  })
  useKeyboard((k) => {
    const n = tasks().length
    const ks = keyString(k)
    if (k.name === "escape" || ks === "q") props.onClose()
    else if (k.name === "down" || ks === "j") setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "up" || ks === "k") setSel((s) => (n ? (s - 1 + n) % n : 0))
    else if (ks === "a" && ui.run.plan?.status === "proposed") void act(ui, ui.client?.submit("/plan approve"), (r) => r.output)
    else if (ks === "x" && ui.run.plan?.status === "proposed") {
      props.onClose()
      props.onPrefill("/plan reject ")
    }
  })
  const color = (state: string) => {
    const t = ui.theme()
    return state === "completed"
      ? t.success
      : state === "failed"
        ? t.error
        : state === "working"
          ? t.stateBusy
          : state === "input_required"
            ? t.warning
            : t.textMuted
  }
  const header = (): Seg[] => {
    const t = ui.theme()
    const all = tasks()
    const done = all.filter((x) => x.state === "completed").length
    const plan = ui.run.plan
    return [
      { text: `${done}/${all.length} done`, fg: t.text, bold: true },
      ...(plan ? [{ text: `  ·  plan ${plan.status}`, fg: plan.status === "proposed" ? t.warning : plan.status === "approved" ? t.success : t.error }] : []),
      ...(plan?.status === "proposed" ? [{ text: "  a approve · x reject", fg: t.textMuted }] : []),
    ]
  }
  return (
    <Modal title="Task plan" width={96} height={24} hint="↑↓ select · esc close">
      <Txt wrapMode="none" value={segs(...header())} />
      <Txt wrapMode="none" value={segs({ text: "─".repeat(92), fg: ui.theme().borderSubtle })} />
      <Show
        when={tasks().length > 0}
        fallback={<Txt value={segs({ text: "No plan yet — the orchestrator records one with plan_tasks.", fg: ui.theme().textMuted })} />}
      >
        <ListView
          items={tasks().map((t) => {
            const owner = t.owner ? whoFn(ui)(t.owner) : undefined
            return {
              label: [
                { text: `${STATE_ICON[t.state] ?? "·"} `, fg: color(t.state) },
                { text: t.taskId.padEnd(8), fg: ui.theme().textMuted },
                { text: clip(t.title, 46), fg: ui.theme().text },
              ],
              detail: t.deps.length ? `← ${t.deps.join(", ")}` : undefined,
              right: owner ? owner.name : t.state,
            }
          })}
          selected={sel()}
          width={92}
          height={Math.min(14, tasks().length)}
        />
        <For each={[tasks()[sel()]?.note].filter(Boolean) as string[]}>
          {(n) => <Txt wrapMode="word" value={segs({ text: n, fg: ui.theme().textMuted })} />}
        </For>
      </Show>
    </Modal>
  )
}
