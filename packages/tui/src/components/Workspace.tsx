/** Workspace overlays: Changes (per-worker branches), Diff viewer, Task plan. */

import type { WorkspaceView } from "@batonsh/kernel"
import { parseUnifiedDiff } from "@batonsh/protocol"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js"
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

interface DiffRow {
  line: Line
  /** Commentable target (diff lines only). */
  target?: { path: string; line: number; text: string }
}

/**
 * Diff review: cursor over the diff (j/k), `c` comments on a line, `C` sends every comment to the
 * author agent as one request, `m` merges. Comments render inline under their line.
 */
export function DiffOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const agentId = ui.diffAgent()
  const name = agentId ? (ui.run.agents.get(agentId)?.name ?? "agent") : "agent"
  const [patch] = createResource(async () => (agentId && ui.client ? (await ui.client.call("workspace.diff", { agentId })).patch : ""))
  const [cursor, setCursor] = createSignal(0)
  const [comments, setComments] = createSignal<{ path: string; line: number; snippet: string; text: string }[]>([])
  const [editing, setEditing] = createSignal(false)
  let scroll: ScrollBoxRenderable | undefined
  let inputRef: InputRenderable | undefined
  const w = () => Math.max(40, dims().width - 4)
  const viewH = () => dims().height - 2 - 4

  const rows = createMemo<DiffRow[]>(() => {
    const t = ui.theme()
    const p = patch()
    if (patch.loading) return [{ line: { segs: [{ text: "loading diff…", fg: t.textMuted }] } }]
    if (!p?.trim()) return [{ line: { segs: [{ text: `${name} has no unmerged changes.`, fg: t.textMuted }] } }]
    const out: DiffRow[] = []
    const width = w() - 4
    for (const f of parseUnifiedDiff(p)) {
      const added = f.lines.filter((l) => l.kind === "add").length
      const removed = f.lines.filter((l) => l.kind === "del").length
      out.push({
        line: {
          segs: [
            { text: "▸ ", fg: t.accent },
            { text: f.path ?? "?", fg: t.text, bold: true },
            { text: `  +${added}`, fg: t.success },
            { text: ` −${removed}`, fg: t.error },
          ],
        },
      })
      const numW = Math.max(3, String(Math.max(0, ...f.lines.map((l) => l.newLine ?? l.oldLine ?? 0))).length)
      for (const l of f.lines) {
        const bg = l.kind === "add" ? t.diffAddedBg : l.kind === "del" ? t.diffRemovedBg : undefined
        const fg = l.kind === "add" ? t.diffAdded : l.kind === "del" ? t.diffRemoved : t.diffContext
        const n = l.kind === "del" ? (l.oldLine ?? 0) : (l.newLine ?? 0)
        const ln = String(n || "").padStart(numW)
        const sign = l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "
        out.push({
          line: {
            bg,
            segs: [
              { text: `${ln} ${sign} `, fg: l.kind === "ctx" ? t.diffLineNumber : fg, bg },
              { text: clip(l.text, width - numW - 5), fg, bg },
            ],
          },
          target: { path: f.path ?? "?", line: n, text: l.text },
        })
        for (const c of comments().filter((x) => x.path === f.path && x.line === n && x.snippet === l.text))
          out.push({
            line: {
              segs: [
                { text: `${" ".repeat(numW)}   ✎ `, fg: t.accent },
                { text: clip(c.text, width - numW - 8), fg: t.text, bold: true },
              ],
            },
          })
      }
      out.push({ line: { segs: [] } })
    }
    return out
  })

  const view = createMemo<Line[]>(() => {
    const t = ui.theme()
    return rows().map((r, i) =>
      i === cursor() && r.target
        ? { ...r.line, segs: [{ text: "▎", fg: t.primary, bg: r.line.bg }, ...r.line.segs.map((s, k) => (k === 0 ? { ...s, text: s.text.slice(1) } : s))] }
        : r.line,
    )
  })

  const move = (d: number) => {
    const list = rows()
    let i = cursor()
    for (let step = 0; step < list.length; step++) {
      i = Math.max(0, Math.min(list.length - 1, i + d))
      if (list[i]?.target || i === 0 || i === list.length - 1) break
    }
    setCursor(i)
    if (scroll) {
      const top = scroll.scrollTop
      if (i < top + 2) scroll.scrollTo(Math.max(0, i - 2))
      else if (i > top + viewH() - 3) scroll.scrollTo(i - viewH() + 3)
    }
  }

  const send = async () => {
    const list = comments()
    if (!list.length || !agentId || !ui.client) return ui.toast("no comments yet — c on a line adds one", "warn")
    const body = `Review comments on your changes — please address each, then report:\n${list.map((c) => `- ${c.path}:${c.line} (\`${c.snippet.trim().slice(0, 60)}\`): ${c.text}`).join("\n")}`
    try {
      await ui.client.call("bus.send", { to: agentId, body, kind: "request", delivery: "queue" })
      ui.toast(`sent ${list.length} comment${list.length === 1 ? "" : "s"} to ${name}`)
      setComments([])
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  useKeyboard((k) => {
    if (editing()) {
      if (k.name === "escape") setEditing(false)
      return
    }
    const ks = keyString(k)
    if (k.name === "escape" || ks === "q") props.onClose()
    else if (k.name === "down" || ks === "j") move(1)
    else if (k.name === "up" || ks === "k") move(-1)
    else if (k.name === "pagedown" || ks === "ctrl+d") move(viewH() - 2)
    else if (k.name === "pageup" || ks === "ctrl+u") move(-(viewH() - 2))
    else if (ks === "c") {
      if (rows()[cursor()]?.target) setTimeout(() => setEditing(true), 0)
      else ui.toast("move to a diff line first (j/k)", "warn")
    } else if (ks === "shift+c") void send()
    else if (ks === "m" && agentId)
      void act(ui, ui.client?.call("workspace.merge", { agentId }), (r) => (r.status === "merged" ? `merged ${name}` : `${r.status}: ${r.detail ?? ""}`))
  })

  // start on the first diff line once loaded
  createEffect(() => {
    const list = rows()
    if (cursor() === 0 && !list[0]?.target) {
      const first = list.findIndex((r) => r.target)
      if (first > 0) setCursor(first)
    }
  })

  return (
    <Modal
      title={`Diff · ${name}${comments().length ? ` · ${comments().length} comment${comments().length === 1 ? "" : "s"}` : ""}`}
      width={w()}
      height={dims().height - 2}
      hint={editing() ? "enter save comment · esc cancel" : "j/k move · c comment · C send comments · m merge · esc back"}
    >
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          scroll = r
        }}
        flexGrow={1}
        scrollY
      >
        <Txt value={toStyled(view(), w() - 4)} />
      </scrollbox>
      <Show when={editing()}>
        <box height={1} flexDirection="row">
          <Txt value={segs({ text: `✎ ${rows()[cursor()]?.target?.path}:${rows()[cursor()]?.target?.line} `, fg: ui.theme().accent })} />
          <input
            ref={(r: InputRenderable) => {
              inputRef = r
            }}
            flexGrow={1}
            focused
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            textColor={ui.theme().text}
            focusedTextColor={ui.theme().text}
            placeholder="what should change here?"
            onSubmit={
              ((v: unknown) => {
                const text = (typeof v === "string" ? v : (inputRef?.value ?? "")).trim()
                const tgt = rows()[cursor()]?.target
                setEditing(false)
                if (text && tgt) setComments((cs) => [...cs, { path: tgt.path, line: tgt.line, snippet: tgt.text, text }])
              }) as never
            }
          />
        </box>
      </Show>
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
  // edits made here travel with the approval, so the orchestrator follows the edited plan
  const [edits, setEdits] = createSignal<string[]>([])
  const [renaming, setRenaming] = createSignal(false)
  let renameRef: InputRenderable | undefined
  const proposed = () => ui.run.plan?.status === "proposed"
  useKeyboard((k) => {
    if (renaming()) {
      if (k.name === "escape") setRenaming(false)
      return
    }
    const n = tasks().length
    const ks = keyString(k)
    const cur = tasks()[sel()]
    if (k.name === "escape" || ks === "q") props.onClose()
    else if (k.name === "down" || ks === "j") setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "up" || ks === "k") setSel((s) => (n ? (s - 1 + n) % n : 0))
    else if (ks === "a" && proposed()) {
      const notes = edits().length ? `The user edited the plan: ${edits().join("; ")}. Follow the edited plan.` : undefined
      void act(ui, ui.client?.call("plan.decide", { approved: true, notes }), () => "plan approved")
      setEdits([])
    } else if (ks === "r" && proposed()) {
      props.onClose()
      props.onPrefill("/plan reject ")
    } else if (ks === "x" && cur && cur.state !== "canceled" && cur.state !== "completed") {
      void act(ui, ui.client?.call("task.edit", { taskId: cur.taskId, cancel: true }), () => `removed ${cur.taskId}`)
      setEdits((e) => [...e, `removed task ${cur.taskId} ("${cur.title}")`])
    } else if (ks === "e" && cur) setTimeout(() => setRenaming(true), 0)
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
      ...(plan?.status === "proposed" ? [{ text: "  a approve · r reject · e rename · x remove", fg: t.textMuted }] : []),
    ]
  }
  return (
    <Modal title="Task plan" width={96} height={24} hint="↑↓ select · e rename · x remove · a approve · esc">
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
        <Show when={renaming()}>
          <box height={1} flexDirection="row">
            <Txt value={segs({ text: `rename ${tasks()[sel()]?.taskId}: `, fg: ui.theme().accent })} />
            <input
              ref={(r: InputRenderable) => {
                renameRef = r
                r.value = tasks()[sel()]?.title ?? ""
              }}
              flexGrow={1}
              focused
              backgroundColor="transparent"
              focusedBackgroundColor="transparent"
              textColor={ui.theme().text}
              focusedTextColor={ui.theme().text}
              onSubmit={
                ((v: unknown) => {
                  const title = (typeof v === "string" ? v : (renameRef?.value ?? "")).trim()
                  const cur = tasks()[sel()]
                  setRenaming(false)
                  if (!title || !cur || title === cur.title) return
                  void act(ui, ui.client?.call("task.edit", { taskId: cur.taskId, title }), () => `renamed ${cur.taskId}`)
                  setEdits((e) => [...e, `task ${cur.taskId} is now "${title}"`])
                }) as never
              }
            />
          </box>
        </Show>
        <Show when={edits().length > 0}>
          <Txt value={segs({ text: `${edits().length} edit${edits().length === 1 ? "" : "s"} will be sent with your approval`, fg: ui.theme().warning })} />
        </Show>
      </Show>
    </Modal>
  )
}
