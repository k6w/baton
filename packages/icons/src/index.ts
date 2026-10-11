/**
 * Agent icon packs. Each agent has a glyph for every icon mode plus an optional logo PNG.
 *
 *   image   → real logo via Kitty graphics / Sixel (when the terminal supports it)
 *   nerd    → Nerd Font (Font Awesome range) glyph
 *   unicode → plain Unicode glyph + brand color (default; matches the classic Baton look)
 *   ascii   → two-letter badge
 *
 * Logos are from LobeHub Icons (@lobehub/icons-static-png 1.97.1, MIT). The marks are
 * trademarks of their owners and are used only to identify which agent is running.
 */
import { LOGOS } from "./assets.ts"

export type IconMode = "image" | "nerd" | "unicode" | "ascii"

export interface AgentIcon {
  id: string
  label: string
  unicode: string
  nerd: string
  ascii: string
  /** Theme token holding the brand color. */
  colorToken: string
  /** Logo file name under assets/{dark,light}/ (if any). */
  logo?: string
}

const I = (id: string, label: string, unicode: string, nerd: string, ascii: string, colorToken: string, logo?: string): AgentIcon => ({
  id,
  label,
  unicode,
  nerd,
  ascii,
  colorToken,
  logo,
})

export const ICONS: Record<string, AgentIcon> = {
  claude: I("claude", "Claude Code", "✱", "", "CC", "agentClaude", "claude"),
  codex: I("codex", "Codex", ">_", "", "CX", "agentCodex", "codex"),
  opencode: I("opencode", "OpenCode", "⌬", "", "OC", "agentOpencode", "opencode"),
  gemini: I("gemini", "Gemini CLI", "✦", "", "GM", "agentGemini", "gemini"),
  cursor: I("cursor", "Cursor", "◆", "", "CU", "agentCursor", "cursor"),
  copilot: I("copilot", "Copilot", "⊚", "", "CP", "agentCopilot", "copilot"),
  amp: I("amp", "Amp", "↯", "", "AM", "agentAmp", "amp"),
  goose: I("goose", "Goose", "ɢ", "", "GS", "agentGoose", "goose"),
  qwen: I("qwen", "Qwen Code", "◎", "", "QW", "agentQwen", "qwen"),
  kiro: I("kiro", "Kiro", "◈", "", "KI", "agentKiro", "kiro"),
  droid: I("droid", "Droid", "⬡", "", "DR", "agentDroid"),
  cline: I("cline", "Cline", "◉", "", "CL", "agentCline", "cline"),
  kimi: I("kimi", "Kimi", "☾", "", "KM", "agentDefault", "kimi"),
  junie: I("junie", "Junie", "❖", "", "JU", "agentDefault", "junie"),
  "mistral-vibe": I("mistral-vibe", "Mistral Vibe", "▚", "", "MV", "agentDefault", "mistral-vibe"),
  aider: I("aider", "Aider", "◧", "\uf044", "AI", "agentDefault"),
  crush: I("crush", "Crush", "◈", "\uf004", "CR", "agentAmp"),
  exec: I("exec", "Command", "$", "\uf120", "$_", "agentDefault"),
  openhands: I("openhands", "OpenHands", "◉", "", "OH", "agentDefault", "openhands"),
  orchestrator: I("orchestrator", "Orchestrator", "✱", "", "OR", "primary"),
  user: I("user", "You", "❯", "", "ME", "accent"),
  baton: I("baton", "Baton", "⇄", "", "BT", "accent"),
  mock: I("mock", "Mock", "●", "", "MK", "agentDefault"),
  default: I("default", "Agent", "●", "", "AG", "agentDefault"),
}

const ALIASES: Record<string, string> = {
  "claude-acp": "claude",
  "claude-code": "claude",
  "codex-acp": "codex",
  "opencode-acp": "opencode",
  "claude-cli": "claude",
  "qwen-stream": "qwen",
  "gemini-cli": "gemini",
  "cursor-agent": "cursor",
  "github-copilot": "copilot",
  "qwen-code": "qwen",
  "kiro-cli": "kiro",
  factory: "droid",
  agy: "gemini",
  antigravity: "gemini",
}

/**
 * Pick an icon for an agent. Looks at the adapter id first, then the agent name prefix
 * ("claude-3" → claude) so custom profiles and mock personas get the right look.
 */
export function iconFor(adapter: string, name?: string, overrides?: Record<string, { icon?: string }>): AgentIcon {
  const tryKey = (k: string | undefined) => {
    if (!k) return undefined
    const key = ALIASES[k] ?? k
    return ICONS[key]
  }
  const byAdapter = adapter !== "mock" && adapter !== "acp" ? tryKey(adapter) : undefined
  const prefix = name?.toLowerCase().split(/[-_\s]/)[0]
  const icon = byAdapter ?? tryKey(prefix) ?? tryKey(adapter) ?? (ICONS.default as AgentIcon)
  const custom = overrides?.[adapter]?.icon
  return custom ? { ...icon, unicode: custom, nerd: custom } : icon
}

export function glyph(icon: AgentIcon, mode: IconMode): string {
  if (mode === "nerd") return icon.nerd
  if (mode === "ascii") return icon.ascii
  return icon.unicode
}

export function logoPath(icon: AgentIcon, appearance: "dark" | "light"): string | undefined {
  if (!icon.logo) return undefined
  return LOGOS[icon.logo]?.[appearance]
}
