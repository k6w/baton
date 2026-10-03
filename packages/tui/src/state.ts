/**
 * Reactive UI state. The run state (RunState, from the SDK) is mutable and updated by the
 * event stream; we expose it to Solid through a throttled `version` signal so a burst of
 * hundreds of token deltas becomes at most one re-render per frame.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type BatonConfig, defaultUser, type RunState, stateDir, type UiConfig } from "@batonsh/kernel"
import type { BatonEvent } from "@batonsh/protocol"
import type { BatonClient } from "@batonsh/sdk"
import { DEFAULT_VERBS, type ResolvedTheme, SPINNERS, STYLES, type StylePrefs } from "@batonsh/themes"
import { type Accessor, createSignal, type Setter } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import { Keymap } from "./keymap.ts"
import type { Replay } from "./replay.ts"

/** UI preferences that can change at runtime (persisted to the state dir, never to config files). */
export type Prefs = Pick<
  UiConfig,
  | "theme"
  | "appearance"
  | "layout"
  | "icons"
  | "border"
  | "density"
  | "render_style"
  | "show_bus"
  | "show_thoughts"
  | "animations"
  | "spinner"
  | "style"
  | "frame"
  | "status_style"
  | "background"
  | "brand_borders"
>

export const PREF_KEYS: (keyof Prefs)[] = [
  "theme",
  "appearance",
  "layout",
  "icons",
  "border",
  "density",
  "render_style",
  "show_bus",
  "show_thoughts",
  "animations",
  "spinner",
  "style",
  "frame",
  "status_style",
  "background",
  "brand_borders",
]

/**
 * The theme as painted: `background = terminal` makes the app and pane backgrounds
 * transparent so the terminal's own background (and its opacity / blur) shows through.
 * Overlays keep a solid fill so they stay readable.
 */
export function paintedTheme(t: ResolvedTheme, background: Prefs["background"]): ResolvedTheme {
  if (background !== "terminal") return t
  return { ...t, background: "transparent", backgroundPanel: "transparent" }
}

function prefsPath(): string {
  return join(stateDir(), "ui.json")
}

export function loadPrefs(): Partial<Prefs> {
  try {
    if (!existsSync(prefsPath())) return {}
    const raw = JSON.parse(readFileSync(prefsPath(), "utf8")) as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of PREF_KEYS) if (raw[k] !== undefined) out[k] = raw[k]
    return out as Partial<Prefs>
  } catch {
    return {}
  }
}

export function savePrefs(p: Partial<Prefs>): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(prefsPath(), JSON.stringify(p, null, 2))
  } catch {}
}

export type Overlay =
  | null
  | "palette"
  | "history"
  | "compare"
  | "inbox"
  | "help"
  | "theme"
  | "changes"
  | "diff"
  | "tasks"
  | "settings"
  | "peek"
  | "welcome"
  | "guide"
  | "recipes"
  | "costs"
  | "style"
  | "web"
  | "scores"
export type Focus = { kind: "input" } | { kind: "agent"; agentId: string }

export interface Toast {
  id: number
  text: string
  level: "info" | "warn" | "error"
}

export interface UiState {
  client: BatonClient | undefined
  run: RunState
  /** Reactive config store: reads inside components track, so live edits re-render. */
  config: BatonConfig
  setConfig: SetStoreFunction<BatonConfig>
  prefs: Prefs
  setPrefs: SetStoreFunction<Prefs>
  persistPrefs: () => void
  /** False in tests / embedded use: nothing is written to the state dir, no first-run screens. */
  persistent: boolean
  /** The theme as painted (background mode applied). */
  theme: Accessor<ResolvedTheme>
  /** The theme as loaded — use this to save/restore (previews). */
  rawTheme: Accessor<ResolvedTheme>
  setTheme: Setter<ResolvedTheme>
  version: Accessor<number>
  bump: () => void
  frame: Accessor<number>
  now: Accessor<number>
  focus: Accessor<Focus>
  setFocus: Setter<Focus>
  zoomed: Accessor<string | null>
  setZoomed: Setter<string | null>
  overlay: Accessor<Overlay>
  setOverlay: (o: Overlay) => void
  /** True for one tick after an overlay closes: the closing key must not reach the main input. */
  overlayClosing: Accessor<boolean>
  /** True while an in-pane text box (e.g. zoom search) owns the keyboard. */
  capturing: Accessor<boolean>
  setCapturing: Setter<boolean>
  /** Set by the zoom view: runs zoom.* keymap commands (search, copy, …). */
  zoomAction: Accessor<((id: string) => void) | undefined>
  setZoomAction: (fn: ((id: string) => void) | undefined) => void
  /** Agent shown in the peek overlay. */
  peekAgent: Accessor<string | null>
  setPeekAgent: Setter<string | null>
  /** Agent whose diff the diff overlay shows. */
  diffAgent: Accessor<string | null>
  setDiffAgent: Setter<string | null>
  page: Accessor<number>
  setPage: Setter<number>
  toasts: Accessor<Toast[]>
  toast: (text: string, level?: Toast["level"]) => void
  input: Accessor<string>
  setInput: Setter<string>
  keymap: Keymap
  verbs: string[]
  spinnerFrames: Accessor<string[]>
  /** Whether the terminal window has focus (focus reporting; assumed true if unsupported). */
  termFocused: Accessor<boolean>
  setTermFocused: Setter<boolean>
  /** Whether the terminal can show logo images. */
  imageSupport: Accessor<boolean>
  setImageSupport: Setter<boolean>
  home: string
  /** The person at this terminal (shared runs show who did what). */
  me: string
  /** Focus mode (do not disturb) ends at this time; undefined = off. */
  focusUntil: Accessor<number | undefined>
  /** Start focus mode for `minutes` (undefined/0 = end it). Updates held meanwhile are summarised at the end. */
  setFocusMode: (minutes?: number) => void
  /** Count of updates held back during focus mode. */
  heldWhileFocused: () => number
  holdForFocus: () => void
  /** Set when playing back a past run (read-only). */
  replay?: Replay
  /** Leave the live view and replay a past run (set by runTui). */
  requestReplay: (runId: string) => void
  dispose: () => void
}

export function createUiState(opts: {
  client?: BatonClient
  run: RunState
  config: BatonConfig
  theme: ResolvedTheme
  persist?: boolean
  me?: string
  replay?: Replay
}): UiState {
  const [config, setConfig] = createStore<BatonConfig>(structuredClone(opts.config))
  // `style = "modern"` in a config file implies its frame / status bar / …: any style key still
  // at its built-in default (the classic preset) takes the chosen style's value
  const chosen = STYLES.find((st) => st.name === opts.config.ui.style)
  const classic = STYLES[0]!.prefs
  const styled = <K extends keyof StylePrefs>(k: K, v: StylePrefs[K]): StylePrefs[K] => (chosen && v === classic[k] ? chosen.prefs[k] : v)
  const base: Prefs = {
    style: opts.config.ui.style,
    frame: styled("frame", opts.config.ui.frame),
    status_style: styled("status_style", opts.config.ui.status_style),
    background: styled("background", opts.config.ui.background),
    brand_borders: styled("brand_borders", opts.config.ui.brand_borders),
    theme: opts.config.ui.theme,
    appearance: opts.config.ui.appearance,
    layout: opts.config.ui.layout,
    icons: opts.config.ui.icons,
    border: styled("border", opts.config.ui.border),
    density: styled("density", opts.config.ui.density),
    render_style: opts.config.ui.render_style,
    show_bus: opts.config.ui.show_bus,
    show_thoughts: opts.config.ui.show_thoughts,
    animations: opts.config.ui.animations,
    spinner: styled("spinner", opts.config.ui.spinner),
  }
  const [prefs, setPrefs] = createStore<Prefs>({ ...base, ...(opts.persist === false ? {} : loadPrefs()) })
  const [rawTheme, setTheme] = createSignal(opts.theme)
  // cached: theme() is read hundreds of times per frame
  let paintedFrom: ResolvedTheme | undefined
  let paintedBg: Prefs["background"] | undefined
  let painted = opts.theme
  const theme = () => {
    const raw = rawTheme()
    const bg = prefs.background
    if (raw !== paintedFrom || bg !== paintedBg) {
      paintedFrom = raw
      paintedBg = bg
      painted = paintedTheme(raw, bg)
    }
    return painted
  }
  const [version, setVersion] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const [focus, setFocus] = createSignal<Focus>({ kind: "input" })
  const [zoomed, setZoomed] = createSignal<string | null>(null)
  const [overlay, setOverlaySig] = createSignal<Overlay>(null)
  const [overlayClosing, setOverlayClosing] = createSignal(false)
  const setOverlay = (o: Overlay) => {
    if (o === null && overlay() !== null) {
      setOverlayClosing(true)
      setTimeout(() => setOverlayClosing(false), 0)
    }
    setOverlaySig(() => o)
  }
  const [page, setPage] = createSignal(0)
  const [diffAgent, setDiffAgent] = createSignal<string | null>(null)
  const [peekAgent, setPeekAgent] = createSignal<string | null>(null)
  const [capturing, setCapturing] = createSignal(false)
  const [zoomAction, setZoomActionSig] = createSignal<((id: string) => void) | undefined>(undefined)
  const [toasts, setToasts] = createSignal<Toast[]>([])
  const [input, setInput] = createSignal("")
  const [imageSupport, setImageSupport] = createSignal(false)
  const [termFocused, setTermFocused] = createSignal(true)

  // Throttled re-render: at most `fps` times per second.
  const frameMs = Math.max(8, Math.floor(1000 / opts.config.ui.fps))
  let scheduled: ReturnType<typeof setTimeout> | undefined
  const bump = () => {
    if (scheduled) return
    scheduled = setTimeout(() => {
      scheduled = undefined
      setVersion((v) => v + 1)
    }, frameMs)
  }

  // Animation clock: only ticks while something is animating.
  const spinnerFrames = () => (SPINNERS[prefs.spinner] ?? SPINNERS.star)!.frames
  let animTimer: ReturnType<typeof setInterval> | undefined
  const ensureAnim = () => {
    const anyBusy = [...opts.run.agents.values()].some((a) => a.status === "busy" || a.status === "starting")
    const want = anyBusy && prefs.animations
    if (want && !animTimer) {
      const interval = (SPINNERS[prefs.spinner] ?? SPINNERS.star)!.interval
      animTimer = setInterval(() => setFrame((f) => f + 1), interval)
    } else if (!want && animTimer) {
      clearInterval(animTimer)
      animTimer = undefined
    }
  }
  const clock = setInterval(() => {
    setNow(Date.now())
    ensureAnim()
  }, 1000)

  let toastId = 0
  const toastTimers = new Set<ReturnType<typeof setTimeout>>()
  const [focusUntil, setFocusUntil] = createSignal<number | undefined>(undefined)
  let held = 0
  let focusTimer: ReturnType<typeof setTimeout> | undefined
  const setFocusMode = (minutes?: number) => {
    if (focusTimer) clearTimeout(focusTimer)
    focusTimer = undefined
    if (!minutes) {
      if (focusUntil() !== undefined) {
        setFocusUntil(undefined)
        toast(held ? `Focus over — ${held} update${held === 1 ? "" : "s"} came in meanwhile (ctrl+a inbox, ctrl+n next ⚑)` : "Focus over — all quiet")
        held = 0
      }
      return
    }
    held = 0
    setFocusUntil(Date.now() + minutes * 60_000)
    focusTimer = setTimeout(() => setFocusMode(undefined), minutes * 60_000)
  }

  const toast = (text: string, level: Toast["level"] = "info") => {
    const id = ++toastId
    setToasts((t) => [...t.slice(-3), { id, text, level }])
    const timer = setTimeout(
      () => {
        toastTimers.delete(timer)
        setToasts((t) => t.filter((x) => x.id !== id))
      },
      level === "error" ? 6000 : 3500,
    )
    toastTimers.add(timer)
  }

  return {
    client: opts.client,
    run: opts.run,
    config,
    setConfig,
    prefs,
    setPrefs,
    persistent: opts.persist !== false,
    persistPrefs: () => {
      if (opts.persist !== false) savePrefs({ ...prefs })
    },
    theme,
    rawTheme,
    setTheme,
    version,
    bump: () => {
      bump()
      ensureAnim()
    },
    frame,
    now,
    focus,
    setFocus,
    zoomed,
    setZoomed,
    overlay,
    setOverlay,
    overlayClosing,
    page,
    setPage,
    diffAgent,
    setDiffAgent,
    peekAgent,
    setPeekAgent,
    capturing,
    setCapturing,
    zoomAction,
    setZoomAction: (fn) => setZoomActionSig(() => fn),
    toasts,
    toast,
    input,
    setInput,
    keymap: new Keymap(opts.config.keys),
    verbs: opts.config.ui.verbs?.length ? opts.config.ui.verbs : DEFAULT_VERBS,
    spinnerFrames,
    imageSupport,
    setImageSupport,
    termFocused,
    setTermFocused,
    home: process.env.HOME ?? "",
    me: opts.me ?? defaultUser(),
    focusUntil,
    setFocusMode,
    heldWhileFocused: () => held,
    holdForFocus: () => {
      held++
    },
    replay: opts.replay,
    requestReplay: () => {},
    dispose: () => {
      clearInterval(clock)
      if (animTimer) clearInterval(animTimer)
      if (scheduled) clearTimeout(scheduled)
      for (const t of toastTimers) clearTimeout(t)
      if (focusTimer) clearTimeout(focusTimer)
    },
  }
}

/** Events that should raise a toast / notification. */
export function notableEvent(e: BatonEvent, run: RunState, me?: string): { text: string; level: Toast["level"] } | undefined {
  const name = e.agentId ? (run.agents.get(e.agentId)?.name ?? "agent") : "baton"
  switch (e.type) {
    case "permission.resolved":
      // shared runs: someone else answered a question you may be looking at
      return e.data.who && me && e.data.who !== me
        ? { text: `${e.data.who} ${e.data.kind?.startsWith("allow") ? "allowed" : "denied"} ${name}'s request`, level: "info" }
        : undefined
    case "budget.warn":
      return { text: `Budget ${e.data.scope}: $${e.data.usedUsd.toFixed(2)} of $${e.data.limitUsd}`, level: "warn" }
    case "budget.exceeded":
      return { text: `Budget exceeded (${e.data.scope}) — interrupted`, level: "error" }
    case "error":
      return e.data.fatal ? { text: `${name}: ${e.data.message}`, level: "error" } : undefined
    case "log":
      return e.data.level === "warn" && /^(config|plugin)\b/.test(e.data.message) ? { text: e.data.message, level: "warn" } : undefined
    case "agent.exited":
      return e.data.reason && e.data.reason !== "closed" && e.data.reason !== "killed" ? { text: `${name} exited: ${e.data.reason}`, level: "warn" } : undefined
    default:
      return undefined
  }
}
