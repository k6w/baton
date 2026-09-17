import { describe, expect, test } from "bun:test"
import { parse } from "smol-toml"
import { setTomlValue } from "./toml-edit.ts"

const SRC = `# Baton config
plugins = []

[ui]
theme = "baton"            # ctrl+t to browse
layout = "grid"

[orchestrator]
agent = "claude"
`

describe("setTomlValue", () => {
  test("replaces a value in place and keeps comments", () => {
    const out = setTomlValue(SRC, "ui.theme", "nord")
    expect(out).toContain('theme = "nord"  # ctrl+t to browse')
    expect(out).toContain("# Baton config")
    expect(parse(out)).toMatchObject({ ui: { theme: "nord", layout: "grid" }, orchestrator: { agent: "claude" } })
  })
  test("adds keys to existing tables and creates missing tables", () => {
    let out = setTomlValue(SRC, "ui.fps", 60)
    out = setTomlValue(out, "workspace.verify", "bun test")
    out = setTomlValue(out, "agent_style.claude.color", "#ff8800")
    out = setTomlValue(out, "plugins", ["./x.ts"])
    const p = parse(out) as Record<string, any>
    expect(p.ui.fps).toBe(60)
    expect(p.workspace.verify).toBe("bun test")
    expect(p.agent_style.claude.color).toBe("#ff8800")
    expect(p.plugins).toEqual(["./x.ts"])
    expect(out.indexOf("fps = 60")).toBeLessThan(out.indexOf("[orchestrator]"))
  })
  test("removes keys and handles empty files", () => {
    expect(parse(setTomlValue(SRC, "ui.layout", undefined))).toMatchObject({ ui: { theme: "baton" } })
    expect(parse(setTomlValue("", "ui.theme", "nord"))).toEqual({ ui: { theme: "nord" } })
    expect(parse(setTomlValue("", "budget.run_usd", 2.5))).toEqual({ budget: { run_usd: 2.5 } })
  })
})
