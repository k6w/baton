/**
 * When does the native agent ask Baton before acting?
 *
 *   ask        edits + commands ask
 *   auto-edit  commands ask
 *   auto       only obviously destructive commands ask
 *   yolo       nothing asks
 *
 * Reads, searches and MCP tools never ask (Baton's own policy still governs the bus server).
 * web_fetch ("network") asks only in `ask` mode.
 */
import type { ApprovalMode } from "@batonsh/protocol"
import type { ToolCategory } from "./tools.ts"

const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rRf][a-zA-Z]*\s+|--recursive|--force)/, // rm -rf, rm -r, rm -f
  /\bsudo\b/,
  /\bgit\s+push\b[^|;&]*(--force\b|-f\b|--force-with-lease|--delete|\s:\S)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\b[^|;&]*-[a-zA-Z]*f/,
  /\bgit\s+checkout\s+(--\s+)?\.(\s|$)/,
  /\bgit\s+restore\b[^|;&]*\s\.(\s|$)/,
  /\bgit\s+branch\s+-D\b/,
  /\bgit\s+(stash\s+(drop|clear)|filter-branch|update-ref\s+-d)\b/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\s+[^|;&]*\bof=/,
  />\s*\/dev\/(sd|disk|nvme|hd)/,
  /\b(shutdown|reboot|halt|poweroff)\b/,
  /\bchmod\s+(-[a-zA-Z]*R|--recursive)\b/,
  /\bchown\s+(-[a-zA-Z]*R|--recursive)\b/,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
  /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i,
  /\bkill(all)?\s+-9\b/,
  /\bfind\b[^|;&]*\s-delete\b/,
  /\b(curl|wget)\b[^|;&]*\|\s*(ba|z)?sh\b/,
  /\bnpm\s+publish\b|\bbun\s+publish\b|\bcargo\s+publish\b/,
  /\bdocker\s+(system\s+prune|rm\s+-f|volume\s+rm)\b/,
  /\bterraform\s+(destroy|apply)\b|\bkubectl\s+delete\b/,
]

export function isDestructiveCommand(command: string): boolean {
  return DESTRUCTIVE.some((re) => re.test(command))
}

export function needsApproval(mode: ApprovalMode, category: ToolCategory, command?: string): boolean {
  if (category === "read" || category === "other") return false
  if (category === "network") return mode === "ask"
  switch (mode) {
    case "yolo":
      return false
    case "auto":
      return category === "execute" && isDestructiveCommand(command ?? "")
    case "auto-edit":
      return category === "execute"
    default:
      return true
  }
}
