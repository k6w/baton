/**
 * Small visual building blocks for the teaching / settings screens, all as pure `Seg`/`Line`
 * values: keycaps, toggles, sliders, option dots, color swatches, the Baton wordmark and a tiny
 * markup renderer for lesson text.
 */
import { mix, type ResolvedTheme } from "@batonsh/themes"
import { type Line, type Seg, width as sw, wrap } from "../lines.ts"

const solid = (t: ResolvedTheme, c: string) => (c === "transparent" ? (t.appearance === "dark" ? "#1a1a1a" : "#f0f0f0") : c)

/** A key drawn as a cap: ` ctrl+s ` on a raised background. */
export function keycap(t: ResolvedTheme, key: string): Seg {
  const bg = mix(solid(t, t.backgroundElement), t.text, t.appearance === "dark" ? 0.12 : 0.1)
  return { text: ` ${prettyKey(key)} `, fg: t.text, bg, bold: true }
}

/** Key names as people say them ("ctrl+s", "shift+tab", "enter"). */
export function prettyKey(key: string): string {
  return key.replace(/\breturn\b/g, "enter").replace(/\bescape\b/g, "esc")
}

/** `━━●` on / `●──` off. */
export function toggle(t: ResolvedTheme, on: boolean, active = false): Seg[] {
  return on
    ? [
        { text: "━━", fg: t.success },
        { text: "●", fg: active ? t.text : t.success, bold: true },
        { text: " on", fg: t.success },
      ]
    : [
        { text: "●", fg: active ? t.text : t.textMuted },
        { text: "──", fg: t.borderSubtle },
        { text: " off", fg: t.textMuted },
      ]
}

/** `━━━━●─────` for a value between min and max. */
export function slider(t: ResolvedTheme, value: number, min: number, max: number, width = 10): Seg[] {
  const frac = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0
  const pos = Math.round(frac * (width - 1))
  return [
    { text: "━".repeat(pos), fg: t.accent },
    { text: "●", fg: t.text, bold: true },
    { text: "─".repeat(Math.max(0, width - 1 - pos)), fg: t.borderSubtle },
  ]
}

/** `‹ value ›` with `•••●••` underneath-ish (inline) showing where it sits among the options. */
export function choice(t: ResolvedTheme, label: string, index: number, count: number, active: boolean, color = t.accent, labelWidth = 0): Seg[] {
  const dots = count > 1 && count <= 9 ? ` ${Array.from({ length: count }, (_, i) => (i === index ? "●" : "·")).join("")}` : ""
  const pad = " ".repeat(Math.max(0, labelWidth - sw(label)))
  return [
    { text: active ? "‹ " : "  ", fg: t.textMuted },
    { text: label, fg: color, bold: active },
    { text: active ? " ›" : "  ", fg: t.textMuted },
    { text: pad },
    { text: dots, fg: t.textSubtle },
  ]
}

/** Five ■ in a theme's signature colors. */
export function swatch(theme: ResolvedTheme): Seg[] {
  return (["primary", "accent", "success", "warning", "error", "agentClaude"] as const).map((k) => ({ text: "■", fg: theme[k] }))
}

/** `● ● ○ ○` progress through steps. */
export function stepDots(t: ResolvedTheme, index: number, count: number): Seg[] {
  const out: Seg[] = []
  for (let i = 0; i < count; i++)
    out.push({ text: i === index ? "●" : i < index ? "●" : "○", fg: i === index ? t.primary : i < index ? t.textMuted : t.borderSubtle }, { text: " " })
  return out
}

/** A horizontal progress bar `▰▰▰▱▱`. */
export function progress(t: ResolvedTheme, done: number, total: number, width = 12): Seg[] {
  const filled = total ? Math.round((done / total) * width) : 0
  return [
    { text: "▰".repeat(filled), fg: t.success },
    { text: "▱".repeat(Math.max(0, width - filled)), fg: t.borderSubtle },
  ]
}

const BIG = [
  "██████   █████  ████████  ██████  ███    ██",
  "██   ██ ██   ██    ██    ██    ██ ████   ██",
  "██████  ███████    ██    ██    ██ ██ ██  ██",
  "██   ██ ██   ██    ██    ██    ██ ██  ██ ██",
  "██████  ██   ██    ██     ██████  ██   ████",
]
const SMALL = ["█▄▄ ▄▀█ ▀█▀ █▀█ █▄ █", "█▄█ █▀█  █  █▄█ █ ▀█"]

/** The wordmark, with a left→right gradient from the theme's primary to its accent color. */
export function logo(t: ResolvedTheme, width: number, small = false): Line[] {
  const rows = small || width < BIG[0]!.length + 2 ? SMALL : BIG
  const w = rows[0]!.length
  const from = solid(t, t.primary)
  const to = solid(t, t.accent)
  const pad = Math.max(0, Math.floor((width - w) / 2))
  return rows.map((row) => ({
    segs: [{ text: " ".repeat(pad) }, ...[...row].map((ch, i) => ({ text: ch, fg: mix(from, to, w > 1 ? i / (w - 1) : 0), bold: true }))],
  }))
}

/** Center a line of segments in `width` columns. */
export function center(segs: Seg[], width: number): Line {
  const w = segs.reduce((n, s) => n + sw(s.text), 0)
  return { segs: [{ text: " ".repeat(Math.max(0, Math.floor((width - w) / 2))) }, ...segs] }
}

/**
 * Lesson markup → lines:
 *   **bold**   `key or code` (drawn as a keycap)   > tip (callout)   - bullet
 *   ```        (verbatim diagram block, in the accent color)
 *   ## Heading
 */
export function markup(t: ResolvedTheme, text: string, width: number): Line[] {
  const out: Line[] = []
  let inBlock = false
  for (const raw of text.split("\n")) {
    if (raw.trim().startsWith("```")) {
      inBlock = !inBlock
      continue
    }
    if (inBlock) {
      out.push({ segs: [{ text: `  ${raw}`, fg: t.accent }] })
      continue
    }
    if (!raw.trim()) {
      out.push({ segs: [] })
      continue
    }
    if (raw.startsWith("## ")) {
      out.push({ segs: [{ text: raw.slice(3), fg: t.primary, bold: true }] })
      continue
    }
    let prefix: Seg[] = []
    let body = raw
    let indent = ""
    let baseFg = t.textMuted
    if (raw.startsWith("> ")) {
      prefix = [{ text: "▌ ", fg: t.accent }]
      body = raw.slice(2)
      indent = "  "
      baseFg = t.text
    } else if (/^[-•] /.test(raw)) {
      prefix = [{ text: "• ", fg: t.primary, bold: true }]
      body = raw.slice(2)
      indent = "  "
      baseFg = t.text
    }
    const inner = width - sw(indent)
    for (const [i, l] of wrapInline(body, inner).entries()) {
      out.push({ segs: [...(i === 0 ? prefix : [{ text: indent, fg: t.accent }]), ...inline(t, l, baseFg)] })
    }
  }
  return out
}

/** Wrap text but never inside `code` or **bold** spans. */
function wrapInline(text: string, width: number): string[] {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean)
  const words: string[] = []
  for (const tok of tokens) {
    if (tok.startsWith("`") || tok.startsWith("**")) words.push(tok)
    else for (const w of tok.split(/(\s+)/)) if (w) words.push(w)
  }
  const visible = (s: string) => sw(s.replace(/^\*\*|\*\*$/g, "").replace(/^`|`$/g, s.startsWith("`") ? "  " : ""))
  const lines: string[] = []
  let cur = ""
  let curW = 0
  for (const w of words) {
    const ww = visible(w)
    if (curW + ww > width && cur.trim()) {
      lines.push(cur.trimEnd())
      cur = /^\s+$/.test(w) ? "" : w
      curW = /^\s+$/.test(w) ? 0 : ww
    } else {
      cur += w
      curW += ww
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd())
  return lines.length ? lines : wrap(text, width)
}

function inline(t: ResolvedTheme, text: string, fg: string): Seg[] {
  const out: Seg[] = []
  for (const tok of text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).filter(Boolean)) {
    if (tok.startsWith("`")) out.push(keycap(t, tok.slice(1, -1)))
    else if (tok.startsWith("**")) out.push({ text: tok.slice(2, -2), fg: t.text, bold: true })
    else out.push({ text: tok, fg })
  }
  return out
}
