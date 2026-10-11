/**
 * The orchestrator pane: the lead agent's thread interleaved with agent↔agent bus traffic,
 * an approvals banner, the spinner line and the main input (with @mention / slash-command
 * completion and history).
 */

import type { FeedItem } from "@batonsh/kernel"
import { formatCost } from "@batonsh/kernel"
import type { InputRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { agentLook, whoFn } from "../agent-style.ts"
import { AUTONOMY_INFO, currentAutonomy } from "../autonomy.ts"
import { type Completion, completions } from "../completion.ts"
import { useUi } from "../context.ts"
import { clip, type Line, renderFeed, type Seg, statusLine, width as sw, wrap } from "../lines.ts"
import { Frame, innerSize } from "../ui/Frame.tsx"
import { segs, toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"

export interface OrchestratorProps {
  width: number
  height: number
  focused: boolean
  onSubmit: (text: string) => void
  /** Swarm layout: a single prompt row instead of a full pane. */
  slim?: boolean
}

export function Orchestrator(props: OrchestratorProps) {
  const ui = useUi()
  const [selected, setSelected] = createSignal(0)
  const history: string[] = []
  let historyIdx = -1
  let inputRef: InputRenderable | undefined

  // only "changes" when the lead's own events change (not on every worker event)
  const orchVer = createMemo(() => {
    ui.version()
    const id = ui.run.orchestratorId
    return `${id}|${id ? (ui.run.agentVersions.get(id) ?? 0) : 0}`
  })
  const orch = createMemo(() => {
    orchVer()
    const id = ui.run.orchestratorId
    const a = id ? ui.run.agents.get(id) : undefined
    return a && a.status !== "exited" ? { ...a } : undefined
  })

  // approvals and plan status change on workers' events too: track them (not just the lead's version)
  const pending = createMemo(
    () => {
      ui.version()
      return { approvals: ui.run.approvals.size, plan: ui.run.plan?.status, tasks: ui.run.tasks.size }
    },
    undefined,
    { equals: (a, b) => !!a && !!b && a.approvals === b.approvals && a.plan === b.plan && a.tasks === b.tasks },
  )

  const workers = createMemo(
    () => {
      ui.version()
      return ui.run.workers().map((w) => ({ ...w }))
    },
    [],
    {
      equals: (a, b) => a.length === b.length && a.every((x, i) => x.agentId === b[i]?.agentId && x.status === b[i]?.status && x.toolCalls === b[i]?.toolCalls),
    },
  )

  const headerRight = (): Seg[] => {
    const t = ui.theme()
    const o = orch()
    const adapter = o?.adapter ?? ui.config.orchestrator.agent
    const model = o?.model ?? ui.config.orchestrator.model
    const ws = workers()
    const out: Seg[] = []
    if (ui.run.tasks.size) {
      const tasks = [...ui.run.tasks.values()]
      out.push({ text: `▤ ${tasks.filter((x) => x.state === "completed").length}/${tasks.length}`, fg: t.accent }, { text: " · ", fg: t.textMuted })
    }
    if (ws.length) {
      const done = ws.filter((w) => w.status === "ready" && w.toolCalls > 0).length
      out.push({ text: `✓ ${done}/${ws.length}`, fg: t.success }, { text: " · ", fg: t.textMuted })
    }
    const cost = ui.run.totals.costUsd
    if (cost > 0) out.push({ text: formatCost(cost), fg: t.textMuted }, { text: " · ", fg: t.textMuted })
    out.push({ text: `${adapter}${model ? ` · ${model}` : ""}`, fg: t.textMuted })
    return out
  }

  const autonomy = () => currentAutonomy(ui)
  const yolo = () => autonomy() === "yolo"

  const inner = () => innerSize(props.width, props.height, ui.prefs.border, 1, ui.prefs.frame)

  const suggestions = createMemo<Completion[]>(() => {
    ui.version()
    if (!props.focused) return []
    return completions(ui.input(), ui.run, ui.config)
  })

  const infoLines = (): Line[] => {
    const t = ui.theme()
    const ws = workers()
    const counts = new Map<string, number>()
    for (const w of ws) {
      const k = agentLook(ui, w).icon.id
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const desc =
      ws.length === 0
        ? "no subagents yet"
        : [...counts].map(([k, n]) => `${n} ${k}`).join(", ") +
          ` subagent${ws.length === 1 ? "" : "s"} ${ws.some((w) => w.status === "busy") ? "working" : "ready"}`
    return [
      {
        segs: [
          { text: "/agents", fg: t.text },
          { text: ` · ${desc}`, fg: t.textMuted },
        ],
      },
      {
        segs: [
          { text: "mode: ", fg: t.textMuted },
          { text: ui.run.mode, fg: t.text },
          { text: "  ·  autonomy: ", fg: t.textMuted },
          {
            text: `${AUTONOMY_INFO[autonomy()].glyph} ${AUTONOMY_INFO[autonomy()].label}`,
            fg: autonomy() === "normal" ? t.text : t[AUTONOMY_INFO[autonomy()].token],
            bold: autonomy() !== "normal",
          },
          { text: "  shift+tab", fg: t.textSubtle },
        ],
      },
    ]
  }

  /** Lead thread + agent↔agent chatter, ordered by time. */
  const threadKey = createMemo(() => {
    ui.version()
    const id = ui.run.orchestratorId
    return `${id}|${id ? (ui.run.agentVersions.get(id) ?? 0) : 0}|${ui.run.busVersion}`
  })
  const thread = createMemo(() => {
    threadKey()
    const id = ui.run.orchestratorId
    const items: FeedItem[] = id ? [...ui.run.feed(id).items] : []
    for (const m of ui.run.bus.slice(-300)) {
      if (m.kind === "heartbeat" || m.kind === "progress") continue
      if (m.from === id || m.to === id) continue // already in the lead's own feed
      items.push({ kind: "bus", id: `b_${m.messageId}`, from: m.from, to: m.to, body: m.body, direction: "in", ts: m.ts })
    }
    items.sort((a, b) => a.ts - b.ts)
    return items
  })

  const body = createMemo(() => {
    const t = ui.theme()
    const { width } = inner()
    const o = orch()
    const look = o ? agentLook(ui, o).look : "claude"
    const lines: Line[] = [...infoLines()]
    const feed = renderFeed(thread().slice(-80), {
      theme: t,
      width,
      look,
      showThoughts: ui.prefs.show_thoughts,
      markdown: ui.prefs.markdown,
      maxDiffLines: 4,
      maxOutputLines: 2,
      who: whoFn(ui),
      me: ui.me,
    })
    lines.push(...feed)
    if (!o && thread().length === 0) {
      lines.push({ segs: [{ text: "" }] })
      for (const l of wrap(
        "Type a task for the orchestrator, @name to talk to an agent directly, or /spawn codex 3 to start agents. ctrl+p for everything else.",
        width,
      ))
        lines.push({ segs: [{ text: l, fg: t.textMuted }] })
    }
    const rows = bodyRows()
    const visible = lines.slice(-rows)
    // bottom-align: pad above so the newest line sits right above the status/input rows
    while (visible.length < rows) visible.unshift({ segs: [{ text: "" }] })
    return visible
  })

  function bodyRows() {
    return Math.max(1, inner().height - 1 - Math.min(6, suggestions().length) - status().length)
  }

  function status(): Line[] {
    const o = orch()
    const t = ui.theme()
    const frames = ui.spinnerFrames()
    const out: Line[] = []
    const p = pending()
    if (p.plan === "proposed") {
      out.push({
        segs: [
          { text: "◆ ", fg: t.warning, bold: true },
          { text: `plan proposed: ${p.tasks} tasks`, fg: t.warning, bold: true },
          { text: " — ctrl+g to review · /plan approve · /plan reject <why>", fg: t.textMuted },
        ],
      })
    }
    if (p.approvals) {
      out.push({
        segs: [
          { text: "▲ ", fg: t.warning, bold: true },
          { text: `${p.approvals} approval${p.approvals > 1 ? "s" : ""} pending`, fg: t.warning, bold: true },
          { text: " — ctrl+a to review, ctrl+y to allow the oldest", fg: t.textMuted },
        ],
      })
    }
    if (o && o.status !== "ready") {
      const busyWorkers = workers().filter((w) => w.status === "busy").length
      out.push(
        statusLine(o, {
          theme: t,
          look: "claude",
          frame: frames[ui.frame() % frames.length] ?? "·",
          verbs: ui.verbs,
          now: ui.now(),
          orchestrator: true,
          subagents: busyWorkers,
        }),
      )
    }
    return out
  }

  const applyCompletion = (c: Completion) => {
    ui.setInput(c.replace)
    if (inputRef) {
      inputRef.value = c.replace
      inputRef.cursorOffset = c.replace.length
    }
  }

  // programmatic input changes (prefill from m / palette "Message: …") → the input element
  createEffect(() => {
    const v = ui.input()
    if (inputRef && inputRef.value !== v) {
      inputRef.value = v
      inputRef.cursorOffset = v.length
    }
  })

  const submit = (value: string) => {
    const text = value.trim()
    if (!text) return
    history.unshift(text)
    if (history.length > 200) history.length = 200
    historyIdx = -1
    ui.setInput("")
    if (inputRef) inputRef.value = ""
    props.onSubmit(text)
  }

  // keys that the input itself doesn't handle: completion + history
  const onKey = (key: { name: string; preventDefault?: () => void }) => {
    const sug = suggestions()
    if (sug.length) {
      if (key.name === "tab") {
        applyCompletion(sug[Math.min(selected(), sug.length - 1)]!)
        setSelected(0)
        key.preventDefault?.()
        return
      }
      if (key.name === "down") {
        setSelected((s) => (s + 1) % sug.length)
        key.preventDefault?.()
        return
      }
      if (key.name === "up") {
        setSelected((s) => (s - 1 + sug.length) % sug.length)
        key.preventDefault?.()
        return
      }
    }
    if (key.name === "up" && history.length) {
      historyIdx = Math.min(history.length - 1, historyIdx + 1)
      applyCompletion({ replace: history[historyIdx]!, label: "", detail: "" })
      key.preventDefault?.()
    } else if (key.name === "down" && historyIdx >= 0) {
      historyIdx--
      applyCompletion({ replace: historyIdx >= 0 ? history[historyIdx]! : "", label: "", detail: "" })
      key.preventDefault?.()
    }
  }

  const prompt = () => {
    const t = ui.theme()
    return segs({ text: "❯ ", fg: props.focused ? t.primary : t.textMuted, bold: true })
  }

  const inputEl = () => (
    <box height={1} flexDirection="row">
      <Txt value={prompt()} />
      <input
        ref={(r: InputRenderable) => {
          inputRef = r
        }}
        flexGrow={1}
        focused={props.focused && ui.overlay() === null && !ui.overlayClosing() && !ui.replay}
        placeholder={
          ui.replay
            ? "replay — read only · space play/pause · esc back"
            : orch()
              ? "message the orchestrator · @agent · /command"
              : "what should we build? · @agent · /spawn codex 3"
        }
        backgroundColor="transparent"
        focusedBackgroundColor="transparent"
        textColor={ui.theme().text}
        focusedTextColor={ui.theme().text}
        placeholderColor={ui.theme().textSubtle}
        cursorColor={ui.theme().primary}
        onInput={(v: string) => {
          ui.setInput(v)
          setSelected(0)
        }}
        onSubmit={((v: unknown) => submit(typeof v === "string" ? v : (inputRef?.value ?? ""))) as never}
        onKeyDown={onKey}
      />
    </box>
  )

  // One padded text block (not a <For> of rows): reactive StyledText children re-rendered in
  // place would otherwise accumulate, and the window scrolls with the selection.
  const SUGGEST_ROWS = 6
  const suggestionLines = (): Line[] => {
    const sug = suggestions()
    const t = ui.theme()
    const sel = Math.min(selected(), sug.length - 1)
    const start = Math.max(0, Math.min(sel - SUGGEST_ROWS + 1, sug.length - SUGGEST_ROWS))
    const w = inner().width
    return sug.slice(start, start + SUGGEST_ROWS).map((s, k) => {
      const active = start + k === sel
      const more = k === SUGGEST_ROWS - 1 && start + SUGGEST_ROWS < sug.length ? ` +${sug.length - start - SUGGEST_ROWS}` : ""
      return {
        segs: [
          { text: active ? "› " : "  ", fg: t.primary, bg: active ? t.selection : undefined },
          { text: s.label, fg: active ? t.text : t.textMuted, bold: active, bg: active ? t.selection : undefined },
          { text: `  ${clip(s.detail, Math.max(0, w - sw(s.label) - 6 - more.length))}`, fg: t.textSubtle, bg: active ? t.selection : undefined },
          { text: more, fg: t.textSubtle },
        ],
        bg: active ? t.selection : undefined,
      }
    })
  }

  const suggestionBox = () => (
    <Show when={suggestions().length > 0}>
      <Txt height={Math.min(SUGGEST_ROWS, suggestions().length)} wrapMode="none" value={toStyled(suggestionLines(), inner().width)} />
    </Show>
  )

  // swarm layout: `› <current task> ─────────── 76%` above the input, like a progress header
  const swarmHeader = () => {
    const t = ui.theme()
    const id = ui.run.orchestratorId
    const lastPrompt = id ? [...ui.run.feed(id).items].reverse().find((i) => i.kind === "user" && !i.text.startsWith("[baton]")) : undefined
    const ws = workers()
    const pct = ws.length ? Math.round((ws.reduce((n, w) => n + (w.progress ?? (w.status === "ready" && w.toolCalls > 0 ? 1 : 0)), 0) / ws.length) * 100) : 0
    const task = lastPrompt && lastPrompt.kind === "user" ? lastPrompt.text.split("\n")[0]! : "no task yet"
    const right = `${pct}%`
    const barW = Math.max(6, Math.min(24, Math.floor(props.width / 6)))
    const filled = Math.round((pct / 100) * barW)
    const head = clip(task, Math.max(10, props.width - barW - right.length - 8))
    const gap = Math.max(1, props.width - 2 - sw(head) - barW - right.length - 3)
    return toStyled(
      [
        {
          segs: [
            { text: "❯ ", fg: t.primary, bold: true },
            { text: head, fg: t.text, bold: true },
            { text: " ".repeat(gap) },
            { text: "━".repeat(filled), fg: t.accent },
            { text: "─".repeat(barW - filled), fg: t.borderSubtle },
            { text: `  ${right}`, fg: t.textMuted },
          ],
        },
      ],
      props.width,
    )
  }

  const slim = () => (
    <box height={2 + Math.min(6, suggestions().length)} width={props.width} flexDirection="column" backgroundColor={ui.theme().background}>
      <Txt height={1} value={swarmHeader()} />
      {suggestionBox()}
      {inputEl()}
    </box>
  )

  // reactive: switching to/from the swarm layout at runtime swaps the pane
  return (
    <Show when={!props.slim} fallback={slim()}>
      <Frame
        width={props.width}
        height={props.height}
        border={ui.prefs.border}
        borderColor={yolo() ? ui.theme().error : props.focused ? ui.theme().borderActive : ui.theme().border}
        focused={props.focused}
        accent={yolo() ? ui.theme().error : ui.theme().primary}
        icon={{ text: orch() ? agentLook(ui, orch()!).glyph : "✱", fg: ui.theme().primary, bold: true }}
        logo={orch() ? agentLook(ui, orch()!).logo : undefined}
        title={[{ text: "orchestrator", fg: ui.theme().text, bold: true }]}
        right={headerRight()}
      >
        <box height={bodyRows()} overflow="hidden">
          <Txt height={bodyRows()} wrapMode="none" value={toStyled(body(), inner().width)} />
        </box>
        <Show when={status().length > 0}>
          <Txt height={status().length} wrapMode="none" value={toStyled(status(), inner().width)} />
        </Show>
        {suggestionBox()}
        {inputEl()}
      </Frame>
    </Show>
  )
}
