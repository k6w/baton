/**
 * Frame: a pane with a title row carrying a left title (icon + name) and a right-aligned
 * label. Five shapes (ui.frame, usually chosen through a style preset):
 *
 *   line     ╭─ ✱ claude-1 ─────────── persona ─╮   box drawn around the pane
 *   tab      ╭─▐ ✱ claude-1 ▌──────── persona ─╮   title in a filled tab on the box
 *   bar      ▏ ✱ claude-1             persona ▕    filled title bar over a raised panel
 *   minimal  ✱ claude-1 ────────────── persona      title rule, nothing else
 *   accent   ▎ ✱ claude-1             persona      colored stripe down the left edge
 *
 * The box border (line/tab) is drawn by OpenTUI; title rows are composed by hand so both
 * labels fit — and so a logo image can sit inside them. Shapes without a box keep a one-cell
 * gutter on the right and bottom so neighbouring panes stay apart.
 */

import { BORDERS, type BorderName, type FrameStyle, luminance, mix } from "@batonsh/themes"
import type { BorderCharacters } from "@opentui/core"
import { type JSX, Show } from "solid-js"
import { useUi } from "../context.ts"
import { clip, type Seg, width as sw } from "../lines.ts"
import { segs, toStyled } from "./styled.ts"
import { Txt } from "./Txt.tsx"

export interface FrameProps {
  width: number
  height: number
  border: BorderName
  borderColor: string
  /** Shape; defaults to the user's ui.frame. */
  frame?: FrameStyle
  /** Stripe / tab color (accent + tab frames); defaults to the border color. */
  accent?: string
  focused?: boolean
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
  return {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
    topT: "+",
    bottomT: "+",
    leftT: "+",
    rightT: "+",
    cross: "+",
  }
}

export interface Insets {
  top: number
  bottom: number
  left: number
  right: number
}

/** Rows/columns a frame shape uses around its content (title row, box lines, stripe, gutter). */
export function frameInsets(frame: FrameStyle, border: BorderName): Insets {
  switch (frame) {
    case "bar":
    case "minimal":
      return { top: 1, bottom: 1, left: 0, right: 1 }
    case "accent":
      return { top: 1, bottom: 1, left: 1, right: 1 }
    default:
      return border === "none" ? { top: 1, bottom: 0, left: 0, right: 0 } : { top: 1, bottom: 1, left: 1, right: 1 }
  }
}

/** Inner content size of a frame of the given outer size. */
export function innerSize(w: number, h: number, border: BorderName, paddingX = 1, frame: FrameStyle = "line"): { width: number; height: number } {
  const i = frameInsets(frame, border)
  return { width: Math.max(1, w - i.left - i.right - paddingX * 2), height: Math.max(1, h - i.top - i.bottom) }
}

/** Readable text color on top of `bg`. */
export function onColor(bg: string, light = "#ffffff", dark = "#111111"): string {
  if (!bg.startsWith("#")) return light
  return luminance(bg) > 0.55 ? dark : light
}

const solid = (c: string | undefined, fallback: string) => (!c || c === "transparent" ? fallback : c)

export function Frame(props: FrameProps) {
  const ui = useUi()
  const shape = (): FrameStyle => props.frame ?? ui.prefs.frame ?? "line"
  const t = () => ui.theme()
  // always paint a background: transparent boxes leave stale cells behind when content shrinks
  // (with background = terminal the theme says "transparent" on purpose: every row is padded instead)
  const appBg = () => t().background
  const panelBg = () => {
    if (props.background) return props.background
    const th = t()
    if (th.backgroundPanel === "transparent") return th.background
    if (shape() === "bar" || shape() === "accent") {
      // raised panel: the theme's panel color, or a hair lighter/darker than the background
      if (th.backgroundPanel !== th.background) return th.backgroundPanel
      return th.background === "transparent" ? "transparent" : mix(th.background, th.text, th.appearance === "dark" ? 0.05 : 0.035)
    }
    return th.backgroundPanel
  }
  const insets = () => frameInsets(shape(), props.border)
  const iconW = () => (props.logo ? 2 : props.icon ? sw(props.icon.text) : 0)
  const accent = () => props.accent ?? props.borderColor

  /** The title row as (segments before the icon, segments after it, background). */
  const header = (): { before: Seg[]; after: Seg[]; bg?: string } => {
    const w = props.width
    const th = t()
    const c = chars(props.border)
    const bc = props.borderColor
    const kind = shape()
    const noBox = props.border === "none"

    // per-shape decorations around the title
    let left = ""
    let rightCap = ""
    let fillChar = c.h
    let rowBg: string | undefined
    let titleBg: string | undefined
    let titleFg: string | undefined
    let leftFg = bc
    let fillFg = bc
    switch (kind) {
      case "line":
        left = noBox ? "" : `${c.tl}${c.h} `
        rightCap = noBox ? "" : ` ${c.h}${c.tr}`
        if (noBox) fillChar = " "
        break
      case "tab": {
        left = noBox ? "" : `${c.tl}${c.h}`
        rightCap = noBox ? "" : ` ${c.h}${c.tr}`
        titleBg = props.focused ? accent() : mix(solid(th.backgroundElement, th.border), th.text, th.appearance === "dark" ? 0.1 : 0.08)
        titleFg = props.focused ? onColor(titleBg) : th.text
        break
      }
      case "bar": {
        // the bar must stand out from the raised panel below it
        const base = mix(solid(th.backgroundElement, th.border), th.text, th.appearance === "dark" ? 0.08 : 0.06)
        rowBg = props.focused ? mix(base, accent(), 0.45) : base
        left = " "
        rightCap = " "
        fillChar = " "
        leftFg = th.text
        break
      }
      case "minimal":
        left = " "
        rightCap = ""
        fillChar = noBox ? "─" : c.h
        fillFg = props.focused ? accent() : th.border
        break
      case "accent":
        left = "▎ "
        leftFg = props.focused ? accent() : mix(solid(accent(), "#888888"), solid(th.background, "#000000"), 0.35)
        rightCap = ""
        fillChar = " "
        rowBg = panelBg() === "transparent" ? undefined : panelBg()
        break
    }
    const usable = w - (kind === "bar" || kind === "minimal" || kind === "accent" ? insets().right : 0)
    const tabPad = kind === "tab" ? 2 : 0 // " title " inside the tab
    const titleText = props.title.map((s) => s.text).join("")
    const rightText = (props.right ?? []).map((s) => s.text).join("")
    const fixed = sw(left) + iconW() + (iconW() ? 1 : 0) + sw(rightCap) + 1 + tabPad
    let titleBudget = Math.max(4, usable - fixed - (rightText ? sw(rightText) + 2 : 0))
    // a right label that alone is too wide is clipped, not allowed to push the frame
    const rightMax = Math.max(0, Math.floor(usable / 2) - 4)
    let rightSegs = sw(rightText) > rightMax ? [{ ...(props.right?.[0] ?? {}), text: clip(rightText, rightMax) }] : (props.right ?? [])
    if (sw(titleText) > titleBudget && rightText) {
      // drop the right label before truncating the name
      rightSegs = []
      titleBudget = Math.max(4, usable - fixed)
    }
    const title: Seg[] = []
    let used = 0
    for (const s of props.title) {
      const remaining = titleBudget - used
      if (remaining <= 0) break
      const text = sw(s.text) > remaining ? clip(s.text, remaining) : s.text
      const fg = titleFg ?? (props.focused && (kind === "minimal" || kind === "accent") ? accent() : s.fg)
      title.push({ ...s, text, fg, bg: titleBg ?? rowBg })
      used += sw(text)
    }
    const rText = rightSegs.map((s) => s.text).join("")
    // the row must span exactly `usable` columns (stale cells otherwise survive at the edge)
    const fill = Math.max(1, usable - sw(left) - iconW() - (iconW() ? 1 : 0) - used - tabPad - (rText ? sw(rText) + 2 : 1) - sw(rightCap) + 1)
    const before: Seg[] = [{ text: left, fg: leftFg, bg: rowBg }]
    if (kind === "tab") before.push({ text: " ", bg: titleBg })
    const after: Seg[] = [
      ...title,
      ...(kind === "tab" ? [{ text: " ", bg: titleBg }] : []),
      { text: ` ${fillChar.repeat(Math.max(0, fill - 1))}${rText ? " " : ""}`, fg: fillFg, bg: rowBg },
      ...rightSegs.map((s) => ({ ...s, bg: rowBg })),
      { text: rightCap, fg: bc, bg: rowBg },
    ]
    // the icon sits on the tab / bar fill too
    return { before, after, bg: kind === "tab" ? titleBg : rowBg }
  }

  const iconSeg = (): Seg[] => (props.icon ? [{ ...props.icon, text: `${props.icon.text} `, bg: header().bg }] : [])
  const beforeW = () =>
    sw(
      header()
        .before.map((x) => x.text)
        .join(""),
    )
  const headerW = () => props.width - (shape() === "line" || shape() === "tab" ? 0 : insets().right)

  const titleRow = () => (
    <Show
      when={props.logo}
      fallback={
        <box height={1} width={headerW()}>
          <Txt width={headerW()} height={1} wrapMode="none" value={segs(...header().before, ...iconSeg(), ...header().after)} />
        </box>
      }
    >
      <box height={1} flexDirection="row" width={headerW()}>
        <Txt width={beforeW()} height={1} wrapMode="none" value={segs(...header().before)} />
        <image source={props.logo!} width={2} height={1} fit="fit" />
        <Txt width={Math.max(1, headerW() - beforeW() - 2)} height={1} wrapMode="none" value={segs({ text: " ", bg: header().bg }, ...header().after)} />
      </box>
    </Show>
  )

  const bodyH = () => Math.max(0, props.height - insets().top - insets().bottom)
  const stripe = () => {
    const th = t()
    const color = props.focused ? accent() : mix(solid(accent(), "#888888"), solid(th.background, "#000000"), 0.35)
    const bg = panelBg() === "transparent" ? undefined : panelBg()
    return toStyled(
      Array.from({ length: bodyH() }, () => ({ segs: [{ text: "▎", fg: color, bg }] })),
      1,
      bodyH(),
    )
  }

  // line / tab: OpenTUI draws left, right and bottom box lines
  const boxed = () => (
    <box
      flexGrow={1}
      border={props.border === "none" ? false : ["left", "right", "bottom"]}
      borderStyle={props.border === "none" || props.border === "ascii" ? "single" : props.border}
      customBorderChars={customChars(props.border)}
      borderColor={props.borderColor}
      paddingLeft={props.paddingX ?? 1}
      paddingRight={props.paddingX ?? 1}
      flexDirection="column"
      overflow="hidden"
      backgroundColor={panelBg()}
    >
      {props.children}
    </box>
  )

  // bar / minimal / accent: no box lines; stripe on the left for accent; gutters right + bottom
  const open = () => (
    <>
      <box height={bodyH()} flexDirection="row" width={props.width}>
        <Show when={shape() === "accent"}>
          <Txt width={1} height={bodyH()} wrapMode="none" value={stripe()} />
        </Show>
        <box
          width={Math.max(1, props.width - insets().left - insets().right)}
          height={bodyH()}
          paddingLeft={props.paddingX ?? 1}
          paddingRight={props.paddingX ?? 1}
          flexDirection="column"
          overflow="hidden"
          backgroundColor={shape() === "minimal" ? appBg() : panelBg()}
        >
          {props.children}
        </box>
        <box width={insets().right} height={bodyH()} backgroundColor={appBg()} />
      </box>
      <Show when={insets().bottom > 0}>
        <box height={insets().bottom} width={props.width} backgroundColor={appBg()} />
      </Show>
    </>
  )

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: terminal UI, not DOM — mouse focus on panes is intended
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      onMouseDown={props.onMouseDown}
      backgroundColor={shape() === "line" || shape() === "tab" ? panelBg() : appBg()}
    >
      <Show when={shape() === "bar" || shape() === "minimal" || shape() === "accent"} fallback={titleRow()}>
        <box height={1} flexDirection="row" width={props.width}>
          {titleRow()}
          <box width={insets().right} height={1} backgroundColor={appBg()} />
        </box>
      </Show>
      <Show when={shape() === "line" || shape() === "tab"} fallback={open()}>
        {boxed()}
      </Show>
    </box>
  )
}
