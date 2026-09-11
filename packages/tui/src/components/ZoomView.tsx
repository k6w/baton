/** Full-size view of one agent with its complete, scrollable history. */
import type { ScrollBoxRenderable } from "@opentui/core"
import { createMemo } from "solid-js"
import { agentLook, whoFn } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { identityLines, renderFeed, statusLine } from "../lines.ts"
import { Frame, innerSize } from "../ui/Frame.tsx"
import { segs, toStyled } from "../ui/styled.ts"

export function ZoomView(props: { agentId: string; width: number; height: number }) {
  const ui = useUi()
  const ver = createMemo(() => {
    ui.version()
    return ui.run.agentVersions.get(props.agentId) ?? 0
  })
  const agent = createMemo(() => {
    ver()
    const a = ui.run.agents.get(props.agentId)
    return a ? { ...a } : undefined
  })
  const look = createMemo(() => (agent() ? agentLook(ui, agent()!) : undefined))
  const inner = () => innerSize(props.width, props.height, ui.prefs.border)
  const lines = createMemo(() => {
    const a = agent()
    const l = look()
    if (!a || !l) return []
    const head = identityLines(a, { theme: ui.theme(), glyph: l.glyph, fields: ["version", "model", "dir", "approval", "role", "session"], home: ui.home })
    const feed = renderFeed(ui.run.feed(props.agentId).items, {
      theme: ui.theme(),
      width: inner().width - 1,
      look: l.look,
      showThoughts: true,
      maxDiffLines: Number.POSITIVE_INFINITY,
      maxOutputLines: 40,
      who: whoFn(ui),
    })
    return [...head, { segs: [{ text: "" }] }, ...feed]
  })
  const status = () => {
    const a = agent()
    const l = look()
    if (!a || !l) return []
    const frames = ui.spinnerFrames()
    return [statusLine(a, { theme: ui.theme(), look: l.look, frame: frames[ui.frame() % frames.length] ?? "·", verbs: ui.verbs, now: ui.now() })]
  }
  const usage = () => {
    const a = agent()
    const t = ui.theme()
    if (!a) return []
    return [
      { text: `${a.toolCalls} calls`, fg: t.textMuted },
      { text: " · ", fg: t.textSubtle },
      { text: `+${a.diff.added} -${a.diff.removed}`, fg: t.textMuted },
      { text: " · ", fg: t.textSubtle },
      { text: `$${a.usage.costUsd.toFixed(2)}`, fg: t.textMuted },
      { text: "  esc to close", fg: t.textSubtle },
    ]
  }
  let _scroll: ScrollBoxRenderable | undefined
  return (
    <Frame
      width={props.width}
      height={props.height}
      border={ui.prefs.border}
      borderColor={ui.theme().borderActive}
      icon={look() ? { text: look()!.glyph, fg: look()!.color, bold: true } : undefined}
      logo={look()?.logo}
      title={[
        { text: agent()?.name ?? "?", fg: ui.theme().text, bold: true },
        { text: agent()?.label ? ` · ${agent()!.label}` : "", fg: ui.theme().textMuted },
      ]}
      right={usage()}
    >
      <scrollbox
        ref={(r: ScrollBoxRenderable) => {
          _scroll = r
        }}
        flexGrow={1}
        stickyScroll
        stickyStart="bottom"
        focused={ui.overlay() === null}
        scrollY
      >
        <text wrapMode="none">{toStyled(lines(), inner().width - 1)}</text>
      </scrollbox>
      <text wrapMode="none">{toStyled(status(), inner().width)}</text>
      <text wrapMode="none" height={0}>
        {segs({ text: "", fg: ui.theme().textMuted })}
      </text>
    </Frame>
  )
}
