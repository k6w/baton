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
    for (const layout of ["grid", "list", "focus", "swarm", "wide"]) {
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

  test("approvals inbox: ctrl+a lists requests, `a` approves through the daemon", async () => {
    const g = await client.spawn({ adapter: "mock", name: "gatekeeper", approval: "ask", options: { speed: 0, steps: ["exec"] } })
    await client.prompt(g.agentId, "do the risky thing")
    await until(() => [...live.state.approvals.values()].some((p) => p.agentId === g.agentId), 10000)
    const m = await mount(140, 44)
    await m.frame()
    m.t.mockInput.pressKey("a", { ctrl: true })
    let f = await m.frame()
    expect(f).toContain("Inbox (")
    expect(f).toContain("needs you")
    expect(f).toContain("gatekeeper")
    const before = [...live.state.approvals.values()].length
    // select the gatekeeper's request and approve it
    const idx = [...live.state.approvals.values()].sort((a, b) => a.ts - b.ts).findIndex((p) => p.agentId === g.agentId)
    for (let i = 0; i < idx; i++) m.t.mockInput.pressArrow("down")
    m.t.mockInput.pressKey("a")
    await until(() => [...live.state.approvals.values()].length < before)
    f = await m.frame()
    m.t.mockInput.pressEscape()
    m.dispose()
  })

  test("inbox: with several agents waiting, the selected request is the one approved", async () => {
    // earlier tests leave requests waiting: start from an empty inbox
    await client.submit("/deny all")
    await until(() => live.state.approvals.size === 0)
    for (const n of ["r-one", "r-two", "r-three"]) {
      const g = await client.spawn({ adapter: "mock", name: n, approval: "ask", options: { speed: 0, steps: ["exec"] } })
      await client.prompt(g.agentId, "risky")
      await until(() => [...live.state.approvals.values()].some((p) => p.agentId === g.agentId), 10000)
    }
    const waiting = () => [...live.state.approvals.values()].map((p) => live.state.agents.get(p.agentId)?.name)
    const m = await mount(140, 44)
    await m.frame()
    m.t.mockInput.pressKey("a", { ctrl: true })
    await m.frame()
    const order = (await m.frame()).split("\n").flatMap((l) => /(r-one|r-two|r-three):/.exec(l)?.[1] ?? [])
    m.t.mockInput.pressArrow("down")
    await m.frame()
    m.t.mockInput.pressKey("a")
    await until(() => !waiting().includes(order[1]))
    expect(waiting()).toContain(order[0])
    expect(waiting()).toContain(order[2])
    m.t.mockInput.pressEscape()
    m.dispose()
  }, 30000)

  test("theme picker previews live and reverts on escape", async () => {
    const m = await mount(120, 40)
    await m.frame()
    const original = m.ui.theme().name
    m.t.mockInput.pressKey("t", { ctrl: true })
    let f = await m.frame()
    expect(f).toContain("Theme")
    m.t.mockInput.pressArrow("down")
    await m.frame()
    expect(m.ui.theme().name).not.toBe(original)
    m.t.mockInput.pressEscape()
    f = await m.frame()
    expect(m.ui.theme().name).toBe(original)
    expect(f).not.toContain("enter keep")
    m.dispose()
  })

  test("attention: ctrl+n jumps, space peeks, answering from the peek resolves the request, reply goes to the agent", async () => {
    const g = await client.spawn({ adapter: "mock", name: "peeky", approval: "ask", options: { speed: 0, steps: ["exec"] } })
    await client.prompt(g.agentId, "risky")
    await until(() => [...live.state.approvals.values()].some((p) => p.agentId === g.agentId), 10000)
    const m = await mount(140, 44)
    await m.frame()
    m.t.mockInput.pressKey("n", { ctrl: true })
    let f = await m.frame()
    expect(m.ui.overlay()).toBe("inbox") // approvals are answered in the inbox
    m.t.mockInput.pressEscape()
    await m.frame()
    // focus the agent and peek
    m.ui.setFocus({ kind: "agent", agentId: g.agentId })
    await m.frame()
    m.t.mockInput.pressKey(" ")
    f = await m.frame()
    expect(m.ui.overlay()).toBe("peek")
    expect(f).toContain("a allow · A always")
    m.t.mockInput.pressKey("a")
    await until(() => ![...live.state.approvals.values()].some((p) => p.agentId === g.agentId))
    // reply
    m.t.mockInput.pressKey("r")
    await m.frame()
    await m.t.mockInput.typeText("pong")
    m.t.mockInput.pressEnter()
    await until(() => live.state.bus.some((b) => b.from === "user" && b.to === g.agentId && b.body === "pong"))
    m.t.mockInput.pressEscape()
    m.dispose()
  })

  test("m on a focused card prefills '@name ' in the input (without typing the m)", async () => {
    const m = await mount(140, 44)
    await m.frame()
    const w = live.state.workers()[0]!
    m.ui.setFocus({ kind: "agent", agentId: w.agentId })
    await m.frame()
    m.t.mockInput.pressKey("m")
    await Bun.sleep(30)
    const f = await m.frame()
    expect(m.ui.focus().kind).toBe("input")
    expect(f).toContain(`❯ @${w.name} `)
    expect(f).not.toContain(`❯ m@`)
    m.dispose()
  })

  test("teaching surfaces: welcome, guide, recipes gallery", async () => {
    const m = await mount(130, 44)
    await m.frame()
    m.ui.setOverlay("welcome")
    let f = await m.frame()
    await Bun.sleep(150)
    f = await m.frame()
    if (process.env.BATON_PRINT) console.log(f)
    expect(f).toContain("Welcome to Baton")
    expect(f).toContain("On this machine")
    expect(f).toContain("you review & merge")
    // the tour: look → autonomy → start
    m.t.mockInput.pressArrow("right")
    f = await m.frame()
    expect(f).toContain("Your look")
    expect(f).toContain("Modern")
    m.t.mockInput.pressArrow("down")
    await m.frame()
    expect(m.ui.prefs.style).toBe("modern")
    expect(m.ui.prefs.frame).toBe("bar")
    m.t.mockInput.pressArrow("up")
    m.t.mockInput.pressArrow("right")
    f = await m.frame()
    expect(f).toContain("How freely may agents act?")
    m.t.mockInput.pressArrow("right")
    f = await m.frame()
    expect(f).toContain("Try one of these")
    expect(f).toContain("The keys you need")
    m.t.mockInput.pressKey("g")
    f = await m.frame()
    expect(f).toContain("Guide")
    expect(f).toContain("How Baton works")
    m.t.mockInput.pressArrow("down")
    f = await m.frame()
    expect(f).toContain("Talking to agents")
    m.t.mockInput.pressEscape()
    await m.frame()
    m.ui.setOverlay("recipes")
    await Bun.sleep(150)
    f = await m.frame()
    expect(f).toContain("best-of-3")
    m.t.mockInput.pressEnter()
    await Bun.sleep(30)
    f = await m.frame()
    expect(f).toContain("❯ /recipe best-of-3 ")
    m.dispose()
  })

  test("styles, background and run-wide autonomy (shift+tab)", async () => {
    const m = await mount(130, 40)
    await m.frame()
    // /style applies a whole preset; changing one part makes it "custom"
    await m.t.mockInput.typeText("/style modern")
    m.t.mockInput.pressEnter()
    await m.frame()
    expect(m.ui.prefs.style).toBe("modern")
    expect(m.ui.prefs.frame).toBe("bar")
    expect(m.ui.prefs.status_style).toBe("blocks")
    await m.t.mockInput.typeText("/frame accent")
    m.t.mockInput.pressEnter()
    await m.frame()
    expect(m.ui.prefs.style).toBe("custom")
    // background = terminal: the painted theme is transparent, the loaded one is untouched
    await m.t.mockInput.typeText("/background terminal")
    m.t.mockInput.pressEnter()
    await m.frame()
    expect(m.ui.theme().background).toBe("transparent")
    expect(m.ui.rawTheme().background).not.toBe("transparent")
    // the style gallery previews live and esc restores exactly what was there
    m.ui.setOverlay("style")
    let f = await m.frame()
    expect(f).toContain("Neon")
    m.t.mockInput.pressArrow("down")
    await m.frame()
    expect(m.ui.prefs.style).not.toBe("custom")
    m.t.mockInput.pressEscape()
    await m.frame()
    expect(m.ui.prefs.style).toBe("custom")
    expect(m.ui.prefs.frame).toBe("accent")
    // shift+tab in the input: normal → auto → yolo, for every agent
    m.t.mockInput.pressTab({ shift: true })
    await until(() => live.state.autonomy === "auto")
    m.t.mockInput.pressTab({ shift: true })
    await until(() => live.state.autonomy === "yolo")
    f = await m.frame()
    expect(f).toContain("▲ YOLO")
    expect([...live.state.agents.values()].filter((a) => a.status !== "exited").every((a) => a.approval === "yolo")).toBe(true)
    await m.t.mockInput.typeText("/autonomy normal")
    m.t.mockInput.pressEnter()
    await until(() => live.state.autonomy === "normal")
    m.ui.setPrefs("background", "theme")
    m.dispose()
  })

  test("zoom: / searches the agent history, y copies, w saves a transcript", async () => {
    const m = await mount(140, 44)
    await m.frame()
    const w = live.state.workers()[0]!
    m.ui.setZoomed(w.agentId)
    let f = await m.frame()
    m.t.mockInput.pressKey("/")
    await Bun.sleep(30)
    await m.frame()
    expect(m.ui.capturing()).toBe(true)
    await m.t.mockInput.typeText("Read")
    f = await m.frame()
    expect(f).toMatch(/\d+\/\d+/) // "1/3"-style match counter
    m.t.mockInput.pressEscape()
    await m.frame()
    expect(m.ui.capturing()).toBe(false)
    expect(m.ui.zoomed()).toBe(w.agentId) // escape closed the search, not the zoom
    m.t.mockInput.pressKey("w")
    f = await m.frame()
    expect(f).toContain("saved")
    expect(f).toContain(join(".baton", "transcripts"))
    m.t.mockInput.pressEscape()
    m.dispose()
  })

  test("regressions: closing keys and Enter never leak into the draft; small terminals; agent text with escape codes", async () => {
    const m = await mount(140, 44)
    await m.frame()
    await m.t.mockInput.typeText("hello")
    await m.frame()
    m.t.mockInput.pressKey("e", { ctrl: true }) // costs
    await m.frame()
    m.t.mockInput.pressKey("q")
    await m.frame()
    await Bun.sleep(20)
    expect(m.ui.input()).toBe("hello")
    m.t.mockInput.pressKey("t", { ctrl: true }) // theme picker
    await m.frame()
    m.t.mockInput.pressEnter()
    await Bun.sleep(30)
    await m.frame()
    expect(m.ui.input()).toBe("hello") // the draft was not sent
    m.dispose()
    // tiny terminals render without crashing
    for (const [w, h] of [
      [36, 20],
      [80, 8],
      [6, 4],
    ] as const) {
      for (const layout of ["grid", "list", "wide", "swarm", "focus"]) {
        const t = await mount(w, h, { layout })
        const f = await t.frame()
        expect(f.split("\n").every((l) => Bun.stringWidth(l) <= w)).toBe(true)
        t.dispose()
      }
    }
    // escape codes / carriage returns from agents never reach the screen raw
    const w = live.state.workers()[0]!
    daemon.runtime.emit(
      { type: "message.completed", data: { messageId: "ansi", role: "assistant", text: "progress 50%\rprogress 100% \x1b[31mred\x1b[0m done" } },
      w.agentId,
    )
    const m2 = await mount(140, 44)
    m2.ui.setZoomed(w.agentId)
    const f2 = await m2.frame()
    expect(f2).toContain("progress 100% red done")
    expect(f2).not.toContain("[31m")
    m2.dispose()
  })
})

test("agent messages render Markdown (no raw ** or backticks on screen)", async () => {
  const a = await client.spawn({ adapter: "mock", name: "md", options: { speed: 0 } })
  await until(() => live.state.agents.get(a.agentId)?.status === "ready")
  daemon.runtime.emit(
    {
      type: "message.completed",
      data: {
        messageId: "md1",
        role: "assistant",
        text: "## Done\n\nAdded **rate limiting** to `POST /login`.\n\n- [x] tests pass\n- see [docs](https://example.com)\n\n| file | + |\n|---|---|\n| src/auth.ts | 42 |",
      },
    },
    a.agentId,
  )
  const m = await mount(120, 36)
  m.ui.setZoomed(a.agentId)
  let f = ""
  for (let i = 0; i < 30 && !f.includes("rate limiting"); i++) f = await m.frame()
  if (process.env.BATON_PRINT) console.log(f)
  expect(f).toContain("Added rate limiting to POST /login.")
  expect(f).toContain("☑ tests pass")
  expect(f).toContain("src/auth.ts │ 42")
  expect(f).not.toContain("**")
  expect(f).not.toContain("`POST")
  expect(f).not.toContain("## Done")
  m.dispose()
})
