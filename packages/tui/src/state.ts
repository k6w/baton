/**
 * Reactive UI state. The run state (RunState, from the SDK) is mutable and updated by the
 * event stream; we expose it to Solid through a throttled `version` signal so a burst of
 * hundreds of token deltas becomes at most one re-render per frame.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { type Accessor, type Setter, createSignal } from "solid-js"
import { createStore, type SetStoreFunction } from "solid-js/store"
import type { BatonEvent } from "@batonsh/protocol"
import { type BatonConfig, type RunState, type UiConfig, stateDir } from "@batonsh/kernel"
import type { BatonClient } from "@batonsh/sdk"
import { type ResolvedTheme, SPINNERS, DEFAULT_VERBS } from "@batonsh/themes"
import { Keymap } from "./keymap.ts"

/** UI preferences that can change at runtime (persisted to the state dir, never to config files). */
export type Prefs = Pick<
  UiConfig,
  "theme" | "appearance" | "layout" | "icons" | "border" | "density" | "render_style" | "show_bus" | "show_thoughts" | "animations" | "spinner"
>

const PREF_KEYS: (keyof Prefs)[] = ["theme", "appearance", "layout", "icons", "border", "density", "render_style", "show_bus", "show_thoughts", "animations", "spinner"]

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

export type Overlay = null | "palette" | "approvals" | "help" | "theme"
export type Focus = { kind: "input" } | { kind: "agent"; agentId: string }

export interface Toast {
  id: number
  text: string
  level: "info" | "warn" | "error"
}

export interface UiState {
  client: BatonClient | undefined
  run: RunState
  config: BatonConfig
  prefs: Prefs
  setPrefs: SetStoreFunction<Prefs>
  persistPrefs: () => void
  theme: Accessor<ResolvedTheme>
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
  setOverlay: Setter<Overlay>
  page: Accessor<number>
  setPage: Setter<number>
  toasts: Accessor<Toast[]>
  toast: (text: string, level?: Toast["level"]) => void
  input: Accessor<string>
  setInput: Setter<string>
  keymap: Keymap
  verbs: string[]
  spinnerFrames: Accessor<string[]>
  /** Whether the terminal can show logo images. */
  imageSupport: Accessor<boolean>
  setImageSupport: Setter<boolean>
  home: string
  dispose: () => void
}

export function createUiState(opts: { client?: BatonClient; run: RunState; config: BatonConfig; theme: ResolvedTheme; persist?: boolean }): UiState {
  const base: Prefs = {
    theme: opts.config.ui.theme,
    appearance: opts.config.ui.appearance,
    layout: opts.config.ui.layout,
    icons: opts.config.ui.icons,
    border: opts.config.ui.border,
    density: opts.config.ui.density,
    render_style: opts.config.ui.render_style,
    show_bus: opts.config.ui.show_bus,
    show_thoughts: opts.config.ui.show_thoughts,
    animations: opts.config.ui.animations,
    spinner: opts.config.ui.spinner,
  }
  const [prefs, setPrefs] = createStore<Prefs>({ ...base, ...(opts.persist === false ? {} : loadPrefs()) })
  const [theme, setTheme] = createSignal(opts.theme)
  const [version, setVersion] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  const [focus, setFocus] = createSignal<Focus>({ kind: "input" })
  const [zoomed, setZoomed] = createSignal<string | null>(null)
  const [overlay, setOverlay] = createSignal<Overlay>(null)
  const [page, setPage] = createSignal(0)
  const [toasts, setToasts] = createSignal<Toast[]>([])
  const [input, setInput] = createSignal("")
  const [imageSupport, setImageSupport] = createSignal(false)

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
  const toast = (text: string, level: Toast["level"] = "info") => {
    const id = ++toastId
    setToasts((t) => [...t.slice(-3), { id, text, level }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), level === "error" ? 6000 : 3500)
  }

  return {
    client: opts.client,
    run: opts.run,
    config: opts.config,
    prefs,
    setPrefs,
    persistPrefs: () => {
      if (opts.persist !== false) savePrefs({ ...prefs })
    },
    theme,
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
    page,
    setPage,
    toasts,
    toast,
    input,
    setInput,
    keymap: new Keymap(opts.config.keys),
    verbs: opts.config.ui.verbs?.length ? opts.config.ui.verbs : DEFAULT_VERBS,
    spinnerFrames,
    imageSupport,
    setImageSupport,
    home: process.env.HOME ?? "",
    dispose: () => {
      clearInterval(clock)
      if (animTimer) clearInterval(animTimer)
      if (scheduled) clearTimeout(scheduled)
    },
  }
}

/** Events that should raise a toast / notification. */
export function notableEvent(e: BatonEvent, run: RunState): { text: string; level: Toast["level"] } | undefined {
  const name = e.agentId ? (run.agents.get(e.agentId)?.name ?? "agent") : "baton"
  switch (e.type) {
    case "budget.warn":
      return { text: `Budget ${e.data.scope}: $${e.data.usedUsd.toFixed(2)} of $${e.data.limitUsd}`, level: "warn" }
    case "budget.exceeded":
      return { text: `Budget exceeded (${e.data.scope}) — interrupted`, level: "error" }
    case "error":
      return e.data.fatal ? { text: `${name}: ${e.data.message}`, level: "error" } : undefined
    case "agent.exited":
      return e.data.reason && e.data.reason !== "closed" && e.data.reason !== "killed" ? { text: `${name} exited: ${e.data.reason}`, level: "warn" } : undefined
    default:
      return undefined
  }
}
