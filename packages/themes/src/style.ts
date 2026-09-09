/** Non-color style assets: spinners, verbs, border character sets. All user-overridable. */

export const SPINNERS: Record<string, { frames: string[]; interval: number }> = {
  // Claude-Code-like twinkling star (the screenshots' ✸/✻ glyphs)
  star: { frames: ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"], interval: 110 },
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
  "Orchestrating", "Spelunking", "Wrangling", "Schlepping", "Pondering", "Conjuring", "Noodling",
  "Percolating", "Tinkering", "Finagling", "Cogitating", "Brewing", "Untangling", "Sleuthing",
  "Whittling", "Marinating", "Herding", "Juggling", "Forging", "Calibrating",
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
