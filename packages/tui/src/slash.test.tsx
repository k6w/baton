import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemon } from "@batonsh/daemon"
import { BatonClient } from "@batonsh/sdk"
import { loadTheme } from "@batonsh/themes"
import { testRender } from "@opentui/solid"
import { App } from "./App.tsx"
import { UiContext } from "./context.ts"
import { createUiState } from "./state.ts"

test("slash menu: arrow keys don't smear the suggestion rows", async () => {
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-slash-"))
  const d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 } },
  })
  const client = await BatonClient.open(d.socketPath)
  const live = await client.live()
  const config = (await client.call("config.get", {})).config as never
  const ui = createUiState({ client, run: live.state, config, theme: loadTheme("baton"), persist: false })
  const t = await testRender(
    () => (
      <UiContext.Provider value={ui}>
        <App onExit={() => {}} />
      </UiContext.Provider>
    ),
    { width: 120, height: 30 },
  )
  const frame = async () => {
    await Bun.sleep(30)
    await t.renderOnce()
    return t.captureCharFrame()
  }
  await frame()
  await t.mockInput.typeText("/")
  await frame()
  for (let i = 0; i < 4; i++) {
    t.mockInput.pressArrow("down")
    await frame()
  }
  t.mockInput.pressArrow("up")
  const f = await frame()
  if (process.env.BATON_PRINT) console.log(f)
  for (const line of f.split("\n")) expect((line.match(/\/spawn/g) ?? []).length).toBeLessThanOrEqual(1)
  for (const line of f.split("\n")) expect((line.match(/\/kill/g) ?? []).length).toBeLessThanOrEqual(1)
  expect(ui.input()).toBe("/")
  // a long completion list scrolls with the selection
  for (let i = 0; i < 10; i++) t.mockInput.pressArrow("down")
  expect(await frame()).toMatch(/› \/\w+/)

  // same for the overlay lists
  t.mockInput.pressEscape()
  await frame()
  t.mockInput.pressKey("p", { ctrl: true })
  await frame()
  for (let i = 0; i < 5; i++) {
    t.mockInput.pressArrow("down")
    await frame()
  }
  const p = await frame()
  if (process.env.BATON_PRINT) console.log(p)
  for (const line of p.split("\n")) expect((line.match(/Command palette/g) ?? []).length).toBeLessThanOrEqual(1)
  expect(p).toMatch(/› (Quit|Inbox|Jump|Approve|Settings|Choose|Keyboard)/)
  ui.dispose()
  t.renderer.destroy()
  await live.stop()
  client.close()
  await d.stop()
})
