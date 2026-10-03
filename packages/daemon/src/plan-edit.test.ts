import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonClient } from "@batonsh/sdk"
import { type Daemon, startDaemon } from "./daemon.ts"

let d: Daemon
let c: BatonClient
beforeAll(async () => {
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-plan-"))
  d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "p.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 } },
  })
  c = await BatonClient.open(d.socketPath, "test")
})
afterAll(async () => {
  c.close()
  await d.stop()
})

test("the user can reorder, reassign, detail and extend the plan", async () => {
  await d.runtime.collab.plan([
    { id: "fix", title: "Fix the bug" },
    { id: "test", title: "Add a test", deps: ["fix"] },
  ])
  const { taskId } = await c.call("task.add", { title: "Update the changelog", agent: "claude" })
  expect(taskId).toBe("t3")
  await c.call("task.edit", { taskId: "t3", move: "up" })
  await c.call("task.edit", { taskId: "t3", move: "up" })
  await c.call("task.edit", { taskId: "fix", acceptance: "bun test passes", agent: "codex", deps: [] })
  await c.call("task.edit", { taskId: "test", description: "cover the empty input case" })
  const order = d.runtime.state.orderedTasks().map((t) => t.taskId)
  expect(order).toEqual(["t3", "fix", "test"])
  const fix = d.runtime.state.tasks.get("fix")!
  expect(fix.acceptance).toBe("bun test passes")
  expect(fix.agent).toBe("codex")
  expect(d.runtime.state.tasks.get("t3")!.agent).toBe("claude")
  expect(d.runtime.state.tasks.get("test")!.note).toBe("cover the empty input case")
  // moving past the top is a no-op
  await c.call("task.edit", { taskId: "t3", move: "up" })
  expect(d.runtime.state.orderedTasks()[0]!.taskId).toBe("t3")
})
