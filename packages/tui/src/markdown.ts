/**
 * Markdown → styled terminal lines, for what agents write (they all answer in Markdown).
 *
 * Block level: headings, paragraphs, bullet / numbered / task lists (nested by indent), block
 * quotes, fenced code blocks, horizontal rules and pipe tables. Inline: **bold**, *italic*,
 * `code`, ~~strike~~, [links](url) and bare URLs. Everything is wrapped to the given width with
 * styles kept across line breaks. Pure: no OpenTUI, unit-tested.
 */
import type { ResolvedTheme } from "@batonsh/themes"
import { type Line, type Seg, sanitize, width } from "./lines.ts"

type Style = Omit<Seg, "text">

// ───────────────────────────── inline ─────────────────────────────

const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([^*]+?)\*\*|__([^_]+?)__|~~([^~]+?)~~|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g

/** One line of Markdown text → segments (inline styles only). */
export function inline(text: string, t: ResolvedTheme, base: Style = {}): Seg[] {
  const out: Seg[] = []
  const push = (s: string, style: Style = {}) => {
    if (s) out.push({ ...base, ...style, text: s })
  }
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0
    push(text.slice(last, i))
    last = i + m[0].length
    if (m[1] !== undefined) push(m[2] ?? "", { fg: t.toolArgs, bg: t.backgroundElement })
    else if (m[3] !== undefined || m[4] !== undefined) out.push(...inline(m[3] ?? m[4] ?? "", t, { ...base, bold: true }))
    else if (m[5] !== undefined) out.push(...inline(m[5], t, { ...base, dim: true }))
    else if (m[6] !== undefined || m[7] !== undefined) out.push(...inline(m[6] ?? m[7] ?? "", t, { ...base, italic: true }))
    else if (m[8] !== undefined) {
      out.push(...inline(m[8], t, { ...base, fg: t.accent, underline: true }))
      // show where a link goes unless the text already is the URL
      if (m[9] && m[9] !== m[8] && !m[9].startsWith("#")) push(` (${m[9]})`, { fg: t.textSubtle })
    } else if (m[10] !== undefined) push(m[10], { fg: t.accent, underline: true })
  }
  push(text.slice(last))
  return out
}

// ───────────────────────────── wrapping ─────────────────────────────

/** Wrap styled segments to `w` columns; `hang` is prepended to continuation lines. */
export function wrapSegs(segs: Seg[], w: number, first: Seg[] = [], hang: Seg[] = []): Line[] {
  const lines: Line[] = []
  const prefW = (p: Seg[]) => p.reduce((n, s) => n + width(s.text), 0)
  let cur: Seg[] = [...first]
  let used = prefW(first)
  const room = Math.max(4, w)
  const newLine = () => {
    // no trailing spaces at a break
    const lastSeg = cur[cur.length - 1]
    if (lastSeg) lastSeg.text = lastSeg.text.replace(/\s+$/, "")
    lines.push({ segs: cur.filter((s) => s.text.length) })
    cur = [...hang]
    used = prefW(hang)
  }
  for (const seg of segs) {
    for (const tok of seg.text.split(/(\s+)/)) {
      if (!tok) continue
      const tw = width(tok)
      if (/^\s+$/.test(tok)) {
        if (used + tw > room) newLine()
        else if (cur.length && used > prefW(hang)) {
          cur.push({ ...seg, text: tok })
          used += tw
        }
        continue
      }
      if (used + tw > room && used > prefW(hang)) newLine()
      if (tw > room - used) {
        // a word longer than the line: hard-break it
        let piece = ""
        for (const ch of tok) {
          const cw = width(ch)
          if (used + width(piece) + cw > room) {
            cur.push({ ...seg, text: piece })
            newLine()
            piece = ""
          }
          piece += ch
        }
        cur.push({ ...seg, text: piece })
        used += width(piece)
      } else {
        cur.push({ ...seg, text: tok })
        used += tw
      }
    }
  }
  if (cur.length > hang.length || lines.length === 0) newLine()
  return lines
}

// ───────────────────────────── blocks ─────────────────────────────

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+-]*)/
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/
const LIST = /^(\s*)([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?(.*)$/
const QUOTE = /^\s{0,3}>\s?(.*)$/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

function splitRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim())
}

function table(rows: string[][], w: number, t: ResolvedTheme): Line[] {
  const cols = Math.max(...rows.map((r) => r.length))
  const plain = (s: string) => inline(s, t).reduce((n, x) => n + width(x.text), 0)
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, ...rows.map((r) => plain(r[c] ?? ""))))
  // too wide: shrink the widest columns until it fits (cells get clipped)
  const total = () => widths.reduce((a, b) => a + b, 0) + (cols - 1) * 3
  while (total() > w && Math.max(...widths) > 6) {
    const i = widths.indexOf(Math.max(...widths))
    widths[i] = (widths[i] ?? 6) - 1
  }
  const out: Line[] = []
  rows.forEach((r, ri) => {
    const segs: Seg[] = []
    for (let c = 0; c < cols; c++) {
      const cw = widths[c] ?? 3
      let cell = inline(r[c] ?? "", t, ri === 0 ? { bold: true } : {})
      let used = 0
      const kept: Seg[] = []
      for (const s of cell) {
        const sw = width(s.text)
        if (used + sw <= cw) {
          kept.push(s)
          used += sw
        } else {
          let part = ""
          for (const ch of s.text) {
            if (used + width(part) + width(ch) > cw - 1) break
            part += ch
          }
          kept.push({ ...s, text: `${part}…` })
          used += width(part) + 1
          break
        }
      }
      cell = kept
      segs.push(...cell, { text: " ".repeat(Math.max(0, cw - used)) })
      if (c < cols - 1) segs.push({ text: " │ ", fg: t.borderSubtle })
    }
    out.push({ segs })
    if (ri === 0) out.push({ segs: [{ text: widths.map((x) => "─".repeat(x)).join("─┼─"), fg: t.borderSubtle }] })
  })
  return out
}

/**
 * Render Markdown to lines of at most `w` columns. Agent text is sanitized (no escape codes)
 * line by line first.
 */
export function renderMarkdown(src: string, w: number, t: ResolvedTheme, base: Style = { fg: t.text }): Line[] {
  const text = src
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => sanitize(l).replace(/\t/g, "  "))
  const out: Line[] = []
  const blank = () => {
    if (out.length && out[out.length - 1]?.segs.length) out.push({ segs: [] })
  }
  for (let i = 0; i < text.length; i++) {
    const line = text[i] ?? ""
    // fenced code: kept verbatim, one row per line, on the code background
    const fence = FENCE.exec(line)
    if (fence) {
      const marker = fence[1] ?? "```"
      const lang = fence[2]
      const body: string[] = []
      for (i++; i < text.length && !(text[i] ?? "").trimStart().startsWith(marker); i++) body.push(text[i] ?? "")
      blank()
      if (lang) out.push({ segs: [{ text: lang, fg: t.textSubtle, italic: true }] })
      for (const b of body.length ? body : [""]) {
        let row = b
        while (width(row) > w - 2) {
          // long code lines wrap with a marker rather than vanish
          let cut = ""
          for (const ch of row) {
            if (width(cut) + width(ch) > w - 3) break
            cut += ch
          }
          out.push({
            segs: [
              { text: ` ${cut}`, fg: t.toolArgs },
              { text: "↩", fg: t.textSubtle },
            ],
            bg: t.backgroundElement,
          })
          row = row.slice(cut.length)
        }
        out.push({ segs: [{ text: ` ${row}`, fg: t.toolArgs }], bg: t.backgroundElement })
      }
      blank()
      continue
    }
    if (!line.trim()) {
      blank()
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      blank()
      const level = h[1]?.length ?? 1
      out.push(...wrapSegs(inline(h[2] ?? "", t, { fg: level <= 2 ? t.primary : t.text, bold: true, underline: level === 1 }), w))
      continue
    }
    if (RULE.test(line)) {
      out.push({ segs: [{ text: "─".repeat(Math.max(4, Math.min(w, 60))), fg: t.borderSubtle }] })
      continue
    }
    // tables: a header row followed by a |---| separator
    if (line.includes("|") && TABLE_SEP.test(text[i + 1] ?? "")) {
      const rows = [splitRow(line)]
      for (i += 2; i < text.length && (text[i] ?? "").includes("|") && (text[i] ?? "").trim(); i++) rows.push(splitRow(text[i] ?? ""))
      i--
      blank()
      out.push(...table(rows, w, t))
      blank()
      continue
    }
    const q = QUOTE.exec(line)
    if (q) {
      const bar = { text: "▎ ", fg: t.borderActive }
      out.push(...wrapSegs(inline(q[1] ?? "", t, { fg: t.textMuted, italic: true }), w, [bar], [bar]))
      continue
    }
    const li = LIST.exec(line)
    if (li) {
      const depth = Math.floor((li[1]?.length ?? 0) / 2)
      const indent = "  ".repeat(Math.min(depth, 6))
      const ordered = /\d/.test(li[2] ?? "")
      const task = li[3]
      const bullet = task ? (/x/i.test(task) ? "☑ " : "☐ ") : ordered ? `${li[2]} ` : ["• ", "◦ ", "▪ "][depth % 3]
      const lead: Seg[] = [{ text: indent }, { text: bullet ?? "• ", fg: task && /x/i.test(task) ? t.success : t.textMuted }]
      const hang: Seg[] = [{ text: " ".repeat(width(indent) + width(bullet ?? "• ")) }]
      // a list item's lazy continuation lines (indented text, no marker) join it
      let body = li[4] ?? ""
      while (i + 1 < text.length && /^\s{2,}\S/.test(text[i + 1] ?? "") && !LIST.exec(text[i + 1] ?? "") && !FENCE.test(text[i + 1] ?? ""))
        body += ` ${(text[++i] ?? "").trim()}`
      out.push(...wrapSegs(inline(body, t, base), w, lead, hang))
      continue
    }
    // paragraph: consecutive plain lines join (Markdown soft breaks)
    let para = line.trim()
    while (i + 1 < text.length) {
      const next = text[i + 1] ?? ""
      if (!next.trim() || FENCE.test(next) || HEADING.test(next) || LIST.test(next) || QUOTE.test(next) || RULE.test(next) || TABLE_SEP.test(text[i + 2] ?? ""))
        break
      // a hard break ("two spaces" or backslash) keeps the line
      if (/(\s{2}|\\)$/.test(text[i] ?? "")) break
      para += ` ${next.trim()}`
      i++
    }
    out.push(...wrapSegs(inline(para.replace(/\\$/, ""), t, base), w))
  }
  while (out.length && !out[out.length - 1]?.segs.length) out.pop()
  return out
}
