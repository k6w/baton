/** One agent in the grid: header (icon, name, label), live activity, status line. */

import type { AgentView } from "@batonsh/protocol"
import { createMemo } from "solid-js"
import { agentLook, whoFn } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { identityLines, type Line, renderFeed, statusLine, workspaceLine } from "../lines.ts"
import { Frame, innerSize } from "../ui/Frame.tsx"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"

export function AgentCard(props: { agentId: string; width: number; height: number; focused: boolean; onSelect?: () => void; onZoom?: () => void }) {
  const ui = useUi()
  // re-evaluated every tick (cheap) but only *changes* when this agent's events change
  const ver = createMemo(() => {
    ui.version()
    return ui.run.agentVersions.get(props.agentId) ?? 0
  })
  const agent = createMemo(() => {
    ver()
    const a = ui.run.agents.get(props.agentId)
    return a ? { ...a } : undefined
  })
  const look = createMemo(() => {
    const a = agent()
    return a ? agentLook(ui, a) : undefined
  })
  const inner = () => innerSize(props.width, props.height, ui.prefs.border)

  const wsLine = createMemo(() => {
    ver()
    return workspaceLine(ui.run.workspaces.get(props.agentId), { theme: ui.theme(), width: inner().width, who: whoFn(ui) })
  })

  // Body lines are recomputed only when this agent's events change (or size/theme/prefs).
  let cacheKey = ""
  let cached: Line[] = []
  const body = createMemo(() => {
    const a = agent()
    const l = look()
    if (!a || !l) return []
    const v = ver()
    const { width, height } = inner()
    const key = `${v}|${width}|${height}|${ui.theme().name}|${ui.prefs.render_style}|${ui.prefs.show_thoughts}|${ui.prefs.density}`
    if (key === cacheKey) return cached
    const feed = ui.run.feed(props.agentId).items
    const compact = ui.prefs.density === "compact"
    let lines: Line[]
    if (feed.length === 0) {
      lines = identityLines(a, { theme: ui.theme(), glyph: l.glyph, fields: ui.config.ui.card_fields, home: ui.home })
    } else {
      lines = renderFeed(feed.slice(-60), {
        theme: ui.theme(),
        width,
        look: l.look,
        showThoughts: ui.prefs.show_thoughts,
        maxDiffLines: compact ? 2 : 4,
        maxOutputLines: compact ? 1 : 2,
        who: whoFn(ui),
        compact: true,
      })
    }
    const bodyH = Math.max(0, height - (wsLine() ? 2 : 1))
    cached = lines.slice(-bodyH)
    cacheKey = key
    return cached
  })

  const status = createMemo(() => {
    const a = agent()
    const l = look()
    if (!a || !l) return []
    const frames = ui.spinnerFrames()
    const line = statusLine(a, { theme: ui.theme(), look: l.look, frame: frames[ui.frame() % frames.length] ?? "·", verbs: ui.verbs, now: ui.now() })
    const ws = wsLine()
    return ws ? [ws, line] : [line]
  })

  const borderColor = () => {
    const t = ui.theme()
    const a = agent()
    if (props.focused) return t.borderActive
    if (a?.status === "awaiting_approval") return t.stateWaiting
    if (a?.status === "error") return t.stateError
    if (a?.status === "exited") return t.borderSubtle
    return t.border
  }

  const label = () => {
    const a = agent()
    if (!a) return []
    const t = ui.theme()
    const pct = a.progress !== undefined && a.status === "busy" ? ` ${Math.round(a.progress * 100)}%` : ""
    const text = a.label ?? a.role ?? ""
    return text || pct ? [{ text: `${text}${pct}`, fg: t.textMuted }] : []
  }

  return (
    <Frame
      width={props.width}
      height={props.height}
      border={ui.prefs.border}
      borderColor={borderColor()}
      icon={look() ? { text: look()!.glyph, fg: look()!.color, bold: true } : undefined}
      logo={look()?.logo}
      title={[{ text: agent()?.name ?? "?", fg: ui.theme().text, bold: true }]}
      right={label()}
      onMouseDown={() => {
        props.onSelect?.()
      }}
    >
      <box flexGrow={1} overflow="hidden">
        <Txt wrapMode="none" value={toStyled(body(), inner().width, Math.max(0, inner().height - status().length))} />
      </box>
      <box height={status().length}>
        <Txt wrapMode="none" value={toStyled(status(), inner().width, status().length)} />
      </box>
    </Frame>
  )
}

export type { AgentView }
