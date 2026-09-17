/** Entry point: mount the TUI against a connected Baton client. */

import { join } from "node:path"
import { type BatonConfig, configDir, projectBatonDir } from "@batonsh/kernel"
import type { BatonClient, LiveRun } from "@batonsh/sdk"
import { loadTheme } from "@batonsh/themes"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { App } from "./App.tsx"
import { UiContext } from "./context.ts"
import { noticeFor, shouldNotify } from "./notify.ts"
import { createUiState, notableEvent } from "./state.ts"

export interface RunTuiOptions {
  client: BatonClient
  live: LiveRun
  config: BatonConfig
}

export async function runTui(opts: RunTuiOptions): Promise<{ shutdown: boolean }> {
  const dirs = { global: join(configDir(), "themes"), project: join(projectBatonDir(opts.live.state.projectRoot), "themes") }
  const ui = createUiState({
    client: opts.client,
    run: opts.live.state,
    config: opts.config,
    theme: loadTheme(opts.config.ui.theme, { appearance: opts.config.ui.appearance, dirs }),
  })
  // prefs may override the configured theme
  if (ui.prefs.theme !== opts.config.ui.theme && ui.prefs.theme !== "system") ui.setTheme(loadTheme(ui.prefs.theme, { appearance: ui.prefs.appearance, dirs }))

  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: opts.config.ui.fps,
    useMouse: opts.config.ui.mouse,
    autoFocus: false,
    backgroundColor: ui.theme().background,
  })

  let resolveExit!: (v: { shutdown: boolean }) => void
  const exited = new Promise<{ shutdown: boolean }>((r) => {
    resolveExit = r
  })
  const exit = (o: { shutdown: boolean }) => {
    ui.dispose()
    renderer.destroy()
    resolveExit(o)
  }

  const off = opts.live.onEvent((e) => {
    ui.bump()
    const n = notableEvent(e, opts.live.state)
    if (n) ui.toast(n.text, n.level)
    const notice = noticeFor(e, opts.live.state)
    if (notice) {
      const how = shouldNotify(notice, ui.config.notify, ui.termFocused())
      if (how.desktop) renderer.triggerNotification(notice.body, notice.title)
      if (how.bell) process.stdout.write("\x07")
    }
  })
  const offClose = opts.client.onClose((reason) => {
    ui.toast(`daemon connection lost: ${reason}`, "error")
    setTimeout(() => exit({ shutdown: false }), 1500)
  })

  await render(
    () => (
      <UiContext.Provider value={ui}>
        <App onExit={exit} />
      </UiContext.Provider>
    ),
    renderer,
  )
  const result = await exited
  off()
  offClose()
  return result
}
