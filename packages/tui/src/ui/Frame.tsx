/**
 * Frame: a bordered pane whose top border carries a left title (icon + name) and a
 * right-aligned label, like `╭─ ✱ claude-1 ─────────── persona ─╮`.
 * The border is drawn by OpenTUI (left/right/bottom); the top row is composed by hand so
 * both titles fit — and so a logo image can sit inside it.
 */
import type { BorderCharacters } from "@opentui/core"
import { type JSX, Show } from "solid-js"
import { BORDERS, type BorderName } from "@batonsh/themes"
import { type Seg, clip, width as sw } from "../lines.ts"
import { segs } from "./styled.ts"
import { useUi } from "../context.ts"

export interface FrameProps {
  width: number
  height: number
  border: BorderName
  borderColor: string
  background?: string
  /** Glyph shown before the title (ignored when `logo` renders). */
  icon?: Seg
  /** Logo image path; rendered 2 cells wide when set. */
  logo?: string
  title: Seg[]
  right?: Seg[]
  children?: JSX.Element
  onMouseDown?: () => void
  paddingX?: number
}

function chars(border: BorderName) {
  return border === "none" ? BORDERS.single : BORDERS[border]
}

export function customChars(border: BorderName): BorderCharacters | undefined {
  if (border !== "ascii") return undefined
  return { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", topT: "+", bottomT: "+", leftT: "+", rightT: "+", cross: "+" }
}

export function Frame(props: FrameProps) {
  const ui = useUi()
  // always paint a background: transparent boxes leave stale cells behind when content shrinks
  const bg = () => props.background ?? (ui.theme().backgroundPanel === "transparent" ? ui.theme().background : ui.theme().backgroundPanel)
  const c = () => chars(props.border)
  const noBorder = () => props.border === "none"
  const iconW = () => (props.logo ? 2 : props.icon ? sw(props.icon.text) : 0)

  // ╭─ <icon> <title> ───…─── <right> ─╮
  const header = () => {
    const w = props.width
    const bc = props.borderColor
    const left = noBorder() ? "" : `${c().tl}${c().h} `
    const rightCap = noBorder() ? "" : ` ${c().h}${c().tr}`
    const titleText = props.title.map((s) => s.text).join("")
    const rightText = (props.right ?? []).map((s) => s.text).join("")
    const fixed = sw(left) + iconW() + (iconW() ? 1 : 0) + sw(rightCap) + 1
    let titleBudget = Math.max(4, w - fixed - (rightText ? sw(rightText) + 2 : 0))
    let rightSegs = props.right ?? []
    if (sw(titleText) > titleBudget && rightText) {
      // drop the right label before truncating the name
      rightSegs = []
      titleBudget = Math.max(4, w - fixed)
    }
    const title: Seg[] = []
    let used = 0
    for (const s of props.title) {
      const remaining = titleBudget - used
      if (remaining <= 0) break
      const text = sw(s.text) > remaining ? clip(s.text, remaining) : s.text
      title.push({ ...s, text })
      used += sw(text)
    }
    const rText = rightSegs.map((s) => s.text).join("")
    // header must span exactly `w` columns (stale cells otherwise survive at the edge)
    const fill = Math.max(1, w - sw(left) - iconW() - (iconW() ? 1 : 0) - used - (rText ? sw(rText) + 2 : 1) - sw(rightCap) + 1)
    const before: Seg[] = [{ text: left, fg: bc }]
    const after: Seg[] = [
      ...title,
      { text: ` ${noBorder() ? " " : c().h.repeat(Math.max(0, fill - 1))}${rText ? " " : ""}`, fg: bc },
      ...rightSegs,
      { text: rightCap, fg: bc },
    ]
    return { before, after }
  }

  return (
    <box width={props.width} height={props.height} flexDirection="column" onMouseDown={props.onMouseDown} backgroundColor={bg()}>
      <Show
        when={props.logo}
        fallback={
          <box height={1} width={props.width}>
            <text width={props.width} height={1} wrapMode="none">{segs(...header().before, ...(props.icon ? [{ ...props.icon, text: `${props.icon.text} ` }] : []), ...header().after)}</text>
          </box>
        }
      >
        <box height={1} flexDirection="row" width={props.width}>
          <text width={sw(header().before.map((x) => x.text).join(""))} height={1} wrapMode="none">{segs(...header().before)}</text>
          <image source={props.logo!} width={2} height={1} fit="fit" />
          <text width={Math.max(1, props.width - sw(header().before.map((x) => x.text).join("")) - 2)} height={1} wrapMode="none">{segs({ text: " " }, ...header().after)}</text>
        </box>
      </Show>
      <box
        flexGrow={1}
        border={noBorder() ? false : ["left", "right", "bottom"]}
        borderStyle={props.border === "none" || props.border === "ascii" ? "single" : props.border}
        customBorderChars={customChars(props.border)}
        borderColor={props.borderColor}
        paddingLeft={props.paddingX ?? 1}
        paddingRight={props.paddingX ?? 1}
        flexDirection="column"
        overflow="hidden"
        backgroundColor={bg()}
      >
        {props.children}
      </box>
    </box>
  )
}

/** Inner content size of a frame of the given outer size. */
export function innerSize(w: number, h: number, border: BorderName, paddingX = 1): { width: number; height: number } {
  const b = border === "none" ? 0 : 2
  return { width: Math.max(1, w - b - paddingX * 2), height: Math.max(1, h - 1 - (border === "none" ? 0 : 1)) }
}
