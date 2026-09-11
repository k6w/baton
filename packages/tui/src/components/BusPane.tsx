/** The inter-agent message bus, as a grid cell: `⇄ bus ───── a2a`. */
import { createMemo } from "solid-js"
import { whoFn } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { busLine, type Line } from "../lines.ts"
import { Frame, innerSize } from "../ui/Frame.tsx"
import { toStyled } from "../ui/styled.ts"

export function BusPane(props: { width: number; height: number; focused?: boolean }) {
  const ui = useUi()
  const inner = () => innerSize(props.width, props.height, ui.prefs.border)
  const busVer = createMemo(() => {
    ui.version()
    return ui.run.busVersion
  })
  const lines = createMemo<Line[]>(() => {
    busVer()
    const t = ui.theme()
    const { width, height } = inner()
    const who = whoFn(ui)
    const short = (ref: string) => {
      const w = who(ref)
      // c1 / cx2 style short names keep the log dense, like the screenshots
      const m = /^([a-z]+)-(\d+)$/.exec(w.name)
      return { ...w, name: m ? `${m[1]![0]}${m[2]}` : w.name }
    }
    // keep only the latest heartbeat per sender: liveness without flooding the log
    const latestBeat = new Map<string, string>()
    for (const m of ui.run.bus) if (m.kind === "heartbeat") latestBeat.set(m.from, m.messageId)
    const shown = ui.run.bus.filter((m) => m.kind !== "heartbeat" || latestBeat.get(m.from) === m.messageId)
    const msgs = shown.slice(-(height - 1))
    return msgs.map((m) => busLine(m, { theme: t, width, who: short, clock: ui.config.ui.timestamp_format, now: ui.now() }))
  })
  const footer = createMemo<Line[]>(() => {
    busVer()
    const t = ui.theme()
    const peers = new Set<string>()
    for (const m of ui.run.bus) {
      peers.add(m.from)
      if (!m.to.startsWith("#") && m.to !== "*") peers.add(m.to)
    }
    return [
      {
        segs: [
          { text: "● ", fg: ui.run.running().length ? t.success : t.textMuted },
          { text: `${ui.run.busChatCount} msgs · ${peers.size} peers`, fg: t.textMuted },
        ],
      },
    ]
  })
  return (
    <Frame
      width={props.width}
      height={props.height}
      border={ui.prefs.border}
      borderColor={props.focused ? ui.theme().borderActive : ui.theme().border}
      icon={{ text: "⇄", fg: ui.theme().text, bold: true }}
      title={[{ text: "bus", fg: ui.theme().text, bold: true }]}
      right={[{ text: "a2a", fg: ui.theme().textMuted }]}
    >
      <box flexGrow={1} overflow="hidden">
        <text wrapMode="none">{toStyled(lines(), inner().width, Math.max(0, inner().height - 1))}</text>
      </box>
      <box height={1}>
        <text wrapMode="none">{toStyled(footer(), inner().width)}</text>
      </box>
    </Frame>
  )
}
