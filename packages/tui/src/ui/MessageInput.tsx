/**
 * Multi-line message box shared by the orchestrator pane and the agent peek reply: soft-wraps,
 * grows with its content up to `maxRows` (then scrolls internally).
 * Enter sends · shift+enter / alt+enter / ctrl+j insert a newline.
 */
import type { KeyBinding, KeyEvent, TextareaRenderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { useUi } from "../context.ts"
import { width as sw } from "../lines.ts"

export const MESSAGE_MAX_ROWS = 8

export const messageKeyBindings: KeyBinding[] = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "linefeed", action: "newline" },
]

/** Visual rows `text` takes when word-wrapped to `cols` columns (min 1). */
export function wrappedRows(text: string, cols: number): number {
  const w = Math.max(1, cols)
  let rows = 0
  for (const para of text.split("\n")) {
    let n = 1
    let used = 0
    for (const word of para.split(/(?<=\s)/)) {
      const len = sw(word)
      if (used > 0 && used + sw(word.trimEnd()) > w) {
        n++
        used = 0
      }
      if (len > w) {
        // a word longer than the line is hard-wrapped
        if (used > 0) n++
        n += Math.ceil(sw(word.trimEnd()) / w) - 1
        used = sw(word.trimEnd()) % w
      } else used += len
    }
    rows += n
  }
  return Math.max(1, rows)
}

export interface MessageInputProps {
  /** Columns available to the text area (used to estimate the wrapped height). */
  cols: number
  focused: boolean
  placeholder: string
  maxRows?: number
  initialValue?: string
  ref?: (r: TextareaRenderable) => void
  onInput?: (value: string) => void
  onSubmit: (value: string) => void
  onKeyDown?: (key: KeyEvent) => void
  /** Reports the row count whenever it changes, so the parent can lay out around it. */
  onRows?: (rows: number) => void
}

export function MessageInput(props: MessageInputProps) {
  const ui = useUi()
  let ref: TextareaRenderable | undefined
  const [text, setText] = createSignal(props.initialValue ?? "")
  const rows = () => Math.min(props.maxRows ?? MESSAGE_MAX_ROWS, wrappedRows(text(), props.cols))
  let reported = 0
  const report = () => {
    const r = rows()
    if (r !== reported) {
      reported = r
      props.onRows?.(r)
    }
  }
  report()
  return (
    <textarea
      ref={(r: TextareaRenderable) => {
        ref = r
        props.ref?.(r)
      }}
      height={(report(), rows())}
      flexGrow={1}
      wrapMode="word"
      initialValue={props.initialValue}
      focused={props.focused}
      placeholder={props.placeholder}
      keyBindings={messageKeyBindings}
      backgroundColor="transparent"
      focusedBackgroundColor="transparent"
      textColor={ui.theme().text}
      focusedTextColor={ui.theme().text}
      placeholderColor={ui.theme().textSubtle}
      cursorColor={ui.theme().primary}
      onContentChange={() => {
        const v = ref?.plainText ?? ""
        setText(v)
        props.onInput?.(v)
      }}
      onSubmit={(() => props.onSubmit(ref?.plainText ?? "")) as never}
      onKeyDown={props.onKeyDown}
    />
  )
}

/** Replace the box's text (and put the cursor at the end) — keeps the sizing signal in sync via onContentChange. */
export function setMessage(r: TextareaRenderable | undefined, value: string) {
  if (!r || r.plainText === value) return
  r.setText(value)
  r.cursorOffset = value.length
}
