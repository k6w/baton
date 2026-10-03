import { afterAll, expect, setDefaultTimeout, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Daemon, startDaemon } from "./daemon.ts"
import { handleInput } from "./input.ts"

setDefaultTimeout(30_000)
let d: Daemon
afterAll(() => d?.stop())

test("a delegating mock lead runs a whole offline team: spawns workers, waits, reports", async () => {
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-delegate-"))
  d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "m.sock"),
    overrides: {
      orchestrator: { agent: "lead" },
      agents: { lead: { adapter: "mock", options: { delegate: true, speed: 0 } } },
      bus: { heartbeat_s: 0 },
      workspace: { isolation: "shared" },
      policy: { preset: "yolo" },
    },
  })
  await handleInput(d.runtime, "tidy the readme")
  const lead = () => d.runtime.state.orchestratorId!
  const end = Date.now() + 25_000
  const said = () =>
    d.runtime.state
      .feed(lead())
      .items.filter((i) => i.kind === "message" && i.role === "assistant")
      .map((i) => (i.kind === "message" ? i.text : ""))
      .join("\n")
  while (!said().includes("reported back") && Date.now() < end) await Bun.sleep(50)
  expect(said()).toContain("Done — 2 workers reported back")
  expect(d.runtime.state.workers().length).toBe(2)
})
