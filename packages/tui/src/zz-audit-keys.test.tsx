import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Daemon, startDaemon } from "@batonsh/daemon"
import type { loadConfig } from "@batonsh/kernel"
import { BatonClient, type LiveRun } from "@batonsh/sdk"
import { loadTheme } from "@batonsh/themes"
import { testRender } from "@opentui/solid"
import { App } from "./App.tsx"
import { UiContext } from "./context.ts"
import { createUiState } from "./state.ts"

let daemon: Daemon
let client: BatonClient
let live: LiveRun
const root = mkdtempSync(join(tmpdir(), "baton-tui-audit-"))

async function until(pred: () => boolean, ms = 8000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout")
    await Bun.sleep(20)
  }
}

beforeAll(async () => {
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  daemon = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "t.sock"),
    demo: { workers: 5, speed: 0.05 },
    overrides: { project: { name: "portfolio" }, bus: { heartbeat_s: 1 } },
  })
  client = await BatonClient.open(daemon.socketPath, "test")
  live = await client.live()
  await client.submit("fix the typo in the README with 5 codex agents")
  await until(() => live.state.workers().length === 5 && live.state.totals.toolCalls > 8)
})

afterAll(async () => {
  await live?.stop()
  client?.close()
  await daemon?.stop()
})

async function mount(width: number, height: number, prefs: Record<string, unknown> = {}) {
  const remote = (await client.call("config.get", {})).config as ReturnType<typeof loadConfig>["config"]
  const config = { ...remote, ui: { ...remote.ui, fps: 120, ...prefs } } as typeof remote
  const ui = createUiState({ client, run: live.state, config, theme: loadTheme(config.ui.theme, { appearance: "dark" }), persist: false })
  const off = live.onEvent(() => ui.bump())
  const t = await testRender(
    () => (
      <UiContext.Provider value={ui}>
        <App onExit={() => {}} />
      </UiContext.Provider>
    ),
    { width, height },
  )
  return {
    t,
    ui,
    async frame() {
      await Bun.sleep(30)
      await t.renderOnce()
      return t.captureCharFrame()
    },
    dispose() {
      off()
      ui.dispose()
      t.renderer.destroy()
    },
  }
}

describe("audit", () => {
  test("q closing Changes leaks into orchestrator input", async () => {
    const m = await mount(140, 44)
    await m.frame()
    await m.t.mockInput.typeText("hello")
    await m.frame()
    m.t.mockInput.pressKey("d", { ctrl: true })
    await m.frame()
    expect(m.ui.overlay()).toBe("changes")
    m.t.mockInput.pressKey("q")
    await m.frame()
    console.log("AFTER q close changes input=", JSON.stringify(m.ui.input()), "overlay=", m.ui.overlay())
    m.dispose()
  })

  test("r in History / q in Costs leak", async () => {
    const m = await mount(140, 44)
    await m.frame()
    m.t.mockInput.pressKey("e", { ctrl: true })
    await m.frame()
    expect(m.ui.overlay()).toBe("costs")
    m.t.mockInput.pressKey("q")
    await m.frame()
    console.log("AFTER q close costs input=", JSON.stringify(m.ui.input()))
    m.dispose()
  })

  test("enter in theme picker submits draft", async () => {
    const m = await mount(140, 44)
    await m.frame()
    await m.t.mockInput.typeText("@codex-1 draftmsg")
    await m.frame()
    m.t.mockInput.pressKey("t", { ctrl: true })
    await m.frame()
    expect(m.ui.overlay()).toBe("theme")
    m.t.mockInput.pressEnter()
    await m.frame()
    await Bun.sleep(300)
    console.log("AFTER theme enter input=", JSON.stringify(m.ui.input()), "sent=", live.state.bus.some((b) => b.from === "user" && b.body === "draftmsg"))
    m.dispose()
  })

  test("swarm slim not reactive", async () => {
    const m = await mount(140, 44, { layout: "grid" })
    let f = await m.frame()
    m.ui.setPrefs("layout", "swarm")
    f = await m.frame()
    console.log("SWARM after switch:\n", f.split("\n").slice(0, 6).join("\n"))
    m.dispose()
    const m2 = await mount(140, 44, { layout: "swarm" })
    f = await m2.frame()
    m2.ui.setPrefs("layout", "grid")
    f = await m2.frame()
    console.log("GRID after switch from swarm:\n", f.split("\n").slice(0, 16).join("\n"))
    m2.dispose()
  })

  test("focus layout: typing reaches the input", async () => {
    const m = await mount(140, 44, { layout: "focus" })
    await m.frame()
    await m.t.mockInput.typeText("abc")
    await m.frame()
    console.log("FOCUS layout input=", JSON.stringify(m.ui.input()))
    // open + close an overlay
    m.t.mockInput.pressKey("e", { ctrl: true })
    await m.frame()
    m.t.mockInput.pressEscape()
    await m.frame()
    await m.t.mockInput.typeText("def")
    await m.frame()
    console.log("FOCUS layout after overlay input=", JSON.stringify(m.ui.input()))
    m.dispose()
  })

  test("settings: enter on a string setting opens and immediately commits", async () => {
    const m = await mount(140, 44)
    await m.frame()
    m.ui.setOverlay("settings")
    await m.frame()
    m.t.mockInput.pressArrow("left") // sections pane
    await m.frame()
    m.t.mockInput.pressArrow("down") // Orchestrator
    await m.frame()
    m.t.mockInput.pressEnter()
    await m.frame()
    m.t.mockInput.pressArrow("down") // orchestrator.model
    let f = await m.frame()
    console.log("SETTINGS before enter:\n", f)
    m.t.mockInput.pressEnter()
    await Bun.sleep(50)
    f = await m.frame()
    console.log("SETTINGS editing visible=", f.includes("enter save · empty = unset"))
    console.log(f.split("\n").filter((l) => /model|Model/.test(l)).join("\n"))
    m.t.mockInput.pressEscape()
    await m.frame()
    m.t.mockInput.pressEscape()
    m.dispose()
  })

  test("page down unbounded", async () => {
    const m = await mount(140, 44)
    await m.frame()
    m.ui.setFocus({ kind: "agent", agentId: live.state.workers()[0]!.agentId })
    for (let i = 0; i < 5; i++) m.t.mockInput.pressKey("\x1b[6~")
    await m.frame()
    console.log("page after 5 pgdn=", m.ui.page())
    m.t.mockInput.pressKey("\x1b[5~")
    const f = await m.frame()
    console.log("page after 1 pgup=", m.ui.page(), f.match(/page \d+\/\d+/)?.[0])
    m.dispose()
  })

  test("small sizes", { timeout: 120000 }, async () => {
    for (const [w, h] of [
      [30, 8],
      [20, 6],
      [12, 5],
      [6, 4],
    ] as const) {
      for (const layout of ["grid", "list", "focus", "swarm", "wide"]) {
        try {
          const m = await mount(w, h, { layout })
          await m.frame()
          for (const ov of ["settings", "peek", "help", "palette", "inbox", "changes", "costs", "tasks"] as const) {
            try {
              if (ov === "peek") m.ui.setPeekAgent(live.state.workers()[0]!.agentId)
              m.ui.setOverlay(ov)
              await m.frame()
              m.ui.setOverlay(null)
              await m.frame()
            } catch (e) {
              console.log(`CRASH overlay ${ov} at ${w}x${h} ${layout}:`, (e as Error).message)
              m.ui.setOverlay(null)
            }
          }
          m.dispose()
        } catch (e) {
          console.log(`CRASH ${w}x${h} ${layout}:`, (e as Error).message)
        }
      }
    }
  })
})
