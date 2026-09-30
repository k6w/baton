/**
 * Approval policy engine. Every native permission request (Codex approvals, Claude
 * canUseTool, ACP request_permission, OpenCode permissions) lands here first; rules may
 * auto-allow or auto-deny, everything else goes to the user's approval inbox.
 */
import type { PolicyRule } from "@batonsh/kernel"
import type { PermissionOption, ToolKind } from "@batonsh/protocol"

export type Decision = "allow" | "deny" | "ask"

export interface PolicyRequest {
  agentId: string
  agentName: string
  adapter: string
  title: string
  kind?: ToolKind
  detail?: string
}

/** Baton's own coordination tools (spawn_agent, send_message, …) never need a human. */
// Anchored + kind-restricted so a shell command that merely *mentions* baton can't slip through.
const BUILTIN_RULES: PolicyRule[] = [
  {
    kinds: ["other", "delegate", "think", "fetch"],
    match: '^(mcp__baton__\\w+|baton[._]\\w+|baton: Allow the baton MCP server to run tool "\\w+"\\??)(\\(|\\s*$|\\n)',
    action: "allow",
  },
]

const PRESETS: Record<"strict" | "balanced" | "yolo", PolicyRule[]> = {
  strict: [{ kinds: ["read", "search", "think"], action: "allow" }],
  balanced: [
    { kinds: ["read", "search", "think", "switch_mode"], action: "allow" },
    // destructive / outward-facing commands always ask
    {
      kinds: ["execute"],
      match: "\\b(rm\\s+-rf|git\\s+push|git\\s+reset\\s+--hard|sudo|curl[^|]*\\|\\s*(ba)?sh|npm\\s+publish|docker\\s+push|kubectl\\s+(apply|delete))\\b",
      action: "ask",
    },
    { kinds: ["edit"], action: "allow" },
  ],
  yolo: [{ action: "allow" }],
}

export class PolicyEngine {
  /** "agentId|toolName-or-kind" → remembered decision from allow_always / reject_always. */
  private remembered = new Map<string, "allow" | "deny">()

  constructor(
    private preset: "strict" | "balanced" | "yolo",
    private rules: PolicyRule[],
  ) {}

  configure(preset: "strict" | "balanced" | "yolo", rules: PolicyRule[]) {
    this.preset = preset
    this.rules = rules
  }

  /**
   * Remembered decisions are scoped narrowly: shell commands by their full command line
   * (so "always allow `npm test`" never covers `npm publish`), other tools by tool + target.
   */
  private key(r: PolicyRequest): string {
    const kind = r.kind ?? "other"
    const subject = kind === "execute" ? normalize(`${r.title}\n${r.detail ?? ""}`) : `${verb(r.title)}|${normalize(r.title)}`
    return `${r.agentId}|${kind}|${subject}`
  }

  private match(rule: PolicyRule, r: PolicyRequest): boolean {
    if (rule.kinds?.length && !rule.kinds.includes(r.kind ?? "other")) return false
    if (rule.agents?.length && !rule.agents.includes(r.agentName) && !rule.agents.includes(r.adapter)) return false
    if (rule.match) {
      let re: RegExp
      try {
        re = new RegExp(rule.match, "i")
      } catch {
        return false
      }
      if (!re.test(`${r.title}\n${r.detail ?? ""}`)) return false
    }
    return true
  }

  decide(r: PolicyRequest): Decision {
    // the user's explicit rules win over anything remembered from a past click
    for (const rule of this.rules) if (this.match(rule, r)) return rule.action
    const mem = this.remembered.get(this.key(r))
    if (mem) return mem
    for (const rule of [...BUILTIN_RULES, ...PRESETS[this.preset]]) if (this.match(rule, r)) return rule.action
    return "ask"
  }

  remember(r: PolicyRequest, kind: "allow_always" | "reject_always") {
    this.remembered.set(this.key(r), kind === "allow_always" ? "allow" : "deny")
  }

  forgetAgent(agentId: string) {
    for (const k of [...this.remembered.keys()]) if (k.startsWith(`${agentId}|`)) this.remembered.delete(k)
  }
}

function normalize(s: string): string {
  return s.trim().replace(/\s+/g, " ").slice(0, 500)
}

/** First word of a tool title: "Bash(make lint)" → "Bash", "Ran git diff" → "Ran git". */
function verb(title: string): string {
  const m = /^([\w.-]+)\(/.exec(title)
  if (m) return m[1] as string
  return title.split(/\s+/).slice(0, 2).join(" ")
}

export function pickOption(options: PermissionOption[], decision: "allow" | "deny"): PermissionOption | undefined {
  const want = decision === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]
  for (const k of want) {
    const o = options.find((x) => x.kind === k)
    if (o) return o
  }
  return undefined
}
