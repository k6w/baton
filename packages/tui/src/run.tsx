/** Entry point: mount the TUI against a connected Baton client. */

import { join } from "node:path"
import { type BatonConfig, configDir, noticeFor, projectBatonDir, shouldNotify } from "@batonsh/kernel"
import type { BatonEvent } from "@batonsh/protocol"
import type { BatonClient, LiveRun } from "@batonsh/sdk"
import { loadTheme } from "@batonsh/themes"
import { createCliRenderer } from "@opentui/core"
import { render } from "@opentui/solid"
import { App } from "./App.tsx"
import { UiContext } from "./context.ts"
import { Replay, replayState } from "./replay.ts"
import { playSound } from "./sound.ts"
import { createUiState, notableEvent } from "./state.ts"

export interface RunTuiOptions {
  client: BatonClient
  config: BatonConfig
  /** Live mode: follow the daemon's current run. */
  live?: LiveRun
  /** Replay mode: play back a past run's events (read-only, no daemon actions). */
  replay?: { events: BatonEvent[]; title: string }
}

export interface RunTuiResult {
  shutdown: boolean
  /** The user asked to replay this run (from history); the caller shows it, then comes back. */
  replay?: string
}

export async function runTui(opts: RunTuiOptions): Promise<RunTuiResult> {
  const replay = opts.replay ? new Replay(opts.replay.events, replayState(opts.replay.events), opts.replay.title) : undefined
  const state = replay ? replay.state : opts.live!.state
  const dirs = { global: join(configDir(), "themes"), project: join(projectBatonDir(state.projectRoot || process.cwd()), "themes") }
  const ui = createUiState({
    // a replay never talks to the daemon: every action is a no-op
    client: replay ? undefined : opts.client,
    run: state,
    config: opts.config,
    theme: loadTheme(opts.config.ui.theme, { appearance: opts.config.ui.appearance, dirs }),
    replay,
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

  let resolveExit!: (v: RunTuiResult) => void
  const exited = new Promise<RunTuiResult>((r) => {
    resolveExit = r
  })
  const exit = (o: RunTuiResult) => {
    replay?.dispose()
    ui.dispose()
    renderer.destroy()
    resolveExit(o)
  }
  ui.requestReplay = (runId) => exit({ shutdown: false, replay: runId })

  let watching = new Set(state.viewers.map((v) => v.name).filter((n) => n !== ui.me))
  const off = opts.live ? opts.live.onEvent((e: BatonEvent) => onLiveEvent(e)) : () => {}
  function onLiveEvent(e: BatonEvent) {
    ui.bump()
    // shared runs: say when someone starts or stops watching
    if (e.type === "run.presence") {
      const now = new Set(e.data.viewers.map((v) => v.name).filter((n) => n !== ui.me))
      for (const n of now) if (!watching.has(n)) ui.toast(`◎ ${n} is watching this run`)
      for (const n of watching) if (!now.has(n)) ui.toast(`${n} left`)
      watching = now
    }
    const focusMode = ui.focusUntil() !== undefined
    const n = notableEvent(e, state, ui.me)
    // focus mode: only errors break through as toasts; the rest is counted for the summary
    if (n && focusMode && n.level !== "error") ui.holdForFocus()
    else if (n) ui.toast(n.text, n.level)
    const notice = noticeFor(e, state)
    if (notice) {
      const how = shouldNotify(notice, ui.config.notify, ui.termFocused(), focusMode)
      if (focusMode && !how.desktop && !how.sound && notice.kind !== "approval") ui.holdForFocus()
      if (how.desktop) renderer.triggerNotification(notice.body, notice.title)
      if (how.sound) playSound(notice.kind, ui.config.notify)
      else if (how.bell) process.stdout.write("\x07")
    }
  }
  const offClose = replay
    ? () => {}
    : opts.client.onClose((reason) => {
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
  // replays start playing right away, from the first event
  if (replay) {
    replay.seek(1)
    replay.toggle()
  }
  const result = await exited
  off()
  offClose()
  return result
}
