/**
 * Runtime lifecycle + bus edge cases with a scriptable fake adapter: crashes, failed prompts,
 * budget stops, aborted long-polls, batched deliveries.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonConfig } from "@batonsh/kernel"
import type { AdapterContext, AgentAdapter, AgentEvent, AgentSession, PromptInput } from "@batonsh/protocol"
import { Runtime } from "./runtime.ts"

interface Fake {
  emit: (ev: AgentEvent) => void
  prompts: PromptInput[]
  failPrompts: boolean
  approvals: string[]
  responses: (string | null)[]
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
      const f: Fake = { emit: ctx.emit, prompts: [], failPrompts: false, approvals: [cfg.approval], responses: [] }
      sessions.set(cfg.name, f)
      return {
        async prompt(input) {
          if (f.failPrompts) throw new Error("adapter down")
          f.prompts.push(input)
          ctx.emit({ type: "turn.started", data: { turnId: `t${f.prompts.length}`, prompt: input.text } })
        },
        async interrupt() {},
        async respondPermission(_id, optionId) {
          f.responses.push(optionId)
        },
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
afterEach(async () => {
  for (const r of runtimes.splice(0)) await r.close()
})

function setup(over: Record<string, unknown> = {}) {
  const sessions = new Map<string, Fake>()
  const config = BatonConfig.parse({ bus: { heartbeat_s: 0 }, workspace: { isolation: "shared" }, ...over })
  const rt = new Runtime({ projectRoot: mkdtempSync(join(tmpdir(), "baton-rt-")), config })
  rt.registry.register(fakeAdapter(sessions))
  runtimes.push(rt)
  const fake = (name: string) => sessions.get(name) as Fake
  return { rt, fake }
}

function endTurn(f: Fake, text = "done") {
  f.emit({ type: "message.completed", data: { messageId: `m${Math.random()}`, role: "assistant", text } })
  f.emit({ type: "turn.completed", data: { turnId: "t", stopReason: "end_turn" } })
}

describe("runtime lifecycle", () => {
  test("a crashed worker reports a failed result to its dispatcher and fails its task", async () => {
    const { rt, fake } = setup()
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    await rt.collab.plan([{ id: "t1", title: "do it" }])
    const w = await rt.spawn({ adapter: "fake", name: "w", parentId: lead.agentId, prompt: "work", taskId: "t1" })
    expect(rt.agents.get(w.agentId)?.resultTo.has(lead.agentId)).toBe(true)
    fake("w").emit({ type: "agent.exited", data: { code: 1, reason: "segfault" } })
    await Bun.sleep(20)
    const inbox = rt.agents.get(lead.agentId)?.inbox ?? []
    const delivered = fake("orchestrator")
      .prompts.map((p) => p.text)
      .join("\n")
    expect(`${delivered}\n${inbox.map((m) => m.body).join("\n")}`).toContain("result failed")
    expect(rt.state.tasks.get("t1")?.state).toBe("failed")
    expect(rt.findAgent("w")).toBeUndefined()
  })

  test("wait_for_results wakes when the awaited worker dies", async () => {
    const { rt, fake } = setup()
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    await rt.spawn({ adapter: "fake", name: "w", parentId: lead.agentId, prompt: "work" })
    const started = Date.now()
    const wait = rt.waitInbox(lead.agentId, 5000, (inbox) => inbox.some((m) => m.kind === "result"))
    fake("w").emit({ type: "agent.exited", data: { code: null, reason: "killed by OOM" } })
    const msgs = await wait
    expect(Date.now() - started).toBeLessThan(1000)
    expect(msgs[0]?.body).toContain("killed by OOM")
  })

  test("an aborted long-poll consumes nothing; messages are delivered normally afterwards", async () => {
    const { rt, fake } = setup()
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    const w = await rt.spawn({ adapter: "fake", name: "w" })
    endTurn(fake("orchestrator"))
    const ac = new AbortController()
    const wait = rt.waitInbox(lead.agentId, 5000, () => false, ac.signal)
    rt.send({ from: w.agentId, to: "orchestrator", body: "hello lead" })
    ac.abort()
    expect(await wait).toEqual([])
    await Bun.sleep(10)
    expect(
      fake("orchestrator")
        .prompts.map((p) => p.text)
        .join("\n"),
    ).toContain("hello lead")
  })

  test("a failed delivery keeps the message in the inbox", async () => {
    const { rt, fake } = setup()
    await rt.spawn({ adapter: "fake", name: "a" })
    const b = await rt.spawn({ adapter: "fake", name: "b" })
    fake("b").failPrompts = true
    rt.send({ from: "user", to: "b", body: "important" })
    await Bun.sleep(10)
    expect(rt.agents.get(b.agentId)?.inbox.map((m) => m.body)).toEqual(["important"])
  })

  test("batched requests still route each answer back to its sender", async () => {
    const { rt, fake } = setup()
    const a = await rt.spawn({ adapter: "fake", name: "a" })
    const c = await rt.spawn({ adapter: "fake", name: "c" })
    const b = await rt.spawn({ adapter: "fake", name: "b", prompt: "busy" })
    rt.send({ from: a.agentId, to: "b", body: "q1", kind: "request" })
    rt.send({ from: c.agentId, to: "b", body: "q2", kind: "request" })
    endTurn(fake("b"))
    await Bun.sleep(10)
    expect(fake("b").prompts.at(-1)?.text).toContain("2 messages")
    const to = rt.agents.get(b.agentId)?.resultTo ?? new Set()
    expect(to.has(a.agentId) && to.has(c.agentId)).toBe(true)
  })

  test("acknowledgments don't start turns; they ride along with the next real message", async () => {
    const { rt, fake } = setup()
    const a = await rt.spawn({ adapter: "fake", name: "a" })
    await rt.spawn({ adapter: "fake", name: "b" })
    endTurn(fake("b"))
    const before = fake("b").prompts.length
    rt.send({ from: a.agentId, to: "b", body: "Thanks, acknowledged — closing out." })
    await Bun.sleep(10)
    expect(fake("b").prompts.length).toBe(before)
    rt.send({ from: a.agentId, to: "b", body: "One more thing: please rename foo to bar?" })
    await Bun.sleep(10)
    expect(fake("b").prompts.length).toBe(before + 1)
    expect(fake("b").prompts.at(-1)?.text).toContain("rename foo")
  })

  test("worker ping-pong stops starting turns and tells the lead", async () => {
    const { rt, fake } = setup()
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    endTurn(fake("orchestrator"))
    const a = await rt.spawn({ adapter: "fake", name: "a" })
    await rt.spawn({ adapter: "fake", name: "b" })
    endTurn(fake("b"))
    for (let i = 0; i < 8; i++) {
      rt.send({ from: a.agentId, to: "b", body: `status update ${i}: still checking the parser` })
      await Bun.sleep(5)
      endTurn(fake("b"))
    }
    await Bun.sleep(10)
    expect(fake("b").prompts.filter((p) => p.text.includes("status update")).length).toBe(6)
    const lead_ = `${fake("orchestrator")
      .prompts.map((p) => p.text)
      .join("\n")}${rt.agents
      .get(lead.agentId)
      ?.inbox.map((m) => m.body)
      .join("\n")}`
    expect(lead_).toContain("keep messaging each other")
  })

  test("asks resolve (no) when the asking agent exits", async () => {
    const { rt, fake } = setup()
    const w = await rt.spawn({ adapter: "fake", name: "w" })
    const ask = rt.askUser(w.agentId, "more agents?")
    fake("w").emit({ type: "agent.exited", data: { code: 1 } })
    expect(await ask).toBe(false)
  })

  test("run budget stops new work once, until the budget is raised", async () => {
    const { rt, fake } = setup({ budget: { run_usd: 1 } })
    const a = await rt.spawn({ adapter: "fake", name: "a", prompt: "go" })
    const usage = { type: "usage.updated", data: { input: 1, output: 1, costUsd: 2 } } as AgentEvent
    fake("a").emit(usage)
    fake("a").emit(usage)
    const exceeded = rt.store.query({ runId: rt.runId }).filter((e) => e.type === "budget.exceeded")
    expect(exceeded.length).toBe(1)
    endTurn(fake("a"))
    await expect(rt.promptAgent(a.agentId, "more", { from: "orchestrator" })).rejects.toThrow("budget")
    rt.send({ from: "baton", to: "a", body: "queued while stopped" })
    await Bun.sleep(10)
    expect(fake("a").prompts.length).toBe(1)
    rt.applyConfig(BatonConfig.parse({ bus: { heartbeat_s: 0 }, workspace: { isolation: "shared" }, budget: { run_usd: 10 } }))
    await Bun.sleep(10)
    expect(fake("a").prompts.at(-1)?.text).toContain("queued while stopped")
  })

  test("the watchdog leaves agents blocked in baton tools alone", async () => {
    const { rt, fake } = setup({ watchdog: { stall_s: 1 } })
    const w = await rt.spawn({ adapter: "fake", name: "w", prompt: "go" })
    const ac = new AbortController()
    void rt.waitInbox(w.agentId, 60_000, () => false, ac.signal)
    rt.watchdog(Date.now() + 5000)
    expect(rt.agents.get(w.agentId)?.flagged).toBeUndefined()
    ac.abort()
    await Bun.sleep(5)
    rt.watchdog(Date.now() + 5000)
    expect(rt.agents.get(w.agentId)?.flagged).toBe("stalled")
    endTurn(fake("w"))
  })

  test("autonomy switches every live agent, new spawns and waiting approvals", async () => {
    const { rt, fake } = setup()
    await rt.spawn({ adapter: "fake", isOrchestrator: true })
    const w = await rt.spawn({ adapter: "fake", name: "w" })
    expect(fake("w").approvals).toEqual(["ask"])
    fake("w").emit({
      type: "permission.requested",
      data: { requestId: "r1", title: "Bash(rm -rf build)", kind: "execute", options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] },
    })
    await Bun.sleep(5)
    expect(rt.state.approvals.size).toBe(1)
    const r = await rt.setAutonomy("yolo")
    expect(r.live.sort()).toEqual(["orchestrator", "w"])
    expect(fake("w").approvals.at(-1)).toBe("yolo")
    expect(rt.state.autonomy).toBe("yolo")
    expect(rt.state.agents.get(w.agentId)?.approval).toBe("yolo")
    expect(rt.state.approvals.size).toBe(0)
    expect(fake("w").responses).toEqual(["ok"])
    const late = await rt.spawn({ adapter: "fake", name: "late" })
    expect(late.approval).toBe("yolo")
    // back to normal: everyone returns to their own setting
    await rt.setAutonomy("normal")
    expect(fake("w").approvals.at(-1)).toBe("ask")
    expect(fake("orchestrator").approvals.at(-1)).toBe("auto-edit")
  })
})
