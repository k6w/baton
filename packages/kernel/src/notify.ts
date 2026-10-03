/**
 * Attention routing: decide which events deserve a desktop notification / bell, honoring
 * [notify] settings and whether the terminal currently has focus. Pure decision function +
 * a small dispatcher, so it's testable.
 */

import type { BatonEvent } from "@batonsh/protocol"
import type { BatonConfig } from "./config.ts"
import type { RunState } from "./projection.ts"

export type NotifyKind = "approval" | "done" | "error" | "merge"

export interface Notice {
  kind: NotifyKind
  title: string
  body: string
}

/** Which notice (if any) an event produces. `prevBusy` = was anything busy before this event. */
export function noticeFor(e: BatonEvent, run: RunState): Notice | undefined {
  const name = e.agentId ? (run.agents.get(e.agentId)?.name ?? "agent") : "baton"
  switch (e.type) {
    case "permission.requested":
      return { kind: "approval", title: "Baton — approval needed", body: `${name}: ${e.data.title}` }
    case "turn.completed": {
      if (!e.agentId || e.agentId !== run.orchestratorId) return undefined
      // the lead finished and nobody is still working
      const busy = [...run.agents.values()].some((a) => a.agentId !== e.agentId && (a.status === "busy" || a.status === "awaiting_approval"))
      if (busy) return undefined
      return { kind: "done", title: "Baton — done", body: "The orchestrator finished; all agents are idle." }
    }
    case "error":
      return e.data.fatal ? { kind: "error", title: `Baton — ${name} failed`, body: e.data.message } : undefined
    case "workspace.merge":
      if (e.data.status === "merged" && e.data.files?.length)
        return { kind: "merge", title: "Baton — merged", body: `${name}: ${e.data.files.length} file(s) landed` }
      if (e.data.status === "failed" || e.data.status === "conflict")
        return { kind: "merge", title: `Baton — merge ${e.data.status}`, body: `${name}: ${e.data.detail ?? ""}` }
      return undefined
    default:
      return undefined
  }
}

/**
 * How to tell the user. `focusMode` (do-not-disturb) holds everything except approvals and errors —
 * the two things that block work.
 */
export function shouldNotify(n: Notice, cfg: BatonConfig["notify"], focused: boolean, focusMode = false): { desktop: boolean; bell: boolean; sound: boolean } {
  const none = { desktop: false, bell: false, sound: false }
  if (!cfg.events.includes(n.kind)) return none
  if (focusMode && n.kind !== "approval" && n.kind !== "error") return none
  // sounds also play while you're looking at Baton: that's when you'd hear them
  const sound = cfg.sound !== "off" || !!cfg.sounds[n.kind]
  if (focused && !cfg.when_focused) return { desktop: false, bell: false, sound }
  return { desktop: cfg.desktop, bell: cfg.bell, sound }
}
