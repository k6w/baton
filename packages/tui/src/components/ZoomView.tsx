/** Full-size view of one agent with its complete, scrollable history. */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { agentLook, whoFn } from "../agent-style.ts"
import { copyText } from "../clipboard.ts"
import { useUi } from "../context.ts"
import { identityLines, renderFeed, statusLine } from "../lines.ts"
import { Frame, innerSize } from "../ui/Frame.tsx"
import { segs, toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { findMatches, highlight, lineText } from "../zoom-text.ts"

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
  const inner = () => innerSize(props.width, props.height, ui.prefs.border, 1, ui.prefs.frame)
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
      markdown: ui.prefs.markdown,
      maxDiffLines: Number.POSITIVE_INFINITY,
      maxOutputLines: 40,
      who: whoFn(ui),
      me: ui.me,
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
  let scroll: ScrollBoxRenderable | undefined
  const renderer = useRenderer()
  const [searching, setSearchingSig] = createSignal(false)
  const setSearching = (v: boolean) => {
    setSearchingSig(v)
    ui.setCapturing(v)
  }
  const [query, setQuery] = createSignal("")
  const [hit, setHit] = createSignal(0)
  const matches = createMemo(() => findMatches(lines(), query()))
  const shown = createMemo(() => {
    const q = query()
    if (!q) return lines()
    const t = ui.theme()
    const cur = matches()[hit()]
    return lines().map((l, i) => (i === cur ? highlight(l, q, { fg: t.background, bg: t.warning }) : highlight(l, q, { fg: t.text, bg: t.selection })))
  })
  const jump = (i: number) => {
    const m = matches()
    if (!m.length || !scroll) return
    const idx = ((i % m.length) + m.length) % m.length
    setHit(idx)
    scroll.stickyScroll = false
    scroll.scrollTo(Math.max(0, (m[idx] as number) - 3))
  }
  const transcript = () => lines().map(lineText).join("\n")
  const lastMessage = () => {
    const items = ui.run.feed(props.agentId).items
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!
      if (it.kind === "message" && it.role === "assistant" && it.text.trim()) return it.text
    }
    return ""
  }
  // keymap-driven actions (rebindable: zoom.search, zoom.copy, …)
  ui.setZoomAction((id) => {
    switch (id) {
      case "zoom.search":
        setTimeout(() => setSearching(true), 0)
        break
      case "zoom.next":
        jump(hit() + 1)
        break
      case "zoom.prev":
        jump(hit() - 1)
        break
      case "zoom.top":
        if (scroll) {
          scroll.stickyScroll = false
          scroll.scrollTo(0)
        }
        break
      case "zoom.bottom":
        if (scroll) {
          scroll.scrollTo(Number.MAX_SAFE_INTEGER)
          scroll.stickyScroll = true
        }
        break
      case "zoom.copy": {
        const text = lastMessage()
        if (!text) {
          ui.toast("no message to copy", "warn")
          break
        }
        ui.toast(`copied the last message via ${copyText(renderer, text)}`)
        break
      }
      case "zoom.copyAll":
        ui.toast(`copied the transcript via ${copyText(renderer, transcript())}`)
        break
      case "zoom.save": {
        const a = agent()
        const dir = join(ui.run.projectRoot || process.cwd(), ".baton", "transcripts")
        mkdirSync(dir, { recursive: true })
        const path = join(dir, `${a?.name ?? "agent"}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`)
        writeFileSync(path, `# ${a?.name ?? "agent"}${a?.label ? ` — ${a.label}` : ""}\n\n\`\`\`\n${transcript()}\n\`\`\`\n`)
        ui.toast(`saved ${path}`)
        break
      }
    }
  })
  onCleanup(() => {
    ui.setZoomAction(undefined)
    ui.setCapturing(false)
  })
  useKeyboard((k) => {
    if (searching() && k.name === "escape") {
      setSearching(false)
      setQuery("")
    }
  })
  return (
    <Frame
      width={props.width}
      height={props.height}
      border={ui.prefs.border}
      borderColor={ui.theme().borderActive}
      focused
      accent={look()?.color}
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
          scroll = r
        }}
        flexGrow={1}
        minHeight={0}
        stickyScroll
        stickyStart="bottom"
        focused={ui.overlay() === null && !searching() && ui.zoomed() === props.agentId}
        scrollY
      >
        <Txt value={toStyled(shown(), inner().width - 1)} />
      </scrollbox>
      <Show
        when={searching()}
        fallback={
          <box height={1} flexShrink={0}>
            <Txt height={1} value={toStyled(status(), inner().width, 1)} />
          </box>
        }
      >
        <box height={1} flexShrink={0} flexDirection="row">
          <Txt value={segs({ text: "/ ", fg: ui.theme().primary, bold: true })} />
          <input
            flexGrow={1}
            focused
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            textColor={ui.theme().text}
            focusedTextColor={ui.theme().text}
            placeholder="search this agent's history · enter next · esc close"
            onInput={(v: string) => {
              setQuery(v)
              setHit(0)
              queueMicrotask(() => jump(0))
            }}
            onSubmit={(() => jump(hit() + 1)) as never}
          />
          <Txt value={segs({ text: query() ? ` ${matches().length ? hit() + 1 : 0}/${matches().length}` : "", fg: ui.theme().textMuted })} />
        </box>
      </Show>
    </Frame>
  )
}
