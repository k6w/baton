import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Daemon, startDaemon } from "@batonsh/daemon"
import type { BatonEvent } from "@batonsh/protocol"
import { loadTheme } from "@batonsh/themes"
import { testRender } from "@opentui/solid"
import { App } from "./App.tsx"
import { UiContext } from "./context.ts"
import { Replay, replayState } from "./replay.ts"
import { createUiState } from "./state.ts"

let d: Daemon
let events: BatonEvent[]
beforeAll(async () => {
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-replay-"))
  d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "r.sock"),
    demo: { workers: 3, speed: 0.05 },
    overrides: { project: { name: "demo" } },
  })
  const { handleInput } = await import("@batonsh/daemon")
  await handleInput(d.runtime, "fix the typo in the README")
  await Bun.sleep(2000)
  events = d.runtime.store.query({ runId: d.runtime.runId })
})
afterAll(() => d.stop())

test("replay: seek forward and back rebuilds the state; markers point at what matters", () => {
  const r = new Replay(events, replayState(events), "demo")
  expect(r.markers.some((m) => m.kind === "spawn")).toBe(true)
  r.seek(events.length)
  const agents = r.state.agents.size
  expect(agents).toBe(d.runtime.state.agents.size)
  r.seek(1)
  expect(r.state.agents.size).toBe(0)
  r.seekMarker(1)
  expect(r.state.agents.size).toBe(1) // stopped right after the first spawn
  r.seekTime(60_000)
  expect(r.state.agents.size).toBe(agents)
  r.dispose()
})

test("replay: the app plays a past run read-only with a timeline", async () => {
  const replay = new Replay(events, replayState(events), "fix the typo in the README")
  const config = d.runtime.config
  const ui = createUiState({ run: replay.state, config: { ...config, ui: { ...config.ui, fps: 120 } }, theme: loadTheme("baton"), persist: false, replay })
  let exited = false
  const t = await testRender(
    () => (
      <UiContext.Provider value={ui}>
        <App onExit={() => (exited = true)} />
      </UiContext.Provider>
    ),
    { width: 120, height: 36 },
  )
  replay.seek(events.length)
  await Bun.sleep(40)
  await t.renderOnce()
  const f = t.captureCharFrame()
  expect(f).toContain("REPLAY 4×")
  expect(f).toContain("fix the typo in the README")
  expect(f).toContain("replay — read only")
  t.mockInput.pressKey(" ")
  await Bun.sleep(20)
  expect(replay.playing).toBe(true)
  t.mockInput.pressKey("-")
  expect(replay.speed).toBe(2)
  t.mockInput.pressEscape()
  await Bun.sleep(20)
  expect(exited).toBe(true)
  replay.dispose()
  ui.dispose()
  t.renderer.destroy()
})
