/**
 * The orchestrator pane: the lead agent's thread interleaved with agent↔agent bus traffic,
 * an approvals banner, the spinner line and the main input (with @mention / slash-command
 * completion and history).
 */

import type { FeedItem } from "@batonsh/kernel"
import { formatCost } from "@batonsh/kernel"
import type { InputRenderable } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { agentLook, whoFn } from "../agent-style.ts"
import { type Completion, completions } from "../completion.ts"
import { useUi } from "../context.ts"
import { clip, type Line, renderFeed, type Seg, statusLine, wrap } from "../lines.ts"
import { Frame, innerSize } from "../ui/Frame.tsx"
import { segs, toStyled } from "../ui/styled.ts"

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

  const orch = createMemo(() => {
    ui.version()
    const id = ui.run.orchestratorId
    const a = id ? ui.run.agents.get(id) : undefined
    return a && a.status !== "exited" ? { ...a } : undefined
  })

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
    if (ws.length) {
      const done = ws.filter((w) => w.status === "ready" && w.toolCalls > 0).length
      out.push({ text: `✓ ${done}/${ws.length}`, fg: t.success }, { text: " · ", fg: t.textMuted })
    }
    const cost = ui.run.totals.costUsd
    if (cost > 0) out.push({ text: formatCost(cost), fg: t.textMuted }, { text: " · ", fg: t.textMuted })
    out.push({ text: `${adapter}${model ? ` · ${model}` : ""}`, fg: t.textMuted })
    return out
  }

  const inner = () => innerSize(props.width, props.height, ui.prefs.border)

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
      maxDiffLines: 4,
      maxOutputLines: 2,
      who: whoFn(ui),
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
    if (ui.run.approvals.size) {
      out.push({
        segs: [
          { text: "⚠ ", fg: t.warning, bold: true },
          { text: `${ui.run.approvals.size} approval${ui.run.approvals.size > 1 ? "s" : ""} pending`, fg: t.warning, bold: true },
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

  const submit = (value: string) => {
    const text = value.trim()
    if (!text) return
    history.unshift(text)
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

  const inputEl = (
    <box height={1} flexDirection="row">
      <text wrapMode="none">{prompt()}</text>
      <input
        ref={(r: InputRenderable) => {
          inputRef = r
        }}
        flexGrow={1}
        focused={props.focused && ui.overlay() === null}
        placeholder={orch() ? "message the orchestrator · @agent · /command" : "what should we build? · @agent · /spawn codex 3"}
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

  const suggestionBox = () => (
    <Show when={suggestions().length > 0}>
      <box flexDirection="column" height={Math.min(6, suggestions().length)}>
        <For each={suggestions().slice(0, 6)}>
          {(s, i) => (
            <text wrapMode="none">
              {segs(
                { text: i() === selected() ? "› " : "  ", fg: ui.theme().primary },
                { text: s.label, fg: i() === selected() ? ui.theme().text : ui.theme().textMuted, bold: i() === selected() },
                { text: `  ${clip(s.detail, Math.max(0, inner().width - s.label.length - 6))}`, fg: ui.theme().textSubtle },
              )}
            </text>
          )}
        </For>
      </box>
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
    const gap = Math.max(1, props.width - 2 - head.length - barW - right.length - 3)
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

  if (props.slim) {
    return (
      <box height={2 + Math.min(6, suggestions().length)} width={props.width} flexDirection="column" backgroundColor={ui.theme().background}>
        <text height={1} wrapMode="none">
          {swarmHeader()}
        </text>
        {suggestionBox()}
        {inputEl}
      </box>
    )
  }

  return (
    <Frame
      width={props.width}
      height={props.height}
      border={ui.prefs.border}
      borderColor={props.focused ? ui.theme().borderActive : ui.theme().border}
      icon={{ text: orch() ? agentLook(ui, orch()!).glyph : "✱", fg: ui.theme().primary, bold: true }}
      logo={orch() ? agentLook(ui, orch()!).logo : undefined}
      title={[{ text: "orchestrator", fg: ui.theme().text, bold: true }]}
      right={headerRight()}
    >
      <box height={bodyRows()} overflow="hidden">
        <text height={bodyRows()} wrapMode="none">
          {toStyled(body(), inner().width)}
        </text>
      </box>
      <Show when={status().length > 0}>
        <text height={status().length} wrapMode="none">
          {toStyled(status(), inner().width)}
        </text>
      </Show>
      {suggestionBox()}
      {inputEl}
    </Frame>
  )
}
