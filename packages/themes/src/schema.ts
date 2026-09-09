/**
 * Theme model. Three tiers:
 *   defs (raw palette)  →  semantic tokens (this file)  →  component styles (TUI)
 *
 * Token names deliberately match OpenCode's theme format where a concept exists, so
 * OpenCode theme JSON files import as-is. Baton-specific tokens are additive.
 */

export const TOKENS = [
  // core
  "primary",
  "secondary",
  "accent",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "textSubtle",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "backgroundOverlay",
  "border",
  "borderActive",
  "borderSubtle",
  "selection",
  // diff
  "diffAdded",
  "diffRemoved",
  "diffContext",
  "diffAddedBg",
  "diffRemovedBg",
  "diffLineNumber",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
  // baton: agent states
  "stateIdle",
  "stateBusy",
  "stateWaiting",
  "stateError",
  "stateDone",
  // baton: chrome
  "spinner",
  "statusBar",
  "statusText",
  "busTime",
  "busFrom",
  "busTo",
  "busBody",
  "mention",
  "toolName",
  "toolArgs",
  "thought",
  // baton: agent brand accents
  "agentClaude",
  "agentCodex",
  "agentOpencode",
  "agentGemini",
  "agentCursor",
  "agentCopilot",
  "agentAmp",
  "agentGoose",
  "agentQwen",
  "agentKiro",
  "agentDroid",
  "agentCline",
  "agentDefault",
] as const

export type Token = (typeof TOKENS)[number]

/** A color value in a theme file. */
export type ColorValue = string | { dark: string; light: string }

export interface ThemeFile {
  $schema?: string
  name?: string
  /** Named palette colors, referenced by name from `theme`. */
  defs?: Record<string, ColorValue>
  theme: Partial<Record<Token | (string & {}), ColorValue>>
}

/** Fully resolved theme: every token is a concrete "#rrggbb" or "transparent". */
export type ResolvedTheme = Record<Token, string> & { name: string; appearance: "dark" | "light" }
