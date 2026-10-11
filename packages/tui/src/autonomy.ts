/** Run-wide autonomy: how the current level is shown, and the shift+tab cycle. */
import type { UiState } from "./state.ts"

export type Autonomy = "normal" | "ask" | "auto" | "yolo"

/** shift+tab order: the safe default first, then more and more freedom, then back to careful. */
export const AUTONOMY_CYCLE: Autonomy[] = ["normal", "auto", "yolo", "ask"]

export const AUTONOMY_INFO: Record<Autonomy, { label: string; glyph: string; token: "textMuted" | "info" | "warning" | "error"; blurb: string }> = {
  normal: { label: "normal", glyph: "◆", token: "textMuted", blurb: "each agent uses its own setting; edits are fine, risky commands ask" },
  ask: { label: "ask first", glyph: "◇", token: "info", blurb: "every agent asks before editing or running anything" },
  auto: { label: "auto", glyph: "↯", token: "warning", blurb: "agents act on their own; destructive commands still ask" },
  yolo: { label: "YOLO", glyph: "▲", token: "error", blurb: "no prompts, no sandbox, for every agent — your deny rules still apply" },
}

/** Effective level for display: an explicit run level, or YOLO implied by config / an agent. */
export function currentAutonomy(ui: UiState): Autonomy {
  ui.version()
  const mode = ui.run.autonomy
  if (mode !== "normal") return mode
  if (ui.config.policy.preset === "yolo") return "yolo"
  return "normal"
}

/** Some agent runs without guard rails even though the run level is normal. */
export function anyYoloAgent(ui: UiState): boolean {
  ui.version()
  return [...ui.run.agents.values()].some((a) => a.status !== "exited" && a.approval === "yolo")
}
