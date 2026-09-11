/** Convert our pure `Line`s into OpenTUI StyledText (one text node per pane = fast). */
import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core"
import { type Line, lineWidth, type Seg } from "../lines.ts"

const cache = new Map<string, RGBA>()

export function rgba(hex: string | undefined): RGBA | undefined {
  if (!hex || hex === "transparent") return undefined
  let c = cache.get(hex)
  if (!c) {
    c = RGBA.fromHex(hex)
    cache.set(hex, c)
  }
  return c
}

function attrs(s: Seg): number {
  let a = 0
  if (s.bold) a |= TextAttributes.BOLD
  if (s.italic) a |= TextAttributes.ITALIC
  if (s.dim) a |= TextAttributes.DIM
  if (s.underline) a |= TextAttributes.UNDERLINE
  return a
}

function chunk(text: string, s: Partial<Seg> = {}): TextChunk {
  return { __isChunk: true, text, fg: rgba(s.fg), bg: rgba(s.bg), attributes: attrs(s as Seg) }
}

/** Lines → StyledText, every row padded to `width` (with the row background, if any). */
export function toStyled(lines: readonly Line[], width: number, height?: number): StyledText {
  const chunks: TextChunk[] = []
  // Pad to `height` rows too, for the same reason as the width padding below.
  const all = height !== undefined && lines.length < height ? [...lines, ...Array.from({ length: height - lines.length }, () => ({ segs: [] }) as Line)] : lines
  all.forEach((l, i) => {
    for (const s of l.segs) if (s.text) chunks.push(chunk(s.text, s))
    // Pad every row to the full width: text nodes only repaint cells they cover, so a
    // shorter line would otherwise leave the previous frame's characters behind.
    const pad = width - lineWidth(l)
    if (pad > 0) chunks.push(chunk(" ".repeat(pad), { bg: l.bg }))
    if (i < all.length - 1) chunks.push(chunk("\n"))
  })
  return new StyledText(chunks)
}

export function segs(...parts: Seg[]): StyledText {
  return new StyledText(parts.filter((p) => p.text).map((p) => chunk(p.text, p)))
}
