import { afterAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonConfig } from "@batonsh/kernel"
import { Runtime } from "./runtime.ts"
import { getScorecards, pickForTask } from "./scores.ts"

const rt = new Runtime({ projectRoot: mkdtempSync(join(tmpdir(), "baton-scores-")), config: BatonConfig.parse({ bus: { heartbeat_s: 0 } }) })
afterAll(() => rt.close())

test("scorecards come from the run's events and update when work lands", () => {
  const spawn = (id: string, adapter: string, label: string) =>
    rt.emit({ type: "agent.spawned", data: { agentId: id, name: id, adapter, label, cwd: "/", approval: "ask" } }, id)
  spawn("w1", "codex", "add tests for auth")
  spawn("w2", "gemini", "add tests for api")
  rt.emit({ type: "workspace.merge", data: { status: "merged", files: ["a.test.ts"] } }, "w1")
  expect(getScorecards(rt).find((r) => r.adapter === "codex" && r.kind === "tests")?.merged).toBe(1)
  rt.emit({ type: "review.verdict", data: { reviewId: "r", author: "w2", reviewer: "w1", verdict: "changes_requested", notes: "x" } })
  rt.emit({ type: "workspace.merge", data: { status: "merged", files: ["b.test.ts"] } }, "w1")
  // the cache is invalidated by merges / reviews
  expect(getScorecards(rt).find((r) => r.adapter === "codex" && r.kind === "tests")?.merged).toBe(2)
  return pickForTask(rt, "write tests for the parser", ["gemini", "codex"]).then((p) => {
    expect(p.kind).toBe("tests")
    expect(p.picks.map((x) => x.adapter)).toEqual(["codex", "gemini"])
  })
})
