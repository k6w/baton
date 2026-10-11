import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { addNote, BatonConfig, loadRoles, loadSkills, notesBlock, readNotes, readSkill, searchNotes } from "@batonsh/kernel"
import type { AdapterContext, AgentAdapter, AgentEvent, AgentSession, SessionConfig } from "@batonsh/protocol"
import { buildMcpServer } from "./mcp.ts"
import { PolicyEngine } from "./policy.ts"
import { Runtime } from "./runtime.ts"

interface Fake {
  cfg: SessionConfig
  emit: (e: AgentEvent) => void
  prompts: string[]
  approvals: string[]
}

function fakeAdapter(sessions: Map<string, Fake>): AgentAdapter {
  return {
    id: "fake",
    displayName: "Fake",
    family: "exec",
    binaries: [],
    detect: async () => ({ installed: true, auth: "ok", protocols: ["exec"] }),
    capabilities: () => ({
      steer: false,
      interrupt: true,
      resume: false,
      fork: false,
      diff: false,
      usage: true,
      cost: true,
      permissions: true,
      mcp: true,
      models: [],
    }),
    async start(cfg, ctx: AdapterContext): Promise<AgentSession> {
      const f: Fake = { cfg, emit: ctx.emit, prompts: [], approvals: [cfg.approval] }
      sessions.set(cfg.name, f)
      return {
        async prompt(input) {
          f.prompts.push(input.text)
          ctx.emit({ type: "turn.started", data: { turnId: `t${f.prompts.length}`, prompt: input.text } })
        },
        async interrupt() {},
        async respondPermission() {},
        async setApproval(mode) {
          f.approvals.push(mode)
        },
        resumeId: () => undefined,
        async close() {},
      }
    },
  }
}

const runtimes: Runtime[] = []
let root = ""
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-roles-"))
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
})
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
})

function setup(over: Record<string, unknown> = {}) {
  const sessions = new Map<string, Fake>()
  const config = BatonConfig.parse({ bus: { heartbeat_s: 0 }, workspace: { isolation: "shared" }, ...over })
  const rt = new Runtime({ projectRoot: root, config })
  rt.registry.register(fakeAdapter(sessions))
  runtimes.push(rt)
  return { rt, fake: (n: string) => sessions.get(n) as Fake }
}

const endTurn = (f: Fake, text = "done") => {
  f.emit({ type: "message.completed", data: { messageId: `m${Math.random()}`, role: "assistant", text } })
  f.emit({ type: "turn.completed", data: { turnId: "t", stopReason: "end_turn" } })
}

function writeSkill(name: string, desc: string, body: string, extra?: Record<string, string>) {
  const dir = join(root, ".baton", "skills", name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`)
  for (const [f, c] of Object.entries(extra ?? {})) writeFileSync(join(dir, f), c)
}

describe("catalog", () => {
  test("built-in roles, project role files and config entries merge (later wins, field by field)", () => {
    mkdirSync(join(root, ".baton", "roles"), { recursive: true })
    writeFileSync(
      join(root, ".baton", "roles", "api.md"),
      "---\ndescription: Owns the HTTP API\naccess: write\nacceptance: bun test api\nskills: [rest]\n---\nYou own src/api.",
    )
    writeFileSync(join(root, ".baton", "roles", "tester.md"), "---\nacceptance: bun test\n---\n")
    const roles = loadRoles(root, BatonConfig.parse({ roles: { tester: { model: "fast" }, ops: { prompt: "Deploys.", description: "Ops" } } }))
    expect(roles.get("reviewer")?.access).toBe("read-only")
    expect(roles.get("api")).toMatchObject({
      description: "Owns the HTTP API",
      acceptance: "bun test api",
      skills: ["rest"],
      prompt: "You own src/api.",
      source: "project",
    })
    // the project file adds an acceptance check, config a model; the built-in prompt stays
    expect(roles.get("tester")).toMatchObject({ acceptance: "bun test", model: "fast", source: "config" })
    expect(roles.get("tester")?.prompt).toContain("tester")
    expect(roles.get("ops")?.prompt).toBe("Deploys.")
  })

  test("skills: .baton/skills and .claude/skills, with description and file list", () => {
    writeSkill("rest", "Our REST conventions", "Use snake_case.", { "examples.md": "x" })
    mkdirSync(join(root, ".claude", "skills", "deploy"), { recursive: true })
    writeFileSync(join(root, ".claude", "skills", "deploy", "SKILL.md"), "# Deploy\nShip it with make deploy.\n")
    const skills = loadSkills(root, BatonConfig.parse({}))
    expect(skills.get("rest")?.description).toBe("Our REST conventions")
    expect(skills.get("deploy")?.description).toBe("Ship it with make deploy.")
    expect(readSkill(skills.get("rest")!)).toContain("Use snake_case.")
    expect(readSkill(skills.get("rest")!)).toContain("- examples.md")
    expect(loadSkills(root, BatonConfig.parse({ skills: { claude: false } })).has("deploy")).toBe(false)
  })

  test("team notes: append, dedupe, search, and the block new workers get", () => {
    expect(addNote(root, "codex-1", "The API uses snake_case")).toBe(true)
    expect(addNote(root, "claude-1", "the api uses SNAKE_CASE")).toBe(false)
    addNote(root, "claude-1", "Integration tests need DB_URL")
    expect(readNotes(root).map((n) => n.author)).toEqual(["codex-1", "claude-1"])
    expect(searchNotes(root, "db url").map((n) => n.text)).toEqual(["Integration tests need DB_URL"])
    expect(notesBlock(root, 1)).toContain("Integration tests need DB_URL")
    expect(notesBlock(root, 1)).not.toContain("snake_case")
    expect(readFileSync(join(root, ".baton", "notes.md"), "utf8")).toContain("# Team notes")
  })
})

describe("read-only access", () => {
  test("edits are denied even in yolo; reads and commands follow the policy", () => {
    const p = new PolicyEngine("balanced", [])
    p.setAccess("a", "read-only")
    p.setAutonomy("yolo")
    const req = (kind: "edit" | "read" | "execute") => ({ agentId: "a", agentName: "r", adapter: "x", title: "T", kind })
    expect(p.decide(req("edit"))).toBe("deny")
    expect(p.decide(req("read"))).toBe("allow")
    expect(p.decide(req("execute"))).toBe("allow")
    p.forgetAgent("a")
    expect(p.decide(req("edit"))).toBe("allow")
  })
})

describe("spawning with a spec", () => {
  test("role + instructions + skills + notes shape the system prompt; read-only caps the approval", async () => {
    writeSkill("rest", "Our REST conventions", "Use snake_case.")
    addNote(root, "codex-1", "Integration tests need DB_URL")
    const { rt, fake } = setup()
    const info = await rt.spawn({ adapter: "fake", name: "r", role: "reviewer", instructions: "Focus on the auth module.", skills: ["rest", "nope"] })
    const sp = fake("r").cfg.systemPrompt ?? ""
    expect(sp).toContain("## Your role: reviewer")
    expect(sp).toContain("## Read-only")
    expect(sp).toContain("## Instructions for you\nFocus on the auth module.")
    expect(sp).toContain("- rest: Our REST conventions")
    expect(sp).toContain("Integration tests need DB_URL")
    expect(info).toMatchObject({ role: "reviewer", access: "read-only", skills: ["rest"] })
    expect(fake("r").cfg.approval).toBe("ask")
    // the autonomy dial can't lift it
    await rt.setAutonomy("yolo")
    expect(fake("r").approvals.at(-1)).toBe("ask")
    expect(rt.state.feed(info.agentId).items.length >= 0).toBe(true)
  })

  test("a role supplies the adapter, and files are claimed for the worker", async () => {
    const { rt } = setup({ roles: { api: { adapter: "fake", description: "API" } } })
    const info = await rt.spawn({ adapter: "", role: "api", name: "w", files: ["src/api/**"] })
    expect(info.adapter).toBe("fake")
    const other = await rt.spawn({ adapter: "fake", name: "x" })
    expect(rt.collab.claim(other.agentId, ["src/api/routes.ts"]).ok).toBe(false)
  })

  test("acceptance: pass → result says so; fail → the worker retries, then the lead hears it failed", async () => {
    const { rt, fake } = setup({ policy: { preset: "yolo" } })
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    endTurn(fake("orchestrator"))
    const ok = await rt.spawn({ adapter: "fake", name: "ok", parentId: lead.agentId, prompt: "work", acceptance: "exit 0" })
    endTurn(fake("ok"))
    const leadText = () => [...fake("orchestrator").prompts, ...(rt.agents.get(lead.agentId)?.inbox.map((m) => m.body) ?? [])].join("\n")
    for (let i = 0; i < 100 && !leadText().includes("acceptance ✓"); i++) await Bun.sleep(20)
    expect(leadText()).toContain("acceptance ✓ `exit 0` passed")
    expect(rt.state.feed(ok.agentId).items.some((x) => x.kind === "tool" && x.title === "Acceptance: exit 0")).toBe(true)

    await rt.spawn({ adapter: "fake", name: "bad", parentId: lead.agentId, prompt: "work", acceptance: "echo nope && exit 3" })
    for (let round = 0; round < 3; round++) {
      endTurn(fake("bad"))
      for (let i = 0; i < 100 && fake("bad").prompts.length < round + 2 && !leadText().includes("still failing"); i++) await Bun.sleep(20)
    }
    expect(fake("bad").prompts.filter((p) => p.includes("acceptance check failed")).length).toBe(2)
    for (let i = 0; i < 100 && !leadText().includes("still failing"); i++) await Bun.sleep(20)
    expect(leadText()).toContain("result failed")
    expect(leadText()).toContain("acceptance ✗ `echo nope && exit 3` still failing")
  })
})

describe("MCP tools", () => {
  test("list_roles, list_skills / load_skill, note / recall", async () => {
    writeSkill("rest", "Our REST conventions", "Use snake_case.")
    const { rt } = setup({ orchestrator: { agent: "fake" } })
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    const server = buildMcpServer(rt, rt.agents.get(lead.agentId)!)
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const tools = (
        server as unknown as {
          _registeredTools: Record<string, { handler?: (a: unknown, x: unknown) => unknown; callback?: (a: unknown, x: unknown) => unknown }>
        }
      )._registeredTools
      const t = tools[name]
      const fn = t?.handler ?? t?.callback
      if (!fn) throw new Error(`no tool ${name}`)
      const r = (await fn(args, {})) as { content: { text: string }[] }
      return r.content.map((c) => c.text).join("")
    }
    expect(await call("list_roles")).toContain("tester:")
    expect(await call("list_roles")).toContain("reviewer: ")
    expect(await call("list_skills")).toContain("rest: Our REST conventions")
    expect(await call("load_skill", { name: "rest" })).toContain("Use snake_case.")
    expect(await call("note", { text: "Use bun, not npm" })).toBe("noted")
    expect(await call("recall", { query: "bun" })).toContain("Use bun, not npm")
    expect(await call("pick_agent", { task: "add tests for the parser" })).toContain("suggested role: tester")
  })
})

describe("slash commands", () => {
  test("/spawn <role>, /roles, /skills, /notes add, /team", async () => {
    const { handleInput } = await import("./input.ts")
    writeSkill("rest", "Our REST conventions", "Use snake_case.")
    const { rt } = setup({
      defaults: { worker: "fake" },
      teams: {
        qa: [
          { role: "tester", adapter: "fake", count: 2 },
          { role: "reviewer", adapter: "fake" },
        ],
      },
    })
    const r = await handleInput(rt, "/spawn tester fake 2 auth tests")
    expect(r.routedTo).toHaveLength(2)
    const a = rt.findAgent(r.routedTo[0] as string)
    expect(a?.info).toMatchObject({ role: "tester", label: "auth tests", adapter: "fake" })
    const solo = await handleInput(rt, "/spawn reviewer")
    expect(rt.findAgent(solo.routedTo[0] as string)?.info).toMatchObject({ role: "reviewer", access: "read-only", label: "reviewer" })
    expect((await handleInput(rt, "/roles")).output).toContain("security")
    expect((await handleInput(rt, "/skills")).output).toContain("rest")
    expect((await handleInput(rt, "/notes add Use bun, not npm", { who: "dana" })).output).toContain("noted")
    expect((await handleInput(rt, "/notes")).output).toContain("Use bun, not npm")
    expect(readNotes(root)[0]?.author).toBe("dana")
    const team = await handleInput(rt, "/team qa")
    expect(team.routedTo).toHaveLength(3)
    expect((await handleInput(rt, "/team")).output).toContain("qa")
  })
})
