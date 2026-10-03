import { describe, expect, test } from "bun:test"
import { BatonConfig, EventStore, noticeFor, RunState, shouldNotify } from "./index.ts"

describe("notifications", () => {
  test("approvals, lead completion only when everyone is idle, fatal errors, merges", () => {
    const s = new EventStore()
    const run = s.createRun("/p")
    const st = new RunState()
    s.subscribe((e) => st.apply(e))
    s.append(run, { type: "agent.spawned", data: { agentId: "L", name: "orchestrator", adapter: "claude", cwd: "/p", isOrchestrator: true } }, { agentId: "L" })
    s.append(run, { type: "agent.spawned", data: { agentId: "W", name: "codex-1", adapter: "codex", cwd: "/p" } }, { agentId: "W" })
    const perm = s.append(run, { type: "permission.requested", data: { requestId: "r", title: "Bash(rm -rf x)", options: [] } }, { agentId: "W" })
    expect(noticeFor(perm, st)).toMatchObject({ kind: "approval", body: "codex-1: Bash(rm -rf x)" })
    s.append(run, { type: "agent.status", data: { status: "busy" } }, { agentId: "W" })
    const done1 = s.append(run, { type: "turn.completed", data: { turnId: "t" } }, { agentId: "L" })
    expect(noticeFor(done1, st)).toBeUndefined() // a worker is still busy
    s.append(run, { type: "agent.status", data: { status: "ready" } }, { agentId: "W" })
    const done2 = s.append(run, { type: "turn.completed", data: { turnId: "t2" } }, { agentId: "L" })
    expect(noticeFor(done2, st)?.kind).toBe("done")
    const err = s.append(run, { type: "error", data: { message: "boom", fatal: true } }, { agentId: "W" })
    expect(noticeFor(err, st)?.kind).toBe("error")
    expect(noticeFor(s.append(run, { type: "error", data: { message: "meh" } }, { agentId: "W" }), st)).toBeUndefined()
  })

  test("settings decide desktop / bell / focus", () => {
    const cfg = BatonConfig.parse({}).notify
    const n = { kind: "approval" as const, title: "t", body: "b" }
    expect(shouldNotify(n, cfg, false)).toEqual({ desktop: true, bell: false, sound: false })
    expect(shouldNotify(n, cfg, true)).toEqual({ desktop: false, bell: false, sound: false })
    expect(shouldNotify(n, { ...cfg, when_focused: true, bell: true }, true)).toEqual({ desktop: true, bell: true, sound: false })
    expect(shouldNotify({ ...n, kind: "merge" }, cfg, false)).toEqual({ desktop: false, bell: false, sound: false })
    // sounds play even while focused on Baton; focus mode lets only approvals and errors through
    expect(shouldNotify(n, { ...cfg, sound: "system" }, true).sound).toBe(true)
    expect(shouldNotify({ ...n, kind: "done" }, cfg, false, true)).toEqual({ desktop: false, bell: false, sound: false })
    expect(shouldNotify({ ...n, kind: "approval" }, cfg, false, true).desktop).toBe(true)
  })
})
