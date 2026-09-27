import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
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

const sh = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })

async function until(pred: () => boolean, ms = 8000) {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error("timeout")
    await Bun.sleep(15)
  }
}

beforeAll(async () => {
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  root = mkdtempSync(join(tmpdir(), "baton-tuiws-"))
  sh(root, "init", "-q", "-b", "main")
  writeFileSync(join(root, "app.ts"), "export const greeting = 'helo'\n")
  sh(root, "add", "-A")
  sh(root, "commit", "-q", "-m", "init")
  d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "s.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 }, workspace: { review: "off" } },
  })
  client = await BatonClient.open(d.socketPath)
  live = await client.live()
})

afterAll(async () => {
  await live?.stop()
  client?.close()
  await d?.stop()
})

test("worktree badge, changes overlay, diff viewer, merge from the UI, task plan", async () => {
  const w = await client.spawn({ adapter: "mock", name: "fixer", label: "typo", options: { speed: 0 } })
  const path = live.state.workspaces.get(w.agentId)!.path
  writeFileSync(join(path, "app.ts"), "export const greeting = 'hello'\n")
  await d.runtime.collab.refresh(w.agentId)
  await until(() => (live.state.workspaces.get(w.agentId)?.files.length ?? 0) === 1)

  const config = (await client.call("config.get", {})).config as never
  const ui = createUiState({ client, run: live.state, config, theme: loadTheme("baton"), persist: false })
  const off = live.onEvent(() => ui.bump())
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
  let f = await frame()
  if (process.env.BATON_PRINT) console.log(f)
  expect(f).toContain("⎇ 1 file +1 −1")
  expect(f).toContain("⎇ 1 unmerged")

  t.mockInput.pressKey("d", { ctrl: true })
  f = await frame()
  expect(f).toContain("Changes")
  expect(f).toContain("fixer")
  expect(f).toContain("app.ts")
  t.mockInput.pressEnter()
  await until(() => ui.overlay() === "diff")
  await Bun.sleep(150)
  f = await frame()
  if (process.env.BATON_PRINT) console.log(f)
  expect(f).toContain("Diff · fixer")
  expect(f).toContain("+ export const greeting = 'hello'")
  expect(f.split("+ export const greeting = 'hello'").length - 1).toBe(1) // rendered once (no stale chunks)
  // line comment → sent to the author as one request
  t.mockInput.pressKey("c")
  await Bun.sleep(30)
  await frame()
  await t.mockInput.typeText("use a constant")
  t.mockInput.pressEnter()
  f = await frame()
  expect(f).toContain("✎ use a constant")
  expect(f).toContain("1 comment")
  t.mockInput.pressKey("c", { shift: true })
  await until(() => live.state.bus.some((b) => b.to === w.agentId && b.body.includes("app.ts:1") && b.body.includes("use a constant")))
  t.mockInput.pressKey("m")
  await until(() => readFileSync(join(root, "app.ts"), "utf8").includes("hello"))
  await until(() => live.state.workspaces.get(w.agentId)?.merge?.status === "merged")
  t.mockInput.pressEscape()
  f = await frame()
  expect(ui.overlay()).toBe("changes")
  t.mockInput.pressEscape()
  f = await frame()
  expect(f).toContain("✓ merged")

  // task plan overlay
  d.runtime.emit({ type: "task.created", data: { taskId: "fix", title: "Fix greeting typo", deps: [] } })
  d.runtime.emit({ type: "task.state", data: { taskId: "fix", state: "completed", owner: w.agentId } })
  t.mockInput.pressKey("g", { ctrl: true })
  f = await frame()
  expect(f).toContain("Task plan")
  expect(f).toContain("1/1 done")
  expect(f).toContain("Fix greeting typo")
  t.mockInput.pressEscape()

  off()
  ui.dispose()
  t.renderer.destroy()
})

test("compare: two candidates side by side, picking one merges it and stops the other", async () => {
  const a = await client.spawn({ adapter: "mock", name: "cand-a", label: "candidate A", options: { speed: 0 } })
  const b = await client.spawn({ adapter: "mock", name: "cand-b", label: "candidate B", options: { speed: 0 } })
  writeFileSync(join(live.state.workspaces.get(a.agentId)!.path, "pick.txt"), "A\n")
  writeFileSync(join(live.state.workspaces.get(b.agentId)!.path, "pick.txt"), "B\n")
  await d.runtime.collab.refresh(a.agentId)
  await d.runtime.collab.refresh(b.agentId)
  await until(() => (live.state.workspaces.get(b.agentId)?.files.length ?? 0) === 1)
  const config = (await client.call("config.get", {})).config as never
  const ui = createUiState({ client, run: live.state, config, theme: loadTheme("baton"), persist: false })
  const off = live.onEvent(() => ui.bump())
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
  ui.setOverlay("compare")
  let f = await frame()
  expect(f).toContain("Compare (2)")
  expect(f).toContain("cand-a")
  expect(f).toContain("cand-b")
  t.mockInput.pressArrow("right")
  t.mockInput.pressKey("p")
  f = await frame()
  expect(f).toContain("Merge cand-b and stop the other 1?")
  t.mockInput.pressKey("y")
  await until(() => existsSync(join(root, "pick.txt")) && readFileSync(join(root, "pick.txt"), "utf8") === "B\n")
  await until(() => live.state.agents.get(a.agentId)?.status === "exited")
  off()
  ui.dispose()
  t.renderer.destroy()
})
