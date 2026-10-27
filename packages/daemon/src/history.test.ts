import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonClient } from "@batonsh/sdk"
import { startDaemon } from "./daemon.ts"

test("history: runs persist across daemon restarts, export to markdown, resume restarts the agents", async () => {
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-hist-"))
  const opts = { projectRoot: root, socketPath: join(root, "s.sock"), overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 } } }
  // run 1
  let d = await startDaemon(opts)
  const firstRun = d.runtime.runId
  const w = await d.runtime.spawn({ adapter: "mock", name: "historian", label: "remember", options: { speed: 0 } })
  await d.runtime.promptAgent(w.agentId, "pong")
  for (let i = 0; i < 100 && !d.runtime.state.feed(w.agentId).items.some((x) => x.kind === "message" && x.text === "PONG"); i++) await Bun.sleep(10)
  // killed before the run ended: a resume leaves it out
  const gone = await d.runtime.spawn({ adapter: "mock", name: "quitter", options: { speed: 0 } })
  await d.runtime.kill(gone.agentId)
  await d.stop()
  // run 2
  d = await startDaemon(opts)
  const c = await BatonClient.open(d.socketPath)
  const { runs } = await c.call("runs.list", {})
  expect(runs.length).toBe(2)
  const past = runs.find((r) => r.runId === firstRun)!
  expect(past.current).toBe(false)
  expect(past.title).toBe("pong")
  expect(past.agents).toBe(2)
  expect(runs.find((r) => r.current)?.runId).toBe(d.runtime.runId)
  const md = (await c.call("run.export", { runId: firstRun, format: "md" })).text
  expect(md).toContain("# pong")
  expect(md).toContain("**historian:** PONG")
  const html = (await c.call("run.export", { runId: firstRun, format: "html" })).text
  expect(html).toStartWith("<!doctype html>")
  expect(html).toContain("<h1>pong</h1>")
  expect(html).toContain("PONG")
  expect(html).not.toContain("<script")
  const jsonl = (await c.call("run.export", { runId: firstRun, format: "jsonl" })).text
  expect(jsonl.trim().split("\n").length).toBeGreaterThan(5)
  const res = await c.call("run.resume", { runId: firstRun })
  expect(res.agents).toEqual(["historian"])
  expect(d.runtime.findAgent("historian")?.info.label).toBe("remember")
  // the resumed card shows the earlier conversation, above a marker
  const h = d.runtime.findAgent("historian")!
  const feed = d.runtime.state.feed(h.info.agentId).items
  expect(feed.some((x) => x.kind === "user" && x.text === "pong")).toBe(true)
  expect(feed.some((x) => x.kind === "message" && x.text === "PONG")).toBe(true)
  expect(feed.some((x) => x.kind === "note" && x.text.includes("earlier"))).toBe(true)
  c.close()
  await d.stop()
})
