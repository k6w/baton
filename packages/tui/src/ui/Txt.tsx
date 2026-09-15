/**
 * Styled text node whose content is set imperatively. Passing StyledText as a reactive
 * *child* makes OpenTUI's Solid reconciler diff chunks as nodes — when new content has fewer
 * lines, stale trailing lines survive. Assigning `renderable.content` replaces it wholesale.
 */
import type { StyledText, TextRenderable } from "@opentui/core"
import { createEffect } from "solid-js"

export interface TxtProps {
  value: StyledText
  width?: number | "auto" | `${number}%`
  height?: number
  flexGrow?: number
  wrapMode?: "none" | "word" | "char"
}

export function Txt(props: TxtProps) {
  let ref: TextRenderable | undefined
  createEffect(() => {
    const v = props.value
    if (ref) ref.content = v
  })
  return (
    <text
      ref={(r: TextRenderable) => {
        ref = r
        r.content = props.value
      }}
      width={props.width}
      height={props.height}
      flexGrow={props.flexGrow}
      wrapMode={props.wrapMode ?? "none"}
    />
  )
}
