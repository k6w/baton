import { describe, expect, test } from "bun:test"
import { PolicyEngine } from "./policy.ts"

const req = (title: string, kind?: string) => ({ agentId: "a", agentName: "codex-1", adapter: "codex", title, kind: kind as never })

describe("policy", () => {
  test("baton's own MCP tools are always allowed", () => {
    const p = new PolicyEngine("strict", [])
    expect(p.decide(req('baton: Allow the baton MCP server to run tool "spawn_agent"?', "other"))).toBe("allow")
    expect(p.decide(req("baton.spawn_agent", "other"))).toBe("allow")
    expect(p.decide(req("mcp__baton__send_message", "other"))).toBe("allow")
    expect(p.decide(req("baton_report_progress", "other"))).toBe("allow")
    expect(p.decide(req("rebaton.x", "other"))).toBe("ask")
    expect(p.decide(req("Bash(echo baton.x)", "execute"))).toBe("ask")
    expect(p.decide(req("baton.spawn_agent", "execute"))).toBe("ask")
  })

  test("balanced preset: reads/edits allowed, dangerous commands ask", () => {
    const p = new PolicyEngine("balanced", [])
    expect(p.decide(req("Read(a.ts)", "read"))).toBe("allow")
    expect(p.decide(req("Update(a.ts)", "edit"))).toBe("allow")
    expect(p.decide(req("Bash(git push origin main)", "execute"))).toBe("ask")
    expect(p.decide(req("Bash(rm -rf build)", "execute"))).toBe("ask")
    expect(p.decide(req("Bash(ls)", "execute"))).toBe("ask")
  })

  test("user rules win, and always-decisions are remembered per agent", () => {
    const p = new PolicyEngine("strict", [{ kinds: ["execute"], match: "^Bash\\((bun|npm) test", action: "allow" }])
    expect(p.decide(req("Bash(bun test)", "execute"))).toBe("allow")
    expect(p.decide(req("Bash(make)", "execute"))).toBe("ask")
    p.remember(req("Bash(make)", "execute"), "allow_always")
    expect(p.decide(req("Bash(make all)", "execute"))).toBe("allow")
    p.forgetAgent("a")
    expect(p.decide(req("Bash(make)", "execute"))).toBe("ask")
    expect(new PolicyEngine("yolo", []).decide(req("Bash(rm -rf /)", "execute"))).toBe("allow")
  })
})
