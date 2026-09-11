/** Per-agent presentation: icon, brand color, native look. */

import { type AgentIcon, glyph, type IconMode, iconFor, logoPath } from "@batonsh/icons"
import type { AgentView } from "@batonsh/protocol"
import type { ResolvedTheme, Token } from "@batonsh/themes"
import type { LookStyle } from "./lines.ts"
import type { UiState } from "./state.ts"

export interface AgentLook {
  icon: AgentIcon
  glyph: string
  color: string
  look: LookStyle
  logo?: string
}

export function agentLook(ui: UiState, agent: Pick<AgentView, "adapter" | "name" | "isOrchestrator">): AgentLook {
  const theme = ui.theme()
  const styles = ui.config.agent_style
  const icon = iconFor(agent.adapter, agent.name, styles)
  const custom = styles[agent.adapter]?.color ?? styles[agent.name]?.color
  const color = custom ?? (theme[icon.colorToken as Token] as string | undefined) ?? theme.agentDefault
  const mode = ui.prefs.icons
  const resolvedMode: IconMode = mode === "auto" ? (ui.imageSupport() ? "image" : "unicode") : (mode as IconMode)
  const look: LookStyle = ui.prefs.render_style === "unified" ? "claude" : icon.id === "codex" ? "codex" : "claude"
  return {
    icon,
    glyph: glyph(icon, resolvedMode === "image" ? "unicode" : resolvedMode),
    color,
    look,
    logo: resolvedMode === "image" ? logoPath(icon, theme.appearance) : undefined,
  }
}

/** Display name + brand color for any agent id / name / pseudo-sender ("user", "baton"). */
export function whoFn(ui: UiState): (ref: string) => { name: string; color: string } {
  return (ref) => {
    const t: ResolvedTheme = ui.theme()
    if (ref === "user") return { name: "you", color: t.accent }
    if (ref === "baton") return { name: "baton", color: t.textMuted }
    if (ref === "*") return { name: "all", color: t.textMuted }
    const a = ui.run.agents.get(ref) ?? ui.run.findAgent(ref)
    if (!a) return { name: ref, color: t.textMuted }
    if (a.isOrchestrator) return { name: "lead", color: t.busTo }
    return { name: a.name, color: agentLook(ui, a).color }
  }
}
