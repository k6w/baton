/**
 * Runtime lifecycle + bus edge cases with a scriptable fake adapter: crashes, failed prompts,
 * budget stops, aborted long-polls, batched deliveries.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonConfig } from "@batonsh/kernel"
import type { AdapterContext, AgentAdapter, AgentEvent, AgentSession, BatonEvent, PromptInput } from "@batonsh/protocol"
import { isReadOnlyCommand, Runtime } from "./runtime.ts"

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
      // like codex: an approval asked before start() has returned (the session doesn't exist yet)
      if (cfg.options?.askOnStart) {
        ctx.emit({
          type: "permission.requested",
          data: { requestId: "early-1", title: "Read(README.md)", kind: "read", options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }] },
        })
        await Bun.sleep(5) // the policy's answer is decided meanwhile
      }
      return {
        async prompt(input) {
          if (f.failPrompts) throw new Error("adapter down")
          f.prompts.push(input)
          ctx.emit({ type: "turn.started", data: { turnId: `t${f.prompts.length}`, prompt: input.text } })
        },
        async interrupt() {
          ctx.emit({ type: "turn.interrupted", data: { turnId: `t${f.prompts.length}` } })
        },
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

  test("an agent out of quota is stopped, the lead is told why, and new spawns of it fail fast", async () => {
    const { rt, fake } = setup()
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    endTurn(fake("orchestrator"))
    await rt.spawn({ adapter: "fake", name: "w", parentId: lead.agentId, prompt: "work" })
    fake("w").emit({ type: "agent.status", data: { status: "busy", detail: "retrying (attempt 1): Free usage exceeded, subscribe to Go" } })
    await Bun.sleep(20)
    const told = `${fake("orchestrator")
      .prompts.map((p) => p.text)
      .join("\n")}${rt.agents
      .get(lead.agentId)
      ?.inbox.map((m) => m.body)
      .join("\n")}`
    expect(told).toContain("out of quota: Free usage exceeded")
    expect(told).toContain("different agent")
    await expect(rt.spawn({ adapter: "fake", name: "w2", parentId: lead.agentId })).rejects.toThrow("out of quota")
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

/** The output of an update's first (terminal) content. */
const outputOf = (content?: unknown[]) => (content?.[0] as { output?: string } | undefined)?.output ?? ""

describe("command output", () => {
  const terminal = (id: string, output: string, exitCode?: number) => ({
    type: "terminal" as const,
    terminalId: id,
    command: "npm test",
    output,
    ...(exitCode !== undefined ? { exitCode } : {}),
  })

  test("a running command's output is shown live but stored once, with its result", async () => {
    const { rt, fake } = setup()
    const w = await rt.spawn({ adapter: "fake", name: "w" })
    const f = fake("w")
    const live: string[] = []
    rt.store.subscribe((e) => {
      if (e.type === "tool.update" && e.live) live.push(outputOf(e.data.content))
    })
    f.emit({ type: "tool.call", data: { toolCallId: "c1", kind: "execute", name: "shell", title: "npm test", status: "in_progress" } })
    let out = ""
    for (let i = 0; i < 50; i++) {
      out += `line ${i}\n`
      f.emit({ type: "tool.update", data: { toolCallId: "c1", status: "in_progress", content: [terminal("c1", out)] } })
    }
    // throttled: the first chunk right away, the rest at most every 250ms
    expect(live.length).toBe(1)
    expect(rt.state.feed(w.agentId).index.get("c1")).toMatchObject({ output: "line 0\n" })
    await Bun.sleep(300)
    expect(live.at(-1)).toBe(out)
    expect(rt.state.feed(w.agentId).index.get("c1")).toMatchObject({ output: out })
    // a result without the output keeps the last one shown
    f.emit({ type: "tool.update", data: { toolCallId: "c1", status: "completed", summary: "50 lines" } })
    const stored = rt.store.query({ runId: rt.runId, types: ["tool.update"] }) as BatonEvent<"tool.update">[]
    expect(stored.length).toBe(1)
    expect(stored[0]!.data.status).toBe("completed")
    expect(outputOf(stored[0]!.data.content)).toBe(out)
  })

  test("output of a command that never reported a result is stored when the turn ends", async () => {
    const { rt, fake } = setup()
    await rt.spawn({ adapter: "fake", name: "w", prompt: "go" })
    const f = fake("w")
    f.emit({ type: "tool.call", data: { toolCallId: "c2", kind: "execute", name: "shell", title: "sleep", status: "in_progress" } })
    f.emit({ type: "tool.update", data: { toolCallId: "c2", content: [terminal("c2", "partial")] } })
    expect((rt.store.query({ runId: rt.runId, types: ["tool.update"] }) as BatonEvent<"tool.update">[]).length).toBe(0)
    f.emit({ type: "turn.interrupted", data: { turnId: "t1" } })
    const stored = rt.store.query({ runId: rt.runId, types: ["tool.update"] }) as BatonEvent<"tool.update">[]
    expect(stored.map((e) => outputOf(e.data.content))).toEqual(["partial"])
    expect(rt.agents.get(rt.findAgent("w")!.info.agentId)?.liveOutput.size).toBe(0)
  })
})

describe("command output from every kind of agent", () => {
  const term = (output: string, exitCode?: number | null) => ({ type: "terminal" as const, terminalId: "c", command: "make", output, exitCode })

  test("'still running' as exitCode null (native, ACP) is live output too", async () => {
    const { rt, fake } = setup()
    await rt.spawn({ adapter: "fake", name: "w" })
    const f = fake("w")
    f.emit({ type: "tool.call", data: { toolCallId: "n1", kind: "execute", name: "shell", title: "make", status: "in_progress" } })
    for (let i = 0; i < 20; i++) f.emit({ type: "tool.update", data: { toolCallId: "n1", content: [term("x".repeat(i), null)] } })
    expect(rt.store.query({ runId: rt.runId, types: ["tool.update"] }).length).toBe(0)
  })

  test("a newer stored output wins over an older live one when the result has none", async () => {
    const { rt, fake } = setup()
    await rt.spawn({ adapter: "fake", name: "w" })
    const f = fake("w")
    f.emit({ type: "tool.call", data: { toolCallId: "n2", kind: "execute", name: "shell", title: "make", status: "in_progress" } })
    f.emit({ type: "tool.update", data: { toolCallId: "n2", content: [term("old", null)] } })
    f.emit({ type: "tool.update", data: { toolCallId: "n2", content: [term("final", 0)] } })
    f.emit({ type: "tool.update", data: { toolCallId: "n2", status: "completed" } })
    const stored = rt.store.query({ runId: rt.runId, types: ["tool.update"] }) as BatonEvent<"tool.update">[]
    expect(stored.map((e) => outputOf(e.data.content))).toEqual(["final", "final"])
  })

  test("output after the agent is gone is dropped", async () => {
    const { rt, fake } = setup()
    const w = await rt.spawn({ adapter: "fake", name: "w" })
    const f = fake("w")
    await rt.kill(w.agentId)
    f.emit({ type: "tool.update", data: { toolCallId: "n3", content: [term("late", null)] } })
    expect(rt.agents.get(w.agentId)?.liveOutput.size).toBe(0)
  })
})

describe("one lead", () => {
  test("a task and a resume asking for a lead at the same time get the same one", async () => {
    const { rt } = setup({ orchestrator: { enabled: true, agent: "fake" } })
    const [a, b] = await Promise.all([rt.ensureOrchestrator(), rt.spawnLead({ adapter: "fake", resumeId: "s1" })])
    expect(a.info.agentId).toBe(b.info.agentId)
    expect([...rt.agents.values()].filter((x) => x.info.isOrchestrator && !x.closing).length).toBe(1)
  })
})

/** Everything the lead was told: delivered prompts plus what still waits in its inbox. */
function toldLead(rt: Runtime, fake: (n: string) => Fake): string {
  const lead = rt.orchestrator()!
  return `${fake("orchestrator")
    .prompts.map((p) => p.text)
    .join("\n")}\n${lead.inbox.map((m) => m.body).join("\n")}`
}

describe("user-reported regressions", () => {
  test("a worker blocked on an approval wakes the lead's wait at once, with what it asks, and is re-announced", async () => {
    const { rt, fake } = setup()
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    endTurn(fake("orchestrator"))
    rt.approvalRemindMs = 60
    await rt.spawn({ adapter: "fake", name: "w", parentId: lead.agentId, prompt: "work" })
    // the lead waits for w's result — the approval must end that wait
    const wait = rt.waitInbox(lead.agentId, 5000, (inbox) => inbox.some((m) => m.kind === "result" && m.fromName === "w"))
    const started = Date.now()
    fake("w").emit({
      type: "permission.requested",
      data: {
        requestId: "req-1",
        title: "Bash(rm -rf build)",
        kind: "execute",
        detail: "rm -rf build",
        options: [{ optionId: "ok", name: "Allow", kind: "allow_once" }],
      },
    })
    const msgs = await wait
    expect(Date.now() - started).toBeLessThan(1000)
    const body = msgs.map((m) => m.body).join("\n")
    expect(body).toContain("w is blocked waiting for approval")
    expect(body).toContain("rm -rf build")
    expect(body).toContain("req-1")
    await Bun.sleep(100)
    expect(toldLead(rt, fake)).toContain("STILL blocked")
    // answered: no more reminders
    await rt.resolvePermission(rt.findAgent("w")!.info.agentId, "req-1", "ok")
    const n = rt.state.bus.filter((m) => m.body.includes("req-1")).length
    await Bun.sleep(150)
    expect(rt.state.bus.filter((m) => m.body.includes("req-1")).length).toBe(n)
  })

  test("a review verdict reaches the lead once, together with the reviewer's own result", async () => {
    const { rt, fake } = setup()
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    endTurn(fake("orchestrator"))
    const w = await rt.spawn({ adapter: "fake", name: "w" })
    await rt.collab.prepare(rt.agents.get(w.agentId)!, "shared")
    const rv = await rt.spawn({ adapter: "fake", name: "rv" })
    endTurn(fake("rv"))
    await rt.collab.requestReview(w.agentId, { reviewer: "rv", requester: lead.agentId })
    rt.collab.submitReview(rv.agentId, "approve", "LGTM — tests cover the edge cases")
    endTurn(fake("rv"), "Reviewed w: approved.")
    await Bun.sleep(20)
    // exactly one result: not a "baton" verdict plus the reviewer's own result
    const toLead = rt.state.bus.filter((m) => m.to === lead.agentId && m.kind === "result")
    expect(toLead.length).toBe(1)
    expect(toLead[0]!.from).toBe(rv.agentId)
    expect(toLead[0]!.kind).toBe("result")
    expect(toLead[0]!.body).toContain("Review of w by rv: APPROVED")
  })

  test("a review verdict never drops a fail reason or replaces an empty summary silently", async () => {
    const { rt, fake } = setup()
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    endTurn(fake("orchestrator"))
    const w = await rt.spawn({ adapter: "fake", name: "w" })
    await rt.collab.prepare(rt.agents.get(w.agentId)!, "shared")
    const rv = await rt.spawn({ adapter: "fake", name: "rv" })
    endTurn(fake("rv"))
    await rt.collab.requestReview(w.agentId, { reviewer: "rv", requester: lead.agentId })
    rt.collab.submitReview(rv.agentId, "changes_requested", "the parser drops the last token")
    fake("rv").emit({ type: "agent.status", data: { status: "busy", detail: "retrying (attempt 1): Free usage exceeded, subscribe to Go" } })
    fake("rv").emit({ type: "turn.completed", data: { turnId: "t", stopReason: "end_turn" } })
    await Bun.sleep(20)
    const toLead = rt.state.bus.filter((m) => m.to === lead.agentId && m.kind === "result")
    expect(toLead.length).toBe(1)
    expect(toLead[0]!.body).toContain("Review of w by rv: changes requested")
    expect(toLead[0]!.body).toContain("out of quota")
  })

  test("a message arriving while a worker wraps up waits for its result, then gets its own turn and result", async () => {
    const { rt, fake } = setup({ policy: { preset: "yolo" } })
    const lead = await rt.spawn({ adapter: "fake", isOrchestrator: true })
    endTurn(fake("orchestrator"))
    await rt.spawn({ adapter: "fake", name: "w", parentId: lead.agentId, prompt: "work", acceptance: "sleep 0.3" })
    endTurn(fake("w"), "Fixed the parser; 3 tests added.")
    // the acceptance check is running: a follow-up arrives now
    rt.send({ from: lead.agentId, to: "w", body: "also rename foo to bar" })
    await Bun.sleep(30)
    expect(fake("w").prompts.length).toBe(1) // held until the result is out
    const results = () => rt.state.bus.filter((m) => m.to === lead.agentId && m.kind === "result")
    for (let i = 0; i < 200 && results().length === 0; i++) await Bun.sleep(10)
    expect(results()[0]!.body).toContain("Fixed the parser")
    expect(results()[0]!.body).toContain("acceptance ✓")
    await Bun.sleep(20)
    expect(fake("w").prompts.at(-1)?.text).toContain("rename foo to bar")
    // the follow-up turn says nothing of its own: its result falls back to the last summary
    fake("w").emit({ type: "turn.completed", data: { turnId: "t2", stopReason: "end_turn" } })
    for (let i = 0; i < 200 && results().length < 2; i++) await Bun.sleep(10)
    expect(results().length).toBe(2)
    expect(results()[1]!.body).not.toContain("(no summary)")
    expect(results()[1]!.body).toContain("Fixed the parser")
  })
})

describe("early approvals", () => {
  test("a policy answer to an approval raised during adapter start is delivered once the session exists", async () => {
    const { rt, fake } = setup({ policy: { preset: "yolo" } })
    const w = await rt.spawn({ adapter: "fake", name: "w", options: { askOnStart: true } })
    expect(fake("w").responses).toEqual(["ok"])
    expect(rt.state.approvals.size).toBe(0)
    expect(rt.agents.get(w.agentId)?.earlyAnswers).toBeUndefined()
  })
})

describe("loop detection", () => {
  const call = (f: Fake, id: string, command: string) =>
    f.emit({
      type: "tool.call",
      data: { toolCallId: id, kind: "execute", name: "shell", title: `Run ${command}`, status: "in_progress", rawInput: { command } },
    })
  const done = (f: Fake, id: string, output: string) =>
    f.emit({
      type: "tool.update",
      data: { toolCallId: id, status: "completed", content: [{ type: "terminal", terminalId: id, command: "x", output, exitCode: 0 }] },
    })

  test("navigation / read-only commands never count", async () => {
    const { rt, fake } = setup()
    const w = await rt.spawn({ adapter: "fake", name: "w", prompt: "go" })
    for (let i = 0; i < 6; i++) {
      call(fake("w"), `c${i}`, "cd /repo/packages/daemon && git status")
      done(fake("w"), `c${i}`, "clean")
    }
    expect(rt.agents.get(w.agentId)?.flagged).toBeUndefined()
  })

  test("the same command with the same output, nothing changing, is flagged", async () => {
    const { rt, fake } = setup()
    await rt.spawn({ adapter: "fake", isOrchestrator: true })
    const w = await rt.spawn({ adapter: "fake", name: "w", prompt: "go" })
    for (let i = 0; i < 4; i++) {
      call(fake("w"), `c${i}`, "bun test src/a.test.ts")
      done(fake("w"), `c${i}`, "1 fail")
    }
    expect(rt.agents.get(w.agentId)?.flagged).toBe("looping")
    expect(rt.state.agents.get(w.agentId)?.attention?.detail).toContain("bun test src/a.test.ts")
  })

  test("different output, file edits or a different full command are progress", async () => {
    const { rt, fake } = setup()
    const w = await rt.spawn({ adapter: "fake", name: "w", prompt: "go" })
    const f = fake("w")
    for (let i = 0; i < 5; i++) {
      call(f, `a${i}`, "bun test")
      done(f, `a${i}`, `${5 - i} fail`)
    }
    for (let i = 0; i < 5; i++) {
      call(f, `b${i}`, "bun test")
      done(f, `b${i}`, "1 fail")
      f.emit({ type: "tool.update", data: { toolCallId: `e${i}`, status: "completed", content: [{ type: "diff", path: "a.ts", newText: `v${i}` }] } })
    }
    for (let i = 0; i < 5; i++) {
      call(f, `d${i}`, `cd pkg && bun test file${i}.test.ts`)
      done(f, `d${i}`, "ok")
    }
    expect(rt.agents.get(w.agentId)?.flagged).toBeUndefined()
  })

  test("new output after a loop flag clears it", async () => {
    const { rt, fake } = setup()
    const w = await rt.spawn({ adapter: "fake", name: "w", prompt: "go" })
    for (let i = 0; i < 4; i++) {
      call(fake("w"), `c${i}`, "bun test")
      done(fake("w"), `c${i}`, "1 fail")
    }
    expect(rt.agents.get(w.agentId)?.flagged).toBe("looping")
    expect(rt.state.agents.get(w.agentId)?.attention?.reason).toBe("looping")
    call(fake("w"), "c4", "bun test")
    done(fake("w"), "c4", "0 fail")
    expect(rt.agents.get(w.agentId)?.flagged).toBeUndefined()
    expect(rt.state.agents.get(w.agentId)?.attention).toBeUndefined()
  })

  test("read-only command classification", () => {
    expect(isReadOnlyCommand("cd foo")).toBe(true)
    expect(isReadOnlyCommand("cd foo && ls -la | head")).toBe(true)
    expect(isReadOnlyCommand("bash -lc 'git diff --stat; rg TODO src'")).toBe(true)
    expect(isReadOnlyCommand("sed -n 1,20p a.ts")).toBe(true)
    expect(isReadOnlyCommand("cd foo && bun test")).toBe(false)
    expect(isReadOnlyCommand("git commit -m x")).toBe(false)
    expect(isReadOnlyCommand("sed -i s/a/b/ a.ts")).toBe(false)
  })
})
