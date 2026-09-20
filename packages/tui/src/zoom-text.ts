import type { Line } from "./lines.ts"

export function lineText(l: Line): string {
  return l.segs.map((s) => s.text).join("")
}

/** Indices of lines containing `q` (case-insensitive). */
export function findMatches(lines: readonly Line[], q: string): number[] {
  if (!q) return []
  const needle = q.toLowerCase()
  const out: number[] = []
  lines.forEach((l, i) => {
    if (lineText(l).toLowerCase().includes(needle)) out.push(i)
  })
  return out
}

/** Highlight occurrences of `q` in a line (splits segments as needed). */
export function highlight(l: Line, q: string, colors: { fg: string; bg: string }): Line {
  if (!q) return l
  const needle = q.toLowerCase()
  const segs: Line["segs"] = []
  for (const s of l.segs) {
    const lower = s.text.toLowerCase()
    let i = 0
    let at = lower.indexOf(needle)
    if (at < 0) {
      segs.push(s)
      continue
    }
    while (at >= 0) {
      if (at > i) segs.push({ ...s, text: s.text.slice(i, at) })
      segs.push({ ...s, text: s.text.slice(at, at + q.length), fg: colors.fg, bg: colors.bg, bold: true })
      i = at + q.length
      at = lower.indexOf(needle, i)
    }
    if (i < s.text.length) segs.push({ ...s, text: s.text.slice(i) })
  }
  return { ...l, segs }
}
