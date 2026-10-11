/** Non-color style assets: spinners, verbs, border character sets. All user-overridable. */

export const SPINNERS: Record<string, { frames: string[]; interval: number }> = {
  // Claude-Code-like twinkling star (the screenshots' ✸/✻ glyphs)
  star: { frames: ["·", "✢", "✱", "✶", "✻", "✽", "✻", "✶", "✱", "✢"], interval: 110 },
  dots: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], interval: 80 },
  circle: { frames: ["◐", "◓", "◑", "◒"], interval: 120 },
  moon: { frames: ["◒", "◐", "◓", "◑"], interval: 140 },
  arc: { frames: ["◜", "◠", "◝", "◞", "◡", "◟"], interval: 100 },
  pulse: { frames: ["●", "◉", "○", "◉"], interval: 180 },
  bounce: { frames: ["⠁", "⠂", "⠄", "⠂"], interval: 120 },
  line: { frames: ["|", "/", "-", "\\"], interval: 100 },
  diamond: { frames: ["◇", "◈", "◆", "◈"], interval: 150 },
}

export const DEFAULT_VERBS = [
  "Orchestrating",
  "Spelunking",
  "Wrangling",
  "Schlepping",
  "Pondering",
  "Conjuring",
  "Noodling",
  "Percolating",
  "Tinkering",
  "Finagling",
  "Cogitating",
  "Brewing",
  "Untangling",
  "Sleuthing",
  "Whittling",
  "Marinating",
  "Herding",
  "Juggling",
  "Forging",
  "Calibrating",
]

export type BorderName = "rounded" | "single" | "heavy" | "double" | "ascii" | "none"

export interface BorderChars {
  tl: string
  tr: string
  bl: string
  br: string
  h: string
  v: string
}

export const BORDERS: Record<Exclude<BorderName, "none">, BorderChars> = {
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  single: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
}

// ───────────────────────────── UI styles ─────────────────────────────
// A theme picks colors; a *style* picks shapes: how panes are framed, how the status bar is
// drawn, whether Baton paints its own background. Styles are presets over these prefs —
// choosing one sets them all, and every pref can still be changed on its own afterwards.

/**
 * How a pane is framed:
 * - line    `╭─ ✱ name ──────── label ─╮` box (the classic look)
 * - tab     the title sits in a filled tab on the top border
 * - bar     a filled title bar over a raised panel, no box lines
 * - minimal a title rule `✱ name ───── label`, nothing else
 * - accent  a colored stripe down the left edge, no box lines
 */
export type FrameStyle = "line" | "tab" | "bar" | "minimal" | "accent"
export const FRAME_STYLES: FrameStyle[] = ["line", "tab", "bar", "minimal", "accent"]

/**
 * Status bar:
 * - plain     one filled bar
 * - blocks    each group is a rounded chip (`▐ 3/5 running ▌`)
 * - powerline chips joined by powerline arrows (needs a Nerd/Powerline font)
 * - minimal   no fill, just text
 */
export type StatusStyle = "plain" | "blocks" | "powerline" | "minimal"
export const STATUS_STYLES: StatusStyle[] = ["plain", "blocks", "powerline", "minimal"]

/** theme: Baton paints the theme's background · terminal: your terminal's own background shows through. */
export type BackgroundMode = "theme" | "terminal"

export interface StylePrefs {
  frame: FrameStyle
  border: BorderName
  status_style: StatusStyle
  background: BackgroundMode
  /** Card borders tinted with each agent's brand color. */
  brand_borders: boolean
  spinner: string
  density: "comfy" | "compact"
}

export interface UiStyle {
  name: string
  title: string
  description: string
  prefs: StylePrefs
}

export const STYLES: UiStyle[] = [
  {
    name: "classic",
    title: "Classic",
    description: "Rounded boxes with titles in the border — the look from the screenshots.",
    prefs: { frame: "line", border: "rounded", status_style: "plain", background: "theme", brand_borders: false, spinner: "star", density: "comfy" },
  },
  {
    name: "modern",
    title: "Modern",
    description: "Filled title bars over raised panels, chip-style status bar. Clean, app-like.",
    prefs: { frame: "bar", border: "rounded", status_style: "blocks", background: "theme", brand_borders: false, spinner: "dots", density: "comfy" },
  },
  {
    name: "minimal",
    title: "Minimal",
    description: "No boxes, your terminal's own background, quiet status line. Content first.",
    prefs: { frame: "minimal", border: "none", status_style: "minimal", background: "terminal", brand_borders: false, spinner: "dots", density: "comfy" },
  },
  {
    name: "accent",
    title: "Accent",
    description: "Each pane has a stripe in its agent's brand color. Easy to tell agents apart.",
    prefs: { frame: "accent", border: "none", status_style: "blocks", background: "theme", brand_borders: true, spinner: "arc", density: "comfy" },
  },
  {
    name: "tabs",
    title: "Tabs",
    description: "Titles in filled tabs on crisp single-line boxes.",
    prefs: { frame: "tab", border: "single", status_style: "blocks", background: "theme", brand_borders: false, spinner: "circle", density: "comfy" },
  },
  {
    name: "neon",
    title: "Neon",
    description: "Heavy borders glowing in each agent's color, tabbed titles, chip status bar.",
    prefs: { frame: "tab", border: "heavy", status_style: "blocks", background: "theme", brand_borders: true, spinner: "diamond", density: "comfy" },
  },
  {
    name: "retro",
    title: "Retro",
    description: "Double-line boxes and a plain bar, like a 90s TUI.",
    prefs: { frame: "line", border: "double", status_style: "plain", background: "theme", brand_borders: false, spinner: "line", density: "compact" },
  },
  {
    name: "zen",
    title: "Zen",
    description: "Title rules only, terminal background, compact cards. For long sessions.",
    prefs: { frame: "minimal", border: "none", status_style: "minimal", background: "terminal", brand_borders: false, spinner: "pulse", density: "compact" },
  },
  {
    name: "paper",
    title: "Paper",
    description: "Thin single-line boxes, a text-only status line, compact cards. Light and printed-feeling.",
    prefs: { frame: "line", border: "single", status_style: "minimal", background: "theme", brand_borders: false, spinner: "bounce", density: "compact" },
  },
  {
    name: "glass",
    title: "Glass",
    description: "Floating title bars over your terminal's own background (and its blur), chips, brand-tinted cards.",
    prefs: { frame: "bar", border: "rounded", status_style: "blocks", background: "terminal", brand_borders: true, spinner: "moon", density: "comfy" },
  },
  {
    name: "brutalist",
    title: "Brutalist",
    description: "Heavy boxes, hard tabs, a flat bar and a plain ASCII spinner. No ornament.",
    prefs: { frame: "tab", border: "heavy", status_style: "plain", background: "theme", brand_borders: false, spinner: "line", density: "compact" },
  },
]

/** The style whose prefs all match, or "custom". */
export function matchStyle(p: Partial<StylePrefs>): string {
  const keys = Object.keys(STYLES[0]!.prefs) as (keyof StylePrefs)[]
  return STYLES.find((s) => keys.every((k) => s.prefs[k] === p[k]))?.name ?? "custom"
}
