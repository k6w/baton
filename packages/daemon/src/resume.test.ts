import { describe, expect, test } from "bun:test"
import { EventStore } from "@batonsh/kernel"
import type { AgentEvent } from "@batonsh/protocol"
import { resumableAgents } from "./history.ts"

/** A run's lifecycle events, with timestamps we choose. */
function run(build: (add: (ev: AgentEvent, agentId?: string, ts?: number) => void) => void) {
  const s = new EventStore()
  const id = s.createRun("/tmp")
  const out: ReturnType<EventStore["append"]>[] = []
  build((ev, agentId, ts) => {
    const e = s.append(id, ev, { agentId })
    out.push(ts === undefined ? e : { ...e, ts })
  })
  return out
}
const spawn = (agentId: string, name: string, extra: Record<string, unknown> = {}): AgentEvent => ({
  type: "agent.spawned",
  data: { agentId, name, adapter: "claude", cwd: "/tmp", ...extra },
})
const exited = (reason: string): AgentEvent => ({ type: "agent.exited", data: { code: 0, reason } })
const names = (events: ReturnType<typeof run>) => resumableAgents(events).map((r) => r.agent.info.name)

describe("resume brings back what was running", () => {
  test("agents killed before the run ended stay gone; run.ended lists the rest", () => {
    const events = run((add) => {
      add(spawn("o", "orchestrator", { isOrchestrator: true }), "o")
      add(spawn("a", "claude-1"), "a")
      add(spawn("b", "claude-2"), "b")
      add(spawn("c", "codex-1"), "c")
      add(exited("killed"), "b")
      add(exited("closed"), "a")
      add(exited("closed"), "c")
      add(exited("closed"), "o")
      add({ type: "run.ended", data: { reason: "shutdown", agents: ["o", "a", "c"] } })
    })
    expect(names(events)).toEqual(["orchestrator", "claude-1", "codex-1"])
  })

  test("older runs (no list in run.ended): exits just before the end were the shutdown", () => {
    const events = run((add) => {
      add(spawn("a", "claude-1"), "a", 0)
      add(spawn("b", "claude-2"), "b", 0)
      add(exited("killed"), "b", 60_000)
      add(exited("closed"), "a", 299_000)
      add({ type: "run.ended", data: { reason: "shutdown" } }, undefined, 300_000)
    })
    expect(names(events)).toEqual(["claude-1"])
  })

  test("a daemon that died (no run.ended): agents that hadn't exited", () => {
    const events = run((add) => {
      add(spawn("a", "claude-1"), "a")
      add(spawn("b", "claude-2"), "b")
      add(exited("killed"), "b")
    })
    expect(names(events)).toEqual(["claude-1"])
  })

  test("an agent spawned again under the same name comes back once, as its latest self, with renames and sessions", () => {
    const events = run((add) => {
      add(spawn("a1", "claude-1", { model: "sonnet" }), "a1")
      add(spawn("a2", "claude-1", { model: "opus" }), "a2")
      add({ type: "agent.session", data: { sessionId: "s-2" } }, "a2")
      add(spawn("b", "claude-2"), "b")
      add({ type: "agent.updated", data: { name: "reviewer", label: "review it" } }, "b")
    })
    const r = resumableAgents(events)
    expect(r.map((x) => [x.oldId, x.agent.info.name, x.agent.info.model ?? "", x.agent.session ?? ""])).toEqual([
      ["a2", "claude-1", "opus", "s-2"],
      ["b", "reviewer", "", ""],
    ])
    expect(r[1]!.agent.info.label).toBe("review it")
  })

  test("a removed worktree isn't adopted again", () => {
    const events = run((add) => {
      add(spawn("a", "claude-1"), "a")
      add({ type: "workspace.created", data: { path: "/tmp/wt", mode: "worktree", branch: "baton/x" } }, "a")
      add({ type: "workspace.removed", data: { kept: false } }, "a")
    })
    expect(resumableAgents(events)[0]!.agent.workspace).toBeUndefined()
  })
})
