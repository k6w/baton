/** Root component: layouts, global keys, command dispatch. */

import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { type AttentionItem, attentionItems, configDir, projectBatonDir, urgentCount } from "@batonsh/kernel"
import { FRAME_STYLES, listThemes, loadTheme, matchStyle, STYLES, type StylePrefs } from "@batonsh/themes"
import { onBlur, onFocus, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, Match, onCleanup, Show, Switch } from "solid-js"
import { AUTONOMY_CYCLE, AUTONOMY_INFO, type Autonomy } from "./autonomy.ts"
import { copyText } from "./clipboard.ts"
import { completions, LOCAL_COMMANDS } from "./completion.ts"
import { AgentList } from "./components/AgentList.tsx"
import { CompareOverlay } from "./components/Compare.tsx"
import { CostsOverlay } from "./components/Costs.tsx"
import { type Cell, computeGrid, Grid } from "./components/Grid.tsx"
import { HintBar } from "./components/HintBar.tsx"
import { HistoryOverlay } from "./components/History.tsx"
import { GuideOverlay, RecipesOverlay, WelcomeOverlay } from "./components/Learn.tsx"
import { StylePicker, ThemePicker } from "./components/Looks.tsx"
import { Orchestrator } from "./components/Orchestrator.tsx"
import { CommandPalette, HelpOverlay, Inbox, type PaletteItem, Toasts } from "./components/Overlays.tsx"
import { PeekOverlay } from "./components/Peek.tsx"
import { RemoteOverlay } from "./components/Remote.tsx"
import { ReplayBar } from "./components/ReplayBar.tsx"
import { ScoresOverlay } from "./components/Scores.tsx"
import { SettingsOverlay } from "./components/Settings.tsx"
import { StatusBar } from "./components/StatusBar.tsx"
import { ChangesOverlay, DiffOverlay, TasksOverlay } from "./components/Workspace.tsx"
import { ZoomView } from "./components/ZoomView.tsx"
import { useUi } from "./context.ts"
import type { KeyContext } from "./keymap.ts"
import { loadOnboarding, saveOnboarding } from "./onboarding.ts"
import type { Prefs } from "./state.ts"
import { buildSystemTheme } from "./system-theme.ts"

const debugKeys = process.env.BATON_DEBUG_KEYS

const LAYOUTS: Prefs["layout"][] = ["grid", "list", "focus", "swarm", "wide"]
const ICON_MODES: Prefs["icons"][] = ["auto", "unicode", "nerd", "ascii"]
const BORDERS: Prefs["border"][] = ["rounded", "single", "heavy", "double", "ascii", "none"]
const STYLE_KEYS = Object.keys(STYLES[0]!.prefs) as (keyof StylePrefs)[]

export function App(props: { onExit: (opts: { shutdown: boolean }) => void }) {
  const ui = useUi()
  const renderer = useRenderer()
  const dims = useTerminalDimensions()

  const themeDirs = () => ({
    global: join(configDir(), "themes"),
    project: ui.run.projectRoot ? join(projectBatonDir(ui.run.projectRoot), "themes") : undefined,
  })

  const applyTheme = async (name: string) => {
    if (name === "system") {
      try {
        const colors = await renderer.getPalette()
        ui.setTheme(buildSystemTheme(colors))
      } catch {
        ui.toast("couldn't read the terminal palette; using baton", "warn")
        ui.setTheme(loadTheme("baton", { dirs: themeDirs() }))
      }
      return
    }
    const known = listThemes(themeDirs()).some((t) => t.name === name)
    if (!known) {
      ui.toast(`unknown theme "${name}"`, "error")
      return
    }
    ui.setTheme(
      loadTheme(name, {
        appearance: ui.prefs.appearance,
        terminalBg: renderer.themeMode === "light" ? "#ffffff" : renderer.themeMode === "dark" ? "#000000" : undefined,
        dirs: themeDirs(),
      }),
    )
  }

  // initial theme (system / auto appearance need the renderer)
  if (ui.prefs.theme === "system" || ui.prefs.appearance === "auto") {
    // once the terminal reports dark/light — unless the user already changed the theme meanwhile
    const initial = ui.rawTheme()
    void renderer.waitForThemeMode(300).then(() => {
      if (ui.rawTheme() === initial) void applyTheme(ui.prefs.theme)
    })
  }

  // first run: welcome (once per machine; /welcome reopens it)
  if (ui.persistent && !loadOnboarding().welcomed && process.env.BATON_NO_WELCOME !== "1")
    setTimeout(() => ui.overlay() === null && ui.setOverlay("welcome"), 300)

  onFocus(() => ui.setTermFocused(true))
  onBlur(() => ui.setTermFocused(false))

  // logo support: wait for the capability probe
  const capPoll = setInterval(() => {
    const caps = renderer.capabilities
    if (caps) {
      ui.setImageSupport(!!(caps.kitty_graphics || caps.sixel) && process.env.BATON_NO_IMAGES !== "1")
      clearInterval(capPoll)
    }
  }, 100)
  setTimeout(() => clearInterval(capPoll), 3000)
  onCleanup(() => clearInterval(capPoll))

  // focus mode is calmer: no hint bar
  const showHints = () => ui.config.ui.hints && !ui.replay && ui.focusUntil() === undefined
  const chromeH = () => (showHints() ? 2 : 1) + (ui.replay ? 2 : 0)

  const setPref = <K extends keyof Prefs>(k: K, v: Prefs[K]) => {
    ui.setPrefs(k, v as never)
    // tweaking one part of a style turns it into "custom" (or back into the style it matches)
    if (STYLE_KEYS.includes(k as keyof StylePrefs)) ui.setPrefs("style", matchStyle(ui.prefs))
    ui.persistPrefs()
    ui.bump()
  }

  const applyStyle = (name: string) => {
    const st = STYLES.find((s) => s.name === name)
    if (!st) return ui.toast(`styles: ${STYLES.map((s) => s.name).join(", ")}`, "warn")
    for (const [k, v] of Object.entries(st.prefs)) ui.setPrefs(k as keyof Prefs, v as never)
    ui.setPrefs("style", st.name)
    ui.persistPrefs()
    ui.bump()
  }

  const setAutonomy = (mode: Autonomy) =>
    void call(ui.client?.call("run.autonomy", { mode }), (r) => {
      const info = AUTONOMY_INFO[mode]
      const extra = r.pending.length ? ` · ${r.pending.join(", ")} keep${r.pending.length === 1 ? "s" : ""} its sandbox until restarted` : ""
      ui.toast(`${info.glyph} autonomy: ${info.label} — ${info.blurb}${extra}`, mode === "yolo" ? "warn" : "info")
    })

  // background = terminal: the renderer's own clear color must be transparent too
  createEffect(() => {
    const bg = ui.theme().background
    try {
      renderer.setBackgroundColor(bg)
    } catch {}
  })

  // ───────────────────────────── layout ─────────────────────────────

  // Only changes when the set of workers changes — keeps cells (and the cards keyed on them) stable.
  const workers = createMemo(
    () => {
      ui.version()
      return ui.run.workers()
    },
    [],
    { equals: (a, b) => a.length === b.length && a.every((x, i) => x.agentId === b[i]?.agentId) },
  )

  const cellCache = new Map<string, Cell>()
  const busCell: Cell = { kind: "bus" }
  const cells = createMemo<Cell[]>(() => {
    const ws = workers()
    const out: Cell[] = ws.map((w) => {
      let c = cellCache.get(w.agentId)
      if (!c) {
        c = { kind: "agent", agentId: w.agentId }
        cellCache.set(w.agentId, c)
      }
      return c
    })
    if (cellCache.size > ws.length * 2 + 16) for (const id of [...cellCache.keys()]) if (!ws.some((w) => w.agentId === id)) cellCache.delete(id)
    if (ui.prefs.show_bus && ws.length > 0 && ui.prefs.layout !== "swarm") out.push(busCell)
    return out
  })

  const frame = createMemo(() => {
    const W = Math.max(1, dims().width)
    const H = Math.max(1, dims().height - chromeH()) // status bar (+ hint bar)
    const layout = ui.prefs.layout
    const hasWorkers = workers().length > 0
    const minOrch = Math.min(H, 5) // the lead pane always keeps room for its input
    // too small to split: the orchestrator alone (agents stay reachable via peek/zoom/list)
    if (!hasWorkers || H < 12 || W < 30) return { orch: { w: W, h: H }, grid: { w: W, h: 0 }, direction: "column" as const }
    if (layout === "wide") {
      const orchW = Math.min(W - 20, Math.max(40, Math.round(W * 0.38)))
      if (orchW >= 30) return { orch: { w: orchW, h: H }, grid: { w: W - orchW, h: H }, direction: "row" as const }
    }
    if (layout === "swarm") return { orch: { w: W, h: 2 }, grid: { w: W, h: H - 2 }, direction: "column" as const, slim: true }
    if (layout === "list") {
      const listH = Math.max(3, Math.min(workers().length + 2, Math.max(6, Math.round(H * 0.45)), H - minOrch))
      return { orch: { w: W, h: H - listH }, grid: { w: W, h: listH }, direction: "column" as const }
    }
    const orchH =
      layout === "focus"
        ? Math.max(minOrch, Math.min(10, Math.round(H * 0.3)))
        : Math.max(minOrch, Math.min(H - Math.min(ui.config.ui.min_card_height, H - minOrch), Math.round(H * 0.34)))
    return { orch: { w: W, h: orchH }, grid: { w: W, h: Math.max(0, H - orchH) }, direction: "column" as const }
  })

  const gridCols = () =>
    computeGrid(cells().length, frame().grid.w, frame().grid.h, {
      minW: ui.config.ui.min_card_width,
      minH: ui.config.ui.min_card_height,
      maxCols: ui.config.ui.max_columns,
    }).cols

  const zoomTarget = createMemo(() => {
    const z = ui.zoomed()
    if (z && ui.run.agents.has(z)) return z
    if (ui.prefs.layout === "focus") {
      const f = ui.focus()
      if (f.kind === "agent") return f.agentId
      return workers()[0]?.agentId ?? null
    }
    return null
  })

  // ───────────────────────────── actions ─────────────────────────────

  const focusAgentAt = (idx: number) => {
    const agents = cells().filter((c): c is Extract<Cell, { kind: "agent" }> => c.kind === "agent")
    if (!agents.length) return
    const i = ((idx % agents.length) + agents.length) % agents.length
    ui.setFocus({ kind: "agent", agentId: agents[i]!.agentId })
    const perPage = computeGrid(cells().length, frame().grid.w, frame().grid.h, {
      minW: ui.config.ui.min_card_width,
      minH: ui.config.ui.min_card_height,
      maxCols: ui.config.ui.max_columns,
    }).perPage
    if (perPage > 0) ui.setPage(Math.floor(i / perPage))
  }
  const focusedIndex = () => {
    const f = ui.focus()
    if (f.kind !== "agent") return -1
    return cells()
      .filter((c) => c.kind === "agent")
      .findIndex((c) => c.kind === "agent" && c.agentId === f.agentId)
  }
  const focusedAgent = () => {
    const f = ui.focus()
    return f.kind === "agent" ? ui.run.agents.get(f.agentId) : undefined
  }

  const call = async <T,>(p: Promise<T> | undefined, ok?: (v: T) => void) => {
    if (!p) return
    try {
      const v = await p
      ok?.(v)
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  let attentionCursor = -1
  /** Take the user to whatever an attention item is about. */
  const jumpTo = (it: AttentionItem) => {
    ui.setZoomed(null)
    if (it.kind === "plan") return ui.setOverlay("tasks")
    if (it.kind === "approval") return ui.setOverlay("inbox")
    if (!it.agentId) return ui.toast(it.title)
    const idx = cells()
      .filter((c) => c.kind === "agent")
      .findIndex((c) => c.kind === "agent" && c.agentId === it.agentId)
    if (idx >= 0) focusAgentAt(idx)
    if (it.kind === "ready" || it.kind === "conflict" || it.kind === "merge" || it.kind === "scope") {
      ui.setDiffAgent(it.agentId)
      ui.setOverlay(it.kind === "ready" || it.kind === "scope" ? "diff" : "changes")
    } else {
      ui.setPeekAgent(it.agentId)
      ui.setOverlay("peek")
    }
  }

  // terminal tab title: "⚑ 2 baton · project"
  let lastTitle = ""
  createEffect(() => {
    ui.version()
    if (!ui.config.ui.tab_title) return
    const n = urgentCount(attentionItems(ui.run))
    const title = `${n ? `⚑${n} ` : ""}baton · ${ui.run.projectName || "project"}`
    if (title !== lastTitle) {
      lastTitle = title
      // must not run inside a render phase (OpenTUI session control) — defer to the next tick
      setTimeout(() => {
        try {
          renderer.setTerminalTitle(title)
        } catch {}
      }, 0)
    }
  })
  const prefill = (text: string) => {
    // next tick: the key that triggered this must not land in the freshly focused input
    setTimeout(() => {
      ui.setFocus({ kind: "input" })
      ui.setInput(text)
    }, 0)
  }

  const run = (id: string) => {
    switch (id) {
      case "app.palette":
        ui.setOverlay("palette")
        break
      case "app.help":
        ui.setOverlay("help")
        break
      case "app.quit":
        if (ui.input()) {
          ui.setInput("")
          break
        }
        props.onExit({ shutdown: false })
        break
      case "app.shutdown":
        props.onExit({ shutdown: true })
        break
      case "inbox.open":
        ui.setOverlay("inbox")
        break
      case "attention.next": {
        const items = attentionItems(ui.run)
        if (!items.length) {
          ui.toast("nothing needs you right now")
          break
        }
        attentionCursor = (attentionCursor + 1) % items.length
        jumpTo(items[attentionCursor]!)
        break
      }
      case "pane.peek": {
        const a = focusedAgent()
        if (a) {
          ui.setPeekAgent(a.agentId)
          ui.setOverlay("peek")
        }
        break
      }
      case "approvals.allow":
        void call(ui.client?.submit("/approve"), (r) => r.output && ui.toast(r.output))
        break
      case "theme.pick":
        ui.setOverlay("theme")
        break
      case "settings.open":
        ui.setOverlay("settings")
        break
      case "guide.open":
        ui.setOverlay("guide")
        break
      case "costs.open":
        ui.setOverlay("costs")
        break
      case "history.open":
        ui.setOverlay("history")
        break
      case "compare.open":
        ui.setOverlay("compare")
        break
      case "recipes.open":
        ui.setOverlay("recipes")
        break
      case "welcome.open":
        ui.setOverlay("welcome")
        break
      case "changes.open":
        ui.setOverlay("changes")
        break
      case "tasks.open":
        ui.setOverlay("tasks")
        break
      case "pane.diff": {
        const a = focusedAgent()
        if (a) {
          ui.setDiffAgent(a.agentId)
          ui.setOverlay("diff")
        }
        break
      }
      case "layout.cycle":
        setPref("layout", LAYOUTS[(LAYOUTS.indexOf(ui.prefs.layout) + 1) % LAYOUTS.length]!)
        ui.toast(`layout: ${ui.prefs.layout}`)
        break
      case "focus.next":
      case "focus.prev": {
        if (ui.zoomed()) break
        const agents = cells().filter((c) => c.kind === "agent").length
        const idx = focusedIndex()
        const dir = id === "focus.next" ? 1 : -1
        if (ui.focus().kind === "input") {
          if (agents) focusAgentAt(dir === 1 ? 0 : agents - 1)
        } else if (idx + dir < 0 || idx + dir >= agents) ui.setFocus({ kind: "input" })
        else focusAgentAt(idx + dir)
        break
      }
      case "focus.input":
        ui.setFocus({ kind: "input" })
        break
      case "grid.left":
        focusAgentAt(focusedIndex() - 1)
        break
      case "grid.right":
        focusAgentAt(focusedIndex() + 1)
        break
      case "grid.up":
        focusAgentAt(focusedIndex() - (ui.prefs.layout === "list" ? 1 : gridCols()))
        break
      case "grid.down":
        focusAgentAt(focusedIndex() + (ui.prefs.layout === "list" ? 1 : gridCols()))
        break
      case "grid.pageDown": {
        const g = computeGrid(cells().length, frame().grid.w, frame().grid.h, {
          minW: ui.config.ui.min_card_width,
          minH: ui.config.ui.min_card_height,
          maxCols: ui.config.ui.max_columns,
        })
        ui.setPage((p) => Math.min(Math.max(0, g.pages - 1), p + 1))
        break
      }
      case "grid.pageUp":
        ui.setPage((p) => Math.max(0, p - 1))
        break
      case "pane.zoom": {
        const a = focusedAgent()
        if (a) ui.setZoomed(a.agentId)
        break
      }
      case "zoom.close":
        ui.setZoomed(null)
        break
      case "zoom.search":
      case "zoom.next":
      case "zoom.prev":
      case "zoom.top":
      case "zoom.bottom":
      case "zoom.copy":
      case "zoom.copyAll":
      case "zoom.save":
        ui.zoomAction()?.(id)
        break
      case "pane.message": {
        const a = focusedAgent()
        if (a) prefill(`@${a.name} `)
        break
      }
      case "pane.copyPath": {
        const a = focusedAgent()
        const ws = a ? ui.run.workspaces.get(a.agentId) : undefined
        if (ws) ui.toast(`${ws.path} — copied via ${copyText(renderer, ws.path)}`)
        break
      }
      case "pane.interrupt": {
        const a = focusedAgent()
        if (a) void call(ui.client?.interrupt(a.agentId), () => ui.toast(`interrupted ${a.name}`))
        break
      }
      case "pane.kill": {
        const a = focusedAgent()
        if (a) void call(ui.client?.kill(a.agentId), () => ui.toast(`killed ${a.name}`))
        break
      }
      case "orch.interrupt": {
        const o = ui.run.orchestratorId ? ui.run.agents.get(ui.run.orchestratorId) : undefined
        if (ui.input()) {
          ui.setInput("")
        } else if (o && o.status === "busy") void call(ui.client?.interrupt(o.agentId), () => ui.toast("interrupted orchestrator"))
        break
      }
      case "toggle.bus":
        setPref("show_bus", !ui.prefs.show_bus)
        break
      case "toggle.thoughts":
        setPref("show_thoughts", !ui.prefs.show_thoughts)
        ui.toast(`thoughts ${ui.prefs.show_thoughts ? "shown" : "hidden"}`)
        break
      case "toggle.icons":
        setPref("icons", ICON_MODES[(ICON_MODES.indexOf(ui.prefs.icons) + 1) % ICON_MODES.length]!)
        ui.toast(`icons: ${ui.prefs.icons}`)
        break
      case "toggle.border":
        setPref("border", BORDERS[(BORDERS.indexOf(ui.prefs.border) + 1) % BORDERS.length]!)
        break
      case "toggle.look":
        setPref("render_style", ui.prefs.render_style === "native" ? "unified" : "native")
        break
      case "toggle.density":
        setPref("density", ui.prefs.density === "comfy" ? "compact" : "comfy")
        break
      case "toggle.animations":
        setPref("animations", !ui.prefs.animations)
        break
      case "toggle.background":
        setPref("background", ui.prefs.background === "terminal" ? "theme" : "terminal")
        ui.toast(`background: ${ui.prefs.background === "terminal" ? "your terminal's" : "the theme's"}`)
        break
      case "style.pick":
        ui.setOverlay("style")
        break
      case "web.open":
        ui.setOverlay("web")
        break
      case "scores.open":
        ui.setOverlay("scores")
        break
      case "focus.toggle":
        if (ui.focusUntil() !== undefined) ui.setFocusMode(undefined)
        else {
          ui.setFocusMode(25)
          ui.toast("◐ Focus for 25 min: only approvals and errors get through")
        }
        break
      case "autonomy.cycle": {
        const cur = ui.run.autonomy
        setAutonomy(AUTONOMY_CYCLE[(AUTONOMY_CYCLE.indexOf(cur) + 1) % AUTONOMY_CYCLE.length]!)
        break
      }
      case "autonomy.yolo":
        setAutonomy(ui.run.autonomy === "yolo" ? "normal" : "yolo")
        break
    }
  }

  const localCommand = (text: string): boolean => {
    const m = /^\/(\w+)\s*(.*)$/.exec(text)
    if (!m || !(m[1]! in LOCAL_COMMANDS)) return false
    const arg = m[2]!.trim()
    switch (m[1]) {
      case "theme":
        if (!arg) ui.setOverlay("theme")
        else {
          setPref("theme", arg)
          void applyTheme(arg)
        }
        break
      case "layout":
        if (LAYOUTS.includes(arg as Prefs["layout"])) setPref("layout", arg as Prefs["layout"])
        else ui.toast(`layouts: ${LAYOUTS.join(", ")}`, "warn")
        break
      case "icons":
        if (ICON_MODES.includes(arg as Prefs["icons"])) setPref("icons", arg as Prefs["icons"])
        else ui.toast(`icon modes: ${ICON_MODES.join(", ")}`, "warn")
        break
      case "border":
        if (BORDERS.includes(arg as Prefs["border"])) setPref("border", arg as Prefs["border"])
        else ui.toast(`borders: ${BORDERS.join(", ")}`, "warn")
        break
      case "look":
        setPref("render_style", arg === "unified" ? "unified" : "native")
        break
      case "style":
        if (!arg) ui.setOverlay("style")
        else applyStyle(arg)
        break
      case "background":
        if (arg === "theme" || arg === "terminal") setPref("background", arg)
        else run("toggle.background")
        break
      case "frame":
        if (FRAME_STYLES.includes(arg as Prefs["frame"])) setPref("frame", arg as Prefs["frame"])
        else ui.toast(`frames: ${FRAME_STYLES.join(", ")}`, "warn")
        break
      case "bus":
        run("toggle.bus")
        break
      case "thoughts":
        run("toggle.thoughts")
        break
      case "zoom": {
        const a = ui.run.findAgent(arg)
        if (a) ui.setZoomed(a.agentId)
        else ui.toast(`no agent "${arg}"`, "error")
        break
      }
      case "help":
        ui.setOverlay("help")
        break
      case "settings":
        ui.setOverlay("settings")
        break
      case "guide":
        ui.setOverlay("guide")
        break
      case "costs":
        ui.setOverlay("costs")
        break
      case "history":
        ui.setOverlay("history")
        break
      case "compare":
        ui.setOverlay("compare")
        break
      case "recipes":
        ui.setOverlay("recipes")
        break
      case "welcome":
        ui.setOverlay("welcome")
        break
      case "web":
        ui.setOverlay("web")
        break
      case "a2a":
        void call(ui.client?.call("a2a.start", {}), (r) =>
          ui.toast(`A2A agent at ${r.url} · card: /.well-known/agent-card.json${r.token ? " · token: baton a2a" : ""}`),
        )
        break
      case "focus": {
        if (ui.focusUntil() !== undefined && !arg) ui.setFocusMode(undefined)
        else {
          const mins = Number(arg) || 25
          ui.setFocusMode(mins)
          ui.toast(`◐ Focus for ${mins} min: only approvals and errors get through · /focus again to end`)
        }
        break
      }
      case "scores":
        ui.setOverlay("scores")
        break
      case "quit":
        props.onExit({ shutdown: false })
        break
      case "shutdown":
        props.onExit({ shutdown: true })
        break
    }
    return true
  }

  const submit = (text: string) => {
    if (localCommand(text)) return
    void call(ui.client?.submit(text), (r) => {
      if (r.output) ui.toast(r.output)
    })
  }

  // ───────────────────────────── keyboard ─────────────────────────────

  let lastCtrlC = 0
  useKeyboard((key) => {
    // BATON_DEBUG_KEYS=<file>: log every key with the UI's focus state (for diagnosing input issues)
    if (debugKeys)
      appendFileSync(
        debugKeys,
        `${Date.now()} key=${key.name} seq=${JSON.stringify(key.sequence)} overlay=${ui.overlay()} focus=${ui.focus().kind} zoom=${ui.zoomed()}\n`,
      )
    if (ui.capturing()) {
      // an in-pane text box owns the keyboard (it handles its own escape); ctrl+c still gets you out
      if (!(key.ctrl && key.name === "c")) return
      ui.setCapturing(false)
    }
    if (ui.overlay()) {
      if (key.ctrl && key.name === "c") ui.setOverlay(null)
      return
    }
    const contexts: KeyContext[] = []
    const typing = ui.focus().kind === "input" && !ui.zoomed()
    if (ui.zoomed()) contexts.push("zoom")
    else if (typing) contexts.push("input")
    else contexts.push("grid")
    contexts.push("global")
    // while completions are open, tab/up/down belong to the input
    if (typing && ["tab", "up", "down"].includes(key.name) && completions(ui.input(), ui.run, ui.config, ui.client).length > 0) return
    const id = ui.keymap.resolve(key, contexts)
    if (!id) return
    // while typing, only fire global commands bound to modifier / special keys
    if (typing && contexts[0] === "input" && id !== "orch.interrupt") {
      const special = key.ctrl || key.meta || key.option || ["tab", "pageup", "pagedown", "f1", "f2", "escape"].includes(key.name)
      if (!special) return
    }
    if (id === "app.quit" && !ui.input()) {
      const now = Date.now()
      if (now - lastCtrlC > 1500) {
        lastCtrlC = now
        ui.toast("press ctrl+c again to quit (agents keep running) · ctrl+q stops everything")
        return
      }
    }
    key.preventDefault?.()
    run(id)
  })

  // ───────────────────────────── palette items ─────────────────────────────

  const paletteItems = (): PaletteItem[] => {
    const items: PaletteItem[] = []
    for (const c of ui.keymap.commands) if (!c.hidden) items.push({ id: c.id, label: c.title, keys: c.keys[0], run: () => run(c.id) })
    for (const t of listThemes(themeDirs()))
      items.push({
        id: `theme:${t.name}`,
        label: `Theme: ${t.name}`,
        detail: t.source === "builtin" ? "" : t.source,
        run: () => {
          setPref("theme", t.name)
          void applyTheme(t.name)
        },
      })
    items.push({
      id: "theme:system",
      label: "Theme: system (terminal colors)",
      run: () => {
        setPref("theme", "system")
        void applyTheme("system")
      },
    })
    for (const l of LAYOUTS) items.push({ id: `layout:${l}`, label: `Layout: ${l}`, run: () => setPref("layout", l) })
    for (const m of ICON_MODES) items.push({ id: `icons:${m}`, label: `Icons: ${m}`, run: () => setPref("icons", m) })
    for (const b of BORDERS) items.push({ id: `border:${b}`, label: `Border: ${b}`, run: () => setPref("border", b) })
    for (const st of STYLES) items.push({ id: `style:${st.name}`, label: `Style: ${st.title}`, detail: st.description, run: () => applyStyle(st.name) })
    for (const f of FRAME_STYLES) items.push({ id: `frame:${f}`, label: `Frame: ${f}`, run: () => setPref("frame", f) })
    for (const m of ["normal", "ask", "auto", "yolo"] as const)
      items.push({ id: `autonomy:${m}`, label: `Autonomy: ${AUTONOMY_INFO[m].label}`, detail: AUTONOMY_INFO[m].blurb, run: () => setAutonomy(m) })
    const adapters = ["claude", "codex", "opencode", "gemini", "cursor", "copilot", ...Object.keys(ui.config.agents)]
    for (const a of [...new Set(adapters)])
      items.push({ id: `spawn:${a}`, label: `Spawn: ${a}`, detail: "start a new agent", run: () => submit(`/spawn ${a}`) })
    items.push({ id: "merge-all", label: "Merge all worker changes", detail: "/merge all", run: () => submit("/merge all") })
    for (const a of ui.run.workers()) {
      if (ui.run.workspaces.get(a.agentId)?.mode === "worktree") {
        items.push({
          id: `diff:${a.agentId}`,
          label: `Diff: ${a.name}`,
          run: () => {
            ui.setDiffAgent(a.agentId)
            ui.setOverlay("diff")
          },
        })
        items.push({ id: `merge:${a.agentId}`, label: `Merge: ${a.name}`, run: () => submit(`/merge ${a.name}`) })
        items.push({ id: `review:${a.agentId}`, label: `Review: ${a.name}`, detail: "cross-vendor review", run: () => submit(`/review ${a.name}`) })
      }
      items.push({ id: `zoom:${a.agentId}`, label: `Zoom: ${a.name}`, detail: a.label, run: () => ui.setZoomed(a.agentId) })
      items.push({ id: `msg:${a.agentId}`, label: `Message: ${a.name}`, run: () => prefill(`@${a.name} `) })
      items.push({ id: `int:${a.agentId}`, label: `Interrupt: ${a.name}`, run: () => void call(ui.client?.interrupt(a.agentId)) })
      items.push({ id: `kill:${a.agentId}`, label: `Kill: ${a.name}`, run: () => void call(ui.client?.kill(a.agentId)) })
    }
    items.push({ id: "agents", label: "Show installed agents", detail: "/agents", run: () => submit("/agents") })
    items.push({ id: "interrupt-all", label: "Interrupt everyone", run: () => submit("!all") })
    return items
  }

  // ───────────────────────────── view ─────────────────────────────

  const inputFocused = () => ui.focus().kind === "input" && !ui.zoomed()

  return (
    <box width={dims().width} height={dims().height} flexDirection="column" backgroundColor={ui.theme().background}>
      <box flexDirection={frame().direction} height={dims().height - chromeH()}>
        <Orchestrator width={frame().orch.w} height={frame().orch.h} focused={inputFocused()} onSubmit={submit} slim={!!frame().slim} />
        <Show when={frame().grid.h > 0 && frame().grid.w > 0}>
          <Switch>
            <Match when={zoomTarget()}>
              <ZoomView agentId={zoomTarget()!} width={frame().grid.w} height={frame().grid.h} />
            </Match>
            <Match when={!zoomTarget() && ui.prefs.layout === "list"}>
              <AgentList
                width={frame().grid.w}
                height={frame().grid.h}
                agentIds={cells()
                  .filter((c) => c.kind === "agent")
                  .map((c) => (c as { agentId: string }).agentId)}
              />
            </Match>
            <Match when={!zoomTarget()}>
              <Grid
                width={frame().grid.w}
                height={frame().grid.h}
                cells={cells()}
                onSelect={(id) => ui.setFocus({ kind: "agent", agentId: id })}
                onZoom={(id) => ui.setZoomed(id)}
              />
            </Match>
          </Switch>
        </Show>
      </box>
      <Show when={ui.replay}>
        <ReplayBar replay={ui.replay!} width={dims().width} onExit={() => props.onExit({ shutdown: false })} />
      </Show>
      <Show when={showHints()}>
        <HintBar width={dims().width} />
      </Show>
      <StatusBar width={dims().width} />
      <Toasts width={dims().width} />
      <Switch>
        <Match when={ui.overlay() === "palette"}>
          <CommandPalette items={paletteItems()} onClose={() => ui.setOverlay(null)} />
        </Match>
        <Match when={ui.overlay() === "theme"}>
          <ThemePicker
            onClose={() => ui.setOverlay(null)}
            onPick={(name) => {
              setPref("theme", name)
              void applyTheme(name)
            }}
          />
        </Match>
        <Match when={ui.overlay() === "inbox"}>
          <Inbox onClose={() => ui.setOverlay(null)} onJump={jumpTo} />
        </Match>
        <Match when={ui.overlay() === "peek" && ui.peekAgent()}>
          <PeekOverlay
            agentId={ui.peekAgent()!}
            onClose={() => ui.setOverlay(null)}
            onZoom={() => {
              ui.setZoomed(ui.peekAgent())
              ui.setOverlay(null)
            }}
            onDiff={() => {
              ui.setDiffAgent(ui.peekAgent())
              ui.setOverlay("diff")
            }}
          />
        </Match>
        <Match when={ui.overlay() === "help"}>
          <HelpOverlay onClose={() => ui.setOverlay(null)} />
        </Match>
        <Match when={ui.overlay() === "welcome"}>
          <WelcomeOverlay
            onClose={() => {
              saveOnboarding({ ...loadOnboarding(), welcomed: true })
              ui.setOverlay(null)
            }}
            onTask={(text) => prefill(text)}
            onGuide={() => ui.setOverlay("guide")}
            onStyle={applyStyle}
            onTheme={(dir) => {
              const names = ["system", ...listThemes(themeDirs()).map((t) => t.name)]
              const next = names[(names.indexOf(ui.prefs.theme) + dir + names.length) % names.length]!
              setPref("theme", next)
              void applyTheme(next)
            }}
            onAutonomy={setAutonomy}
          />
        </Match>
        <Match when={ui.overlay() === "compare"}>
          <CompareOverlay
            onClose={() => ui.setOverlay(null)}
            onDiff={(id) => {
              ui.setDiffAgent(id)
              ui.setOverlay("diff")
            }}
          />
        </Match>
        <Match when={ui.overlay() === "history"}>
          <HistoryOverlay onClose={() => ui.setOverlay(null)} />
        </Match>
        <Match when={ui.overlay() === "costs"}>
          <CostsOverlay onClose={() => ui.setOverlay(null)} />
        </Match>
        <Match when={ui.overlay() === "guide"}>
          <GuideOverlay
            onClose={() => ui.setOverlay(null)}
            onTry={(action) => {
              // next tick: the key that closed the guide must not reach what opens next
              setTimeout(() => {
                if (action === "agents") submit("/agents")
                else if (action.startsWith("prefill:")) prefill(action.slice(8))
                else run(action)
              }, 0)
            }}
          />
        </Match>
        <Match when={ui.overlay() === "recipes"}>
          <RecipesOverlay
            onClose={() => ui.setOverlay(null)}
            onPick={(name) => {
              ui.setOverlay(null)
              prefill(`/recipe ${name} `)
            }}
          />
        </Match>
        <Match when={ui.overlay() === "scores"}>
          <ScoresOverlay onClose={() => ui.setOverlay(null)} />
        </Match>
        <Match when={ui.overlay() === "web"}>
          <RemoteOverlay onClose={() => ui.setOverlay(null)} />
        </Match>
        <Match when={ui.overlay() === "style"}>
          <StylePicker onClose={() => ui.setOverlay(null)} onPick={applyStyle} />
        </Match>
        <Match when={ui.overlay() === "settings"}>
          <SettingsOverlay onClose={() => ui.setOverlay(null)} applyTheme={(n) => void applyTheme(n)} />
        </Match>
        <Match when={ui.overlay() === "changes"}>
          <ChangesOverlay onClose={() => ui.setOverlay(null)} />
        </Match>
        <Match when={ui.overlay() === "diff"}>
          <DiffOverlay onClose={() => ui.setOverlay(ui.run.workspaces.size ? "changes" : null)} />
        </Match>
        <Match when={ui.overlay() === "tasks"}>
          <TasksOverlay onClose={() => ui.setOverlay(null)} onPrefill={prefill} />
        </Match>
      </Switch>
    </box>
  )
}
