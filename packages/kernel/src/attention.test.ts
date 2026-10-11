import { expect, test } from "bun:test"
import { attentionItems, EventStore, RunState, urgentCount } from "./index.ts"

test("attention queue: ordering and sources", () => {
  const s = new EventStore()
  const run = s.createRun("/p")
  const st = new RunState()
  s.subscribe((e) => st.apply(e))
  const spawn = (id: string, name: string) =>
    s.append(run, { type: "agent.spawned", data: { agentId: id, name, adapter: "codex", cwd: "/p" } }, { agentId: id })
  spawn("a", "codex-1")
  spawn("b", "codex-2")
  spawn("c", "codex-3")
  s.append(run, { type: "workspace.created", data: { path: "/wt/b", mode: "worktree", branch: "x" } }, { agentId: "b" })
  s.append(run, { type: "workspace.changed", data: { files: [{ path: "a.ts", added: 1, removed: 0 }], added: 1, removed: 0 } }, { agentId: "b" })
  s.append(run, { type: "agent.status", data: { status: "ready" } }, { agentId: "b" })
  s.append(run, { type: "agent.status", data: { status: "busy" } }, { agentId: "c" })
  s.append(run, { type: "agent.attention", data: { reason: "stalled", detail: "no activity for 6m" } }, { agentId: "c" })
  s.append(run, { type: "permission.requested", data: { requestId: "r1", title: "Bash(rm -rf dist)", options: [] } }, { agentId: "a" })
  const items = attentionItems(st)
  expect(items.map((i) => i.kind)).toEqual(["approval", "stalled", "ready"])
  expect(items[0]!.title).toBe("codex-1: Bash(rm -rf dist)")
  expect(urgentCount(items)).toBe(2)
  // activity clears the stall flag
  s.append(run, { type: "tool.call", data: { toolCallId: "t", kind: "read", name: "Read", title: "Read(x)" } }, { agentId: "c" })
  expect(attentionItems(st).map((i) => i.kind)).toEqual(["approval", "ready"])
})
