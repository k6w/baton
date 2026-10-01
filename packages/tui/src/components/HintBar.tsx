/**
 * Hint bar: the handful of keys that matter in the current context, built from the live
 * keymap (so rebinds show up). Leads with what needs attention. Disable with ui.hints=false.
 */

import { attentionItems, urgentCount } from "@batonsh/kernel"
import { createMemo } from "solid-js"
import { useUi } from "../context.ts"
import type { Seg } from "../lines.ts"
import { clip, width as sw } from "../lines.ts"
import { segs } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"

export function HintBar(props: { width: number }) {
  const ui = useUi()
  const key = (id: string, fallback = "") => ui.keymap.keysFor(id)[0] ?? fallback
  const content = createMemo(() => {
    ui.version()
    const t = ui.theme()
    const hints: [string, string][] = []
    const zoomed = ui.zoomed()
    const focus = ui.focus()
    if (zoomed) hints.push([key("zoom.close", "esc"), "back"], ["↑↓", "scroll"], [key("attention.next"), "next ⚑"], [key("app.palette"), "commands"])
    else if (focus.kind === "agent")
      hints.push(
        [key("pane.peek", "space"), "peek & reply"],
        [key("pane.zoom", "z"), "zoom"],
        [key("pane.message", "m"), "message"],
        [key("pane.diff", "d"), "diff"],
        [key("pane.interrupt", "x"), "stop"],
        ["hjkl", "move"],
        [key("focus.next", "tab"), "input"],
        [key("app.help", "?"), "keys"],
      )
    else
      hints.push(
        ["enter", "send"],
        ["@", "talk to an agent"],
        ["/", "commands"],
        [key("focus.next", "tab"), "agents"],
        [key("autonomy.cycle", "shift+tab"), "autonomy"],
        [key("changes.open"), "changes"],
        [key("app.palette"), "palette"],
        [key("settings.open"), "settings"],
      )
    const out: Seg[] = [{ text: " " }]
    const n = urgentCount(attentionItems(ui.run))
    if (n)
      out.push(
        { text: `⚑ ${n} need${n === 1 ? "s" : ""} you`, fg: t.warning, bold: true },
        { text: ` ${key("attention.next")} `, fg: t.textMuted },
        { text: "  " },
      )
    for (const [k, label] of hints) {
      if (!k) continue
      out.push({ text: k, fg: t.text, bold: true }, { text: ` ${label}`, fg: t.textMuted }, { text: "  " })
    }
    // trim to width
    let w = 0
    const fitted: Seg[] = []
    for (const s of out) {
      if (w + sw(s.text) > props.width) {
        fitted.push({ ...s, text: clip(s.text, props.width - w) })
        break
      }
      fitted.push(s)
      w += sw(s.text)
    }
    const used = fitted.reduce((n, x) => n + sw(x.text), 0)
    return segs(...fitted, { text: " ".repeat(Math.max(0, props.width - used)) })
  })
  return (
    <box height={1} width={props.width} backgroundColor={ui.theme().background}>
      <Txt value={content()} />
    </box>
  )
}
