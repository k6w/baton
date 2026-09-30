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

  test("multi-line values are replaced whole", () => {
    const src = `[workspace]\nlink = [\n  "node_modules", # deps\n  ".venv",\n]\nsetup = """\nbun install\n"""\nreview = "off"\n`
    let out = setTomlValue(src, "workspace.link", ["vendor"])
    out = setTomlValue(out, "workspace.setup", "make deps")
    expect(parse(out)).toEqual({ workspace: { link: ["vendor"], setup: "make deps", review: "off" } })
    expect(parse(setTomlValue(src, "workspace.link", undefined))).toEqual({ workspace: { setup: "bun install\n", review: "off" } })
  })
  test("quoted table names, single-quoted keys, [[arrays]] and CRLF", () => {
    const src = `# top\r\n[agent_style."my.agent"]\r\n'color' = "red"\r\n\r\n[[policy.rules]]\r\naction = "deny"\r\n\r\n[ui]\r\ntheme = "x"\r\n`
    let out = setTomlValue(src, 'agent_style."my.agent".color', "blue")
    out = setTomlValue(out, "ui.theme", "nord")
    expect(out).toContain("# top\r\n")
    expect(out.replace(/\r\n/g, "")).not.toContain("\n")
    expect(parse(out)).toEqual({ agent_style: { "my.agent": { color: "blue" } }, policy: { rules: [{ action: "deny" }] }, ui: { theme: "nord" } })
  })
  test("inline tables and dotted keys fall back to a correct rewrite", () => {
    const inline = `agent_style = { claude = { color = "red" } }\n`
    expect(parse(setTomlValue(inline, "agent_style.claude.color", "blue"))).toEqual({ agent_style: { claude: { color: "blue" } } })
    const dotted = `ui.theme = "x"\nui.fps = 30\n`
    expect(parse(setTomlValue(dotted, "ui.theme", "nord"))).toEqual({ ui: { theme: "nord", fps: 30 } })
  })
})
