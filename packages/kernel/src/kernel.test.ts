import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diffLines, parseUnifiedDiff } from "@batonsh/protocol"
import { EventStore, RunState, envLayer, formatCount, loadConfig, template } from "./index.ts"

describe("EventStore", () => {
  test("append validates, assigns seq and replays in order", () => {
    const s = new EventStore()
    const run = s.createRun("/tmp/x", "t")
    const a = s.append(run, { type: "agent.spawned", data: { agentId: "a1", name: "codex-1", adapter: "codex", cwd: "/tmp/x" } }, { agentId: "a1" })
    const b = s.append(run, { type: "agent.status", data: { status: "busy" } }, { agentId: "a1" })
    expect(b.seq).toBe(a.seq + 1)
    expect(() => s.append(run, { type: "agent.status", data: { status: "nope" as never } })).toThrow()
    const evs = s.query({ runId: run })
    expect(evs.map((e) => e.type)).toEqual(["agent.spawned", "agent.status"])
    expect(s.query({ runId: run, types: ["agent.*"] }).length).toBe(2)
    expect(s.query({ runId: run, fromSeq: a.seq }).length).toBe(1)
    expect(s.listRuns()[0]?.lastSeq).toBe(b.seq)
  })

  test("subscribers see appended events", () => {
    const s = new EventStore()
    const run = s.createRun("/tmp")
    const seen: string[] = []
    s.subscribe((e) => seen.push(e.type))
    s.append(run, { type: "log", data: { level: "info", message: "hi" } })
    expect(seen).toEqual(["log"])
  })
})

describe("RunState projection", () => {
  test("tracks agents, tool calls, diffs, usage, approvals and bus", () => {
    const s = new EventStore()
    const run = s.createRun("/p")
    const st = new RunState()
    s.subscribe((e) => st.apply(e))
    s.append(run, { type: "agent.spawned", data: { agentId: "a", name: "claude-1", adapter: "claude", cwd: "/p" } }, { agentId: "a" })
    s.append(run, { type: "agent.spawned", data: { agentId: "b", name: "codex-1", adapter: "codex", cwd: "/p" } }, { agentId: "b" })
    s.append(run, { type: "turn.started", data: { turnId: "t1", prompt: "fix it" } }, { agentId: "a" })
    s.append(run, { type: "tool.call", data: { toolCallId: "tc", kind: "edit", name: "Edit", title: "Update(a.ts)" } }, { agentId: "a" })
    const lines = diffLines("a\nteh\nc\n", "a\nthe\nc\n")
    s.append(run, { type: "tool.update", data: { toolCallId: "tc", status: "completed", summary: "Updated 1 line", content: [{ type: "diff", path: "a.ts", lines }] } }, { agentId: "a" })
    s.append(run, { type: "usage.updated", data: { input: 100, output: 20, costUsd: 0.5 } }, { agentId: "a" })
    s.append(run, { type: "usage.updated", data: { input: 300, output: 50, costUsd: 0.75 } }, { agentId: "a" })
    s.append(run, { type: "permission.requested", data: { requestId: "r1", title: "Bash(rm -rf)", options: [] } }, { agentId: "a" })
    s.append(run, { type: "bus.message", data: { messageId: "m1", from: "b", to: "a", kind: "chat", body: "tailwind landed" } })
    const a = st.agents.get("a")!
    expect(a.status).toBe("busy")
    expect(a.toolCalls).toBe(1)
    expect(a.diff).toEqual({ added: 1, removed: 1 })
    expect(a.usage.input).toBe(300)
    expect(st.totals.costUsd).toBeCloseTo(0.75)
    expect(st.approvals.size).toBe(1)
    const feed = st.feed("a").items
    expect(feed.map((i) => i.kind)).toEqual(["user", "tool", "permission", "bus"])
    s.append(run, { type: "permission.resolved", data: { requestId: "r1", optionId: "x", kind: "reject_once", by: "user" } }, { agentId: "a" })
    expect(st.approvals.size).toBe(0)
    expect(st.findAgent("CODEX-1")?.agentId).toBe("b")
  })
})

describe("config", () => {
  test("layers merge with provenance; env shortcuts apply", () => {
    const home = mkdtempSync(join(tmpdir(), "baton-cfg-"))
    const proj = mkdtempSync(join(tmpdir(), "baton-proj-"))
    mkdirSync(join(proj, ".baton"))
    writeFileSync(join(home, "config.toml"), `[ui]\ntheme = "nord"\nfps = 30\n`)
    writeFileSync(join(proj, ".baton", "config.toml"), `[ui]\nfps = 45\n[agents.rev]\nadapter = "codex"\nautostart = 2\n`)
    process.env.BATON_CONFIG_DIR = home
    const c = loadConfig({ projectRoot: proj, env: { BATON_LAYOUT: "focus" }, overrides: { orchestrator: { model: "opus" } } })
    delete process.env.BATON_CONFIG_DIR
    expect(c.errors).toEqual([])
    expect(c.config.ui.theme).toBe("nord")
    expect(c.config.ui.fps).toBe(45)
    expect(c.config.ui.layout).toBe("focus")
    expect(c.config.ui.border).toBe("rounded")
    expect(c.config.agents.rev?.autostart).toBe(2)
    expect(c.config.orchestrator.model).toBe("opus")
    expect(c.provenance["ui.theme"]).toBe("global")
    expect(c.provenance["ui.fps"]).toBe("project")
    expect(c.provenance["ui.layout"]).toBe("env")
  })

  test("an invalid key is dropped, everything else still applies", () => {
    const proj = mkdtempSync(join(tmpdir(), "baton-proj-"))
    mkdirSync(join(proj, ".baton"))
    writeFileSync(join(proj, ".baton", "config.toml"), `[orchestrator]\nagent = "codex"\n[defaults]\napproval = "sometimes"\n[ui]\nfps = 999\ntheme = "nord"\n`)
    process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
    const c = loadConfig({ projectRoot: proj, env: {} })
    delete process.env.BATON_CONFIG_DIR
    expect(c.config.orchestrator.agent).toBe("codex")
    expect(c.config.ui.theme).toBe("nord")
    expect(c.config.defaults.approval).toBe("ask")
    expect(c.config.ui.fps).toBe(30)
    expect(c.errors.length).toBe(2)
    expect(c.errors.join("\n")).toContain("defaults.approval (from project)")
  })

  test("envLayer parses nested keys", () => {
    expect(envLayer({ BATON_BUDGET__RUN_USD: "5" })).toEqual({ budget: { run_usd: 5 } })
  })
})

describe("protocol utils", () => {
  test("diffLines numbers lines", () => {
    const l = diffLines("a\nb\nc\n", "a\nB\nc\nd\n", Infinity)
    expect(l.map((x) => `${x.kind}:${x.text}`)).toEqual(["ctx:a", "del:b", "add:B", "ctx:c", "add:d"])
    expect(l[2]?.newLine).toBe(2)
    expect(l[1]?.oldLine).toBe(2)
  })
  test("parseUnifiedDiff", () => {
    const f = parseUnifiedDiff("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -14,1 +14,1 @@\n-teh\n+the\n")
    expect(f[0]?.path).toBe("x")
    expect(f[0]?.lines).toEqual([
      { kind: "del", text: "teh", oldLine: 14 },
      { kind: "add", text: "the", newLine: 14 },
    ])
  })
  test("formatCount", () => {
    expect([0, 7, 999, 1000, 43231, 1234567, -7174].map(formatCount)).toEqual(["0", "7", "999", "1,000", "43,231", "1,234,567", "-7,174"])
  })
  test("template", () => {
    expect(template("{a}/{b} x{missing}", { a: 1, b: "2" })).toBe("1/2 x")
  })
})
