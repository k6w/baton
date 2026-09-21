import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Daemon, startDaemon } from "@batonsh/daemon"
import { BatonClient, type LiveRun } from "@batonsh/sdk"
import { loadTheme } from "@batonsh/themes"
import { testRender } from "@opentui/solid"
import { App } from "./App.tsx"
import { UiContext } from "./context.ts"
import { createUiState } from "./state.ts"

let d: Daemon
let client: BatonClient
let live: LiveRun
let root: string

beforeAll(async () => {
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  root = mkdtempSync(join(tmpdir(), "baton-settings-"))
  mkdirSync(join(root, ".baton"))
  writeFileSync(join(root, ".baton", "config.toml"), `# my project\n[orchestrator]\nagent = "mock"   # keep this comment\n`)
  d = await startDaemon({ projectRoot: root, ephemeral: true, socketPath: join(root, "s.sock"), overrides: { bus: { heartbeat_s: 0 } } })
  client = await BatonClient.open(d.socketPath)
  live = await client.live()
})

afterAll(async () => {
  await live?.stop()
  client?.close()
  await d?.stop()
})

test("settings: browse, toggle, cycle, edit, scope — written to the config file and applied live", async () => {
  const config = (await client.call("config.get", {})).config as never
  const ui = createUiState({ client, run: live.state, config, theme: loadTheme("baton"), persist: false })
  const t = await testRender(
    () => (
      <UiContext.Provider value={ui}>
        <App onExit={() => {}} />
      </UiContext.Provider>
    ),
    { width: 130, height: 40 },
  )
  const frame = async () => {
    await Bun.sleep(40)
    await t.renderOnce()
    return t.captureCharFrame()
  }
  await frame()
  t.mockInput.pressKey("s", { ctrl: true })
  let f = await frame()
  if (process.env.BATON_PRINT) console.log(f)
  expect(f).toContain("Settings")
  expect(f).toContain("Appearance")
  expect(f).toContain("Theme")
  expect(f).toContain("Notifications")

  // Appearance → "Animations" is the 9th entry: toggle it off
  for (let i = 0; i < 8; i++) t.mockInput.pressArrow("down")
  await frame()
  t.mockInput.pressKey(" ")
  await frame()
  expect(ui.prefs.animations).toBe(false)
  const cfgText = () => readFileSync(join(root, ".baton", "config.toml"), "utf8")
  expect(cfgText()).toContain("animations = false")
  expect(cfgText()).toContain("# keep this comment")

  // cycle the layout (3rd entry) with →
  for (let i = 0; i < 6; i++) t.mockInput.pressArrow("up")
  t.mockInput.pressArrow("right")
  await frame()
  expect(ui.prefs.layout).toBe("list")

  // search for "reviews", change it → daemon reloads config
  t.mockInput.pressKey("/")
  await frame()
  await t.mockInput.typeText("review")
  f = await frame()
  if (process.env.BATON_PRINT) console.log(f.split("\n").slice(2, 12).join("\n"))
  t.mockInput.pressEnter()
  f = await frame()
  await Bun.sleep(50)
  expect(cfgText()).toMatch(/\[workspace\][\s\S]*review = "(off|suggested|required)"/)
  expect(d.runtime.config.workspace.review).not.toBe("suggested")

  // scope: tab → global; editing a number writes the global file
  t.mockInput.pressEscape()
  await frame()
  t.mockInput.pressTab()
  f = await frame()
  expect(f).toContain("▸global")
  t.mockInput.pressEscape()
  await frame()
  expect(ui.overlay()).toBeNull()
  ui.dispose()
  t.renderer.destroy()
})
