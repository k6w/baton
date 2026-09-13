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
const root = mkdtempSync(join(tmpdir(), "baton-tui-"))

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
  let exited = false
  const t = await testRender(
    () => (
      <UiContext.Provider value={ui}>
        <App
          onExit={() => {
            exited = true
          }}
        />
      </UiContext.Provider>
    ),
    { width, height },
  )
  return {
    t,
    ui,
    exited: () => exited,
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

describe("TUI", () => {
  test("empty state shows the orchestrator pane and hints", async () => {
    const m = await mount(100, 24)
    const f = await m.frame()
    expect(f).toContain("orchestrator")
    expect(f).toContain("mock")
    expect(f).toContain("/agents")
    expect(f).toContain("portfolio")
    m.dispose()
  })

  test("demo run: grid of agent cards, bus pane, status bar", async () => {
    await client.submit("fix the typo in the README with 5 codex agents")
    await until(() => live.state.workers().length === 5 && live.state.totals.toolCalls > 8)
    const m = await mount(140, 44)
    const f = await m.frame()
    if (process.env.BATON_PRINT) console.log(f)
    for (let i = 1; i <= 5; i++) expect(f).toContain(`codex-${i}`)
    expect(f).toContain(">_")
    expect(f).toContain("bus")
    expect(f).toContain("a2a")
    expect(f).toMatch(/\d+\/5 codex running/)
    expect(f).toContain("find typo")
    expect(f).toContain("╭─")
    m.dispose()
  })

  test("compact sizes don't crash and page the grid", async () => {
    const m = await mount(60, 20)
    const f = await m.frame()
    expect(f).toContain("orchestrator")
    expect(f).toMatch(/page \d\/\d|codex-1/)
    m.dispose()
  })

  test("every layout renders", async () => {
    for (const layout of ["grid", "focus", "swarm", "wide"]) {
      const m = await mount(150, 40, { layout })
      const f = await m.frame()
      if (process.env.BATON_PRINT) console.log(`--- ${layout}\n${f}`)
      if (layout === "swarm") expect(f).toContain("fix the typo in the README")
      expect(f.length).toBeGreaterThan(100)
      expect(f).toContain("codex")
      m.dispose()
    }
  })

  test("themes and border styles render", async () => {
    for (const theme of ["catppuccin-mocha", "gruvbox-light", "mono"]) {
      for (const border of ["single", "ascii", "none"]) {
        const m = await mount(120, 36, { theme, border })
        const f = await m.frame()
        expect(f).toContain("codex-1")
        if (border === "ascii") expect(f).toContain("+-")
        m.dispose()
      }
    }
  })

  test("keyboard: palette, focus cycling, zoom, help", async () => {
    const m = await mount(140, 44)
    await m.frame()
    m.t.mockInput.pressKey("p", { ctrl: true })
    let f = await m.frame()
    expect(f).toContain("Commands")
    m.t.mockInput.pressEscape()
    f = await m.frame()
    expect(f).not.toContain("type to search commands")
    m.t.mockInput.pressTab()
    await m.frame()
    expect(m.ui.focus().kind).toBe("agent")
    m.t.mockInput.pressKey("z")
    f = await m.frame()
    expect(m.ui.zoomed()).not.toBeNull()
    expect(f).toContain("esc to close")
    m.t.mockInput.pressEscape()
    await m.frame()
    expect(m.ui.zoomed()).toBeNull()
    m.t.mockInput.pressKey("?")
    f = await m.frame()
    expect(f).toContain("Keyboard shortcuts")
    m.t.mockInput.pressEscape()
    m.dispose()
  })

  test("typing @mention shows completions and submits to the agent", async () => {
    if (live.state.workers().length === 0) {
      await client.submit("start 5 codex agents")
      await until(() => live.state.workers().length === 5)
    }
    const m = await mount(140, 44)
    await m.frame()
    await m.t.mockInput.typeText("@codex-")
    let f = await m.frame()
    expect(f).toContain("@codex-1")
    m.t.mockInput.pressTab()
    await m.frame()
    await m.t.mockInput.typeText("pong")
    if (process.env.BATON_PRINT) console.log("INPUT=", JSON.stringify(m.ui.input()), "\n", (await m.frame()).split("\n").slice(0, 16).join("\n"))
    m.t.mockInput.pressEnter()
    await m.frame()
    if (process.env.BATON_PRINT)
      console.log(
        "AFTER INPUT=",
        JSON.stringify(m.ui.input()),
        live.state.bus.filter((b) => b.from === "user"),
      )
    await until(() => live.state.bus.some((b) => b.from === "user" && b.body === "pong"))
    f = await m.frame()
    expect(f).toContain("codex")
    m.dispose()
  })
})
