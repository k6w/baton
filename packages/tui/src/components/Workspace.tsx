/** Workspace overlays: Changes (per-worker branches), Diff viewer, Task plan. */

import type { WorkspaceView } from "@batonsh/kernel"
import { parseUnifiedDiff } from "@batonsh/protocol"
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createResource, createSignal, Show } from "solid-js"
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

type PlanField = "title" | "details" | "acceptance" | "deps" | "new"

/**
 * The task plan as an editable table: reorder (J/K), retitle (e), details (d), acceptance check
 * (c), dependencies (p), preferred agent (g), add (n), remove (x). While a plan is proposed, every
 * edit is summarised and sent to the orchestrator with your approval.
 */
export function TasksOverlay(props: { onClose: () => void; onPrefill: (text: string) => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const [sel, setSel] = createSignal(0)
  const tasks = createMemo(() => {
    ui.version()
    return ui.run.orderedTasks().map((t) => ({ ...t }))
  })
  const [edits, setEdits] = createSignal<string[]>([])
  const [field, setField] = createSignal<PlanField | null>(null)
  let inputRef: InputRenderable | undefined
  const proposed = () => ui.run.plan?.status === "proposed"
  const [agents] = createResource(async () =>
    ui.client
      ? (await ui.client.call("agents.detect", {}).catch(() => ({ adapters: [] }))).adapters
          .filter((a) => a.installed && a.id !== "acp" && a.id !== "exec")
          .map((a) => a.id)
      : [],
  )
  const agentChoices = () => ["", ...Object.keys(ui.config.agents), ...(agents() ?? [])]
  const note = (text: string) => setEdits((e) => [...e, text])
  const cur = () => tasks()[Math.min(sel(), tasks().length - 1)]
  const open = (f: PlanField) => setTimeout(() => setField(f), 0)

  useKeyboard((k) => {
    if (field()) {
      if (k.name === "escape") setField(null)
      return
    }
    const n = tasks().length
    const ks = keyString(k)
    const t = cur()
    if (k.name === "escape" || ks === "q") {
      // edits to a plan that's already running go straight to the lead
      if (edits().length && !proposed() && ui.run.orchestratorId)
        void act(
          ui,
          ui.client?.send("orchestrator", `The user edited the task plan: ${edits().join("; ")}. Adjust the work accordingly.`),
          () => "plan changes sent to the lead",
        )
      props.onClose()
    } else if (k.name === "down" || ks === "j") setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "up" || ks === "k") setSel((s) => (n ? (s - 1 + n) % n : 0))
    else if ((ks === "shift+j" || ks === "shift+k") && t) {
      const dir = ks === "shift+j" ? "down" : "up"
      const i = tasks().findIndex((x) => x.taskId === t.taskId)
      if ((dir === "up" && i === 0) || (dir === "down" && i === n - 1)) return
      void act(ui, ui.client?.call("task.edit", { taskId: t.taskId, move: dir }), () => undefined)
      setSel(i + (dir === "down" ? 1 : -1))
      note(`moved ${t.taskId} ${dir}`)
    } else if (ks === "a" && proposed()) {
      const order = tasks()
        .filter((x) => x.state !== "canceled")
        .map((x) => x.taskId)
        .join(", ")
      const notes = edits().length ? `The user edited the plan: ${edits().join("; ")}. Task order is now: ${order}. Follow the edited plan.` : undefined
      void act(ui, ui.client?.call("plan.decide", { approved: true, notes }), () => "plan approved")
      setEdits([])
    } else if (ks === "r" && proposed()) {
      props.onClose()
      props.onPrefill("/plan reject ")
    } else if (ks === "x" && t && t.state !== "canceled" && t.state !== "completed") {
      void act(ui, ui.client?.call("task.edit", { taskId: t.taskId, cancel: true }), () => `removed ${t.taskId}`)
      note(`removed task ${t.taskId} ("${t.title}")`)
    } else if (ks === "g" && t) {
      const choices = agentChoices()
      const next = choices[(choices.indexOf(t.agent ?? "") + 1) % choices.length] ?? ""
      void act(ui, ui.client?.call("task.edit", { taskId: t.taskId, agent: next }), () => undefined)
      note(next ? `task ${t.taskId} should be done by ${next}` : `task ${t.taskId}: any agent`)
    } else if (ks === "e" && t) open("title")
    else if (ks === "d" && t) open("details")
    else if (ks === "c" && t) open("acceptance")
    else if (ks === "p" && t) open("deps")
    else if (ks === "n") open("new")
  })

  const commit = (raw: string) => {
    const f = field()
    const t = cur()
    setField(null)
    const v = raw.trim()
    if (f === "new") {
      if (!v) return
      void act(ui, ui.client?.call("task.add", { title: v }), (r) => {
        note(`added task ${r.taskId} ("${v}")`)
        return `added ${r.taskId}`
      })
      return
    }
    if (!t) return
    if (f === "title" && v && v !== t.title) {
      void act(ui, ui.client?.call("task.edit", { taskId: t.taskId, title: v }), () => undefined)
      note(`task ${t.taskId} is now "${v}"`)
    } else if (f === "details" && v !== (t.note ?? "")) {
      void act(ui, ui.client?.call("task.edit", { taskId: t.taskId, description: v }), () => undefined)
      note(`task ${t.taskId} details: ${v}`)
    } else if (f === "acceptance" && v !== (t.acceptance ?? "")) {
      void act(ui, ui.client?.call("task.edit", { taskId: t.taskId, acceptance: v }), () => undefined)
      note(`task ${t.taskId} is done when: ${v || "(no check)"}`)
    } else if (f === "deps") {
      const deps = v
        .split(/[,\s]+/)
        .filter(Boolean)
        .filter((d) => d !== t.taskId)
      const unknown = deps.filter((d) => !ui.run.tasks.has(d))
      if (unknown.length) return ui.toast(`no task ${unknown.join(", ")}`, "error")
      void act(ui, ui.client?.call("task.edit", { taskId: t.taskId, deps }), () => undefined)
      note(deps.length ? `task ${t.taskId} waits for ${deps.join(", ")}` : `task ${t.taskId} has no prerequisites`)
    }
  }

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
            : state === "canceled"
              ? t.textSubtle
              : t.textMuted
  }
  const W = () => Math.min(110, dims().width - 4)
  const H = () => Math.min(30, dims().height - 2)
  const listH = () => Math.max(3, H() - 13)

  const header = (): Line => {
    const t = ui.theme()
    const all = tasks().filter((x) => x.state !== "canceled")
    const done = all.filter((x) => x.state === "completed").length
    const plan = ui.run.plan
    return {
      segs: [
        ...(plan
          ? [{ text: `◆ plan ${plan.status}`, fg: plan.status === "proposed" ? t.warning : plan.status === "approved" ? t.success : t.error, bold: true }]
          : []),
        { text: `${plan ? "  ·  " : ""}${done}/${all.length} done`, fg: t.text },
        ...(proposed() ? [{ text: "    a approve · r reject", fg: t.textMuted }] : []),
      ],
    }
  }

  const rows = createMemo<Line[]>(() => {
    const t = ui.theme()
    const w = W() - 4
    const titleW = Math.max(16, w - 46)
    const out: Line[] = [
      {
        segs: [
          { text: "  #  ", fg: t.textSubtle },
          { text: "   id      ", fg: t.textSubtle },
          { text: "task".padEnd(titleW), fg: t.textSubtle },
          { text: " agent       after       owner", fg: t.textSubtle },
        ],
      },
    ]
    const list = tasks()
    const s = Math.min(sel(), list.length - 1)
    const start = Math.max(0, Math.min(s - Math.floor(listH() / 2), list.length - listH()))
    for (const [i, x] of list.slice(start, start + listH()).entries()) {
      const on = start + i === s
      const bg = on ? t.selection : undefined
      const owner = x.owner ? whoFn(ui)(x.owner) : undefined
      const gone = x.state === "canceled"
      const look = x.agent ? agentLook(ui, { adapter: x.agent, name: x.agent }) : undefined
      out.push({
        bg,
        segs: [
          { text: on ? "› " : "  ", fg: t.primary, bg },
          { text: String(start + i + 1).padStart(2), fg: t.textSubtle, bg },
          { text: ` ${STATE_ICON[x.state] ?? "·"} `, fg: color(x.state), bg },
          { text: x.taskId.padEnd(8), fg: t.textMuted, bg },
          { text: clip(x.title, titleW - 1).padEnd(titleW), fg: gone ? t.textSubtle : t.text, bold: on && !gone, bg },
          { text: " " },
          { text: clip(x.agent ? `${look?.glyph ?? ""} ${x.agent}` : "any", 11).padEnd(12), fg: x.agent ? (look?.color ?? t.accent) : t.textSubtle, bg },
          { text: clip(x.deps.length ? x.deps.join(",") : "—", 11).padEnd(12), fg: t.textMuted, bg },
          { text: clip(owner?.name ?? (gone ? "removed" : ""), 12), fg: owner?.color ?? t.textSubtle, bg },
        ],
      })
    }
    return out
  })

  const detail = createMemo<Line[]>(() => {
    const t = ui.theme()
    const x = cur()
    if (!x) return []
    const w = W() - 4
    const out: Line[] = [{ segs: [{ text: `${x.taskId} · ${x.title}`, fg: t.text, bold: true }] }]
    if (x.note) out.push({ segs: [{ text: clip(x.note.replace(/\s+/g, " "), w), fg: t.textMuted }] })
    if (x.acceptance)
      out.push({
        segs: [
          { text: "done when: ", fg: t.textSubtle },
          { text: clip(x.acceptance, w - 11), fg: t.success },
        ],
      })
    if (x.files?.length)
      out.push({
        segs: [
          { text: "files: ", fg: t.textSubtle },
          { text: clip(x.files.join(", "), w - 7), fg: t.textMuted },
        ],
      })
    return out
  })

  const keys = (): Line => {
    const t = ui.theme()
    const k = (key: string, what: string): Seg[] => [
      { text: ` ${key} `, fg: t.text, bg: t.backgroundElement === "transparent" ? undefined : t.backgroundElement, bold: true },
      { text: ` ${what}  `, fg: t.textMuted },
    ]
    return {
      segs: [
        ...k("e", "title"),
        ...k("d", "details"),
        ...k("c", "done when"),
        ...k("g", "agent"),
        ...k("p", "after"),
        ...k("J/K", "move"),
        ...k("n", "new"),
        ...k("x", "remove"),
      ],
    }
  }

  const label: Record<PlanField, string> = { title: "title", details: "details", acceptance: "done when", deps: "after (task ids)", new: "new task" }
  const initial = (f: PlanField) => {
    const x = cur()
    if (!x || f === "new") return ""
    return f === "title" ? x.title : f === "details" ? (x.note ?? "") : f === "acceptance" ? (x.acceptance ?? "") : x.deps.join(", ")
  }

  return (
    <Modal title="Task plan" width={W()} height={H()} hint="↑↓ select · edit with the keys below · esc close">
      <Txt wrapMode="none" value={toStyled([header()], W() - 4)} />
      <Txt wrapMode="none" value={segs({ text: "─".repeat(W() - 4), fg: ui.theme().borderSubtle })} />
      <Show
        when={tasks().length > 0}
        fallback={
          <Txt value={segs({ text: "No plan yet — the orchestrator records one with plan_tasks. Press n to start one yourself.", fg: ui.theme().textMuted })} />
        }
      >
        <Txt wrapMode="none" height={listH() + 1} value={toStyled(rows(), W() - 4, listH() + 1)} />
        <Txt wrapMode="none" value={segs({ text: "─".repeat(W() - 4), fg: ui.theme().borderSubtle })} />
        <Txt wrapMode="none" height={4} value={toStyled(detail(), W() - 4, 4)} />
      </Show>
      <Show when={field()} fallback={<Txt wrapMode="none" value={toStyled([keys()], W() - 4)} />}>
        <box height={1} flexDirection="row">
          <Txt value={segs({ text: `${label[field()!]}: `, fg: ui.theme().accent, bold: true })} />
          <input
            ref={(r: InputRenderable) => {
              inputRef = r
              r.value = initial(field()!)
            }}
            flexGrow={1}
            focused
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            textColor={ui.theme().text}
            focusedTextColor={ui.theme().text}
            onSubmit={((v: unknown) => commit(typeof v === "string" ? v : (inputRef?.value ?? ""))) as never}
          />
        </box>
      </Show>
      <Show when={edits().length > 0 && proposed()}>
        <Txt value={segs({ text: `${edits().length} edit${edits().length === 1 ? "" : "s"} will be sent with your approval`, fg: ui.theme().warning })} />
      </Show>
    </Modal>
  )
}
