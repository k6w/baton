/**
 * Settings screen: every setting, grouped into sections with a short explanation, each drawn
 * with a control that shows what it is (toggle, choice dots, slider, swatch). Edits are written
 * to the project or global config file (comments preserved); looks apply instantly, agent-side
 * settings are reloaded into the daemon. Style and theme open their live galleries.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  BatonConfig,
  configDir,
  getPath,
  loadConfig,
  projectPaths,
  SECTIONS,
  SETTINGS,
  type SettingDef,
  setTomlValue,
  trustEntries,
  trustSurface,
} from "@batonsh/kernel"
import { listThemes, STYLES } from "@batonsh/themes"
import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Show } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { clip, type Line, type Seg, width as sw, wrap } from "../lines.ts"
import { modelsFor } from "../models.ts"
import { PREF_KEYS, type Prefs } from "../state.ts"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { choice, keycap, slider, swatch, toggle } from "../ui/widgets.ts"
import { Modal } from "./Overlays.tsx"

const ADAPTERS = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "cursor",
  "copilot",
  "goose",
  "qwen",
  "kiro",
  "droid",
  "cline",
  "amp",
  "claude-cli",
  "opencode-acp",
  "mock",
]
const PREFS = new Set<string>(PREF_KEYS)

type Scope = "project" | "global"

function scopePath(scope: Scope, root: string): string {
  return scope === "project" ? projectPaths(root).config : join(configDir(), "config.toml")
}

export function formatValue(v: unknown): string {
  if (v === undefined || v === null || v === "") return "—"
  if (typeof v === "boolean") return v ? "on" : "off"
  if (Array.isArray(v)) return v.length ? v.join(", ") : "none"
  return String(v)
}

/** Settings whose change also moves other keys (a style preset sets all of its shapes). */
function expand(s: SettingDef, v: unknown): [string, unknown][] {
  if (s.key === "ui.style") {
    const st = STYLES.find((x) => x.name === v)
    if (st) return [["ui.style", v], ...Object.entries(st.prefs).map(([k, val]) => [`ui.${k}`, val] as [string, unknown])]
  }
  return [[s.key, v]]
}

export function SettingsOverlay(props: { onClose: () => void; applyTheme: (name: string) => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const root = ui.run.projectRoot || process.cwd()
  const [section, setSection] = createSignal(0)
  const [row, setRow] = createSignal(0)
  const [pane, setPane] = createSignal<"sections" | "settings">("settings")
  const [scope, setScope] = createSignal<Scope>("project")
  const [editing, setEditing] = createSignal<SettingDef | null>(null)
  const [filter, setFilter] = createSignal<string | null>(null)
  const [tick, setTick] = createSignal(0)
  let editRef: InputRenderable | undefined
  const themes = listThemes({ global: join(configDir(), "themes"), project: join(projectPaths(root).dir, "themes") }).map((t) => t.name)

  // fresh config + provenance from disk (re-read after every write)
  const loaded = createMemo(() => {
    tick()
    return loadConfig({ projectRoot: root })
  })
  const isPref = (s: SettingDef) => s.key.startsWith("ui.") && PREFS.has(s.key.slice(3))
  const value = (s: SettingDef): unknown => {
    if (isPref(s)) return (ui.prefs as Record<string, unknown>)[s.key.slice(3)]
    if (s.key === "policy.autonomy") return ui.run.autonomy
    return getPath(loaded().config, s.key)
  }
  const source = (s: SettingDef): string => {
    const fromFile = loaded().provenance[s.key]
    if (isPref(s) && getPath(loaded().config, s.key) !== value(s)) return "this session"
    if (s.key === "policy.autonomy" && ui.run.autonomy !== loaded().config.policy.autonomy) return "this run"
    return fromFile ?? "default"
  }

  const visible = createMemo<SettingDef[]>(() => {
    const f = filter()
    if (f) {
      const q = f.toLowerCase()
      // rank: label prefix > label > key > section > help text
      const score = (s: SettingDef) => {
        const l = s.label.toLowerCase()
        if (l.startsWith(q)) return 5
        if (l.includes(q)) return 4
        if (s.key.toLowerCase().includes(q)) return 3
        if (s.section.toLowerCase().includes(q)) return 2
        return s.help.toLowerCase().includes(q) ? 1 : 0
      }
      return SETTINGS.map((s) => ({ s, n: score(s) }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
        .map((x) => x.s)
    }
    return SETTINGS.filter((s) => s.section === SECTIONS[section()]!.name)
  })
  const current = () => visible()[Math.min(row(), visible().length - 1)]

  const write = (s: SettingDef, v: unknown) => {
    const path = scopePath(scope(), root)
    mkdirSync(dirname(path), { recursive: true })
    const changes = expand(s, v)
    let next = existsSync(path) ? readFileSync(path, "utf8") : ""
    try {
      for (const [key, val] of changes) next = setTomlValue(next, key, val)
    } catch (e) {
      ui.toast(`can't update ${path}: ${e instanceof Error ? e.message : String(e)}`, "error")
      return
    }
    // validate the whole file before writing so a bad value can't break the config
    let data: Record<string, unknown>
    try {
      data = Bun.TOML.parse(next) as Record<string, unknown>
    } catch (e) {
      ui.toast(`can't update ${path}: ${e instanceof Error ? e.message : String(e)}`, "error")
      return
    }
    const check = BatonConfig.safeParse(data)
    if (!check.success) {
      ui.toast(`invalid value for ${s.label}: ${check.error.issues[0]?.message ?? "?"}`, "error")
      return
    }
    writeFileSync(path, next)
    // you set these values yourself, so they don't need `baton trust`
    if (scope() !== "global")
      trustEntries(
        root,
        trustSurface(root, data).filter((e) => changes.some(([k]) => e.path === k)),
      )
    setTick((t) => t + 1)
    // apply live
    for (const [key] of changes) {
      const [sec, k] = key.split(".") as [string, string]
      const fresh = getPath(loaded().config, key)
      if (sec === "ui" && PREFS.has(k)) {
        ui.setPrefs(k as keyof Prefs, fresh as never)
        if (k === "theme" || k === "appearance") props.applyTheme(ui.prefs.theme)
      }
      ;(ui.setConfig as unknown as (a: string, b: string, c: unknown) => void)(sec, k, fresh)
    }
    ui.persistPrefs()
    ui.bump()
    if (s.key === "policy.autonomy") void ui.client?.call("run.autonomy", { mode: (v ?? "normal") as "normal" })
    if (!s.ui) void ui.client?.call("config.reload", {}).then((r) => r.errors.length && ui.toast(r.errors[0]!, "warn"))
    ui.toast(`${s.label}: ${formatValue(v ?? getPath(loaded().config, s.key))} → ${scope()} config`)
  }

  const cycle = (s: SettingDef, dir: 1 | -1) => {
    const v = value(s)
    const t = s.type
    const step = <T,>(opts: readonly T[]) => opts[(opts.indexOf(v as T) + dir + opts.length) % opts.length]
    switch (t.kind) {
      case "enum":
        return write(s, step(t.options))
      case "bool":
        return write(s, !v)
      case "theme":
        return write(s, step(["system", ...themes]))
      case "style":
        return write(s, step(STYLES.map((x) => x.name)))
      case "adapter":
        return write(s, step(ADAPTERS))
      case "model": {
        // "" = the agent's default; a typed name that isn't in the list still cycles from the start
        const opts = ["", ...modelsFor(ui.client, String(getPath(loaded().config, t.adapterKey) ?? ""))]
        const i = opts.indexOf((v as string | undefined) ?? "")
        const next = opts[(i + dir + opts.length) % opts.length]
        if (opts.length === 1) return ui.toast("this agent doesn't list its models: enter to type one", "info")
        return write(s, next || undefined)
      }
      case "number": {
        const n = typeof v === "number" ? v : (t.min ?? 0)
        const next = Math.max(t.min ?? Number.NEGATIVE_INFINITY, Math.min(t.max ?? Number.POSITIVE_INFINITY, Math.round((n + dir * (t.step ?? 1)) * 100) / 100))
        return write(s, next)
      }
      default:
        setTimeout(() => setEditing(s), 0)
    }
  }

  const commitEdit = (raw: string) => {
    const s = editing()
    setEditing(null)
    if (!s) return
    const text = raw.trim()
    const t = s.type
    if (t.kind === "number") {
      if (text === "" && t.optional) return write(s, undefined)
      const n = Number(text)
      if (!Number.isFinite(n)) return ui.toast("not a number", "error")
      return write(s, n)
    }
    if (t.kind === "list") {
      const items = text.split(/[,\s]+/).filter(Boolean)
      const bad = t.options ? items.filter((i) => !t.options!.includes(i)) : []
      if (bad.length) return ui.toast(`unknown: ${bad.join(", ")} (options: ${t.options!.join(", ")})`, "error")
      return write(s, items)
    }
    if (text === "" && (t.kind !== "string" || t.optional)) return write(s, undefined)
    if (t.kind === "model" && text === "") return write(s, undefined)
    write(s, text)
  }

  const open = (s: SettingDef) => {
    if (s.type.kind === "theme") {
      props.onClose()
      ui.setOverlay("theme")
    } else if (s.type.kind === "style") {
      props.onClose()
      ui.setOverlay("style")
    } else if (s.type.kind === "string" || s.type.kind === "number" || s.type.kind === "list" || s.type.kind === "model") setTimeout(() => setEditing(s), 0)
    else cycle(s, 1)
  }

  useKeyboard((k) => {
    if (editing()) {
      if (k.name === "escape") setEditing(null)
      return
    }
    if (filter() !== null && k.name !== "escape" && k.name !== "up" && k.name !== "down" && k.name !== "return" && k.name !== "enter") return
    const ks = keyString(k)
    const n = visible().length
    if (k.name === "escape") {
      if (filter() !== null) {
        setFilter(null)
        setRow(0)
      } else props.onClose()
      return
    }
    if (ks === "/") {
      // next tick: otherwise the "/" lands in the freshly focused search box
      setTimeout(() => {
        setFilter("")
        setRow(0)
      }, 0)
      return
    }
    // tab: sections ⇄ settings · s: which file changes are written to
    if (k.name === "tab") {
      setPane((p) => (p === "sections" ? "settings" : "sections"))
      return
    }
    if (ks === "s") return setScope((s) => (s === "project" ? "global" : "project"))
    if (pane() === "sections" && filter() === null) {
      if (k.name === "down" || ks === "j") setSection((i) => (i + 1) % SECTIONS.length)
      else if (k.name === "up" || ks === "k") setSection((i) => (i - 1 + SECTIONS.length) % SECTIONS.length)
      else if (k.name === "right" || ks === "l" || k.name === "return" || k.name === "enter") {
        setPane("settings")
        setRow(0)
      }
      return
    }
    const s = current()
    if (k.name === "down" || ks === "j") setRow((r) => (n ? (r + 1) % n : 0))
    else if (k.name === "up" || ks === "k") setRow((r) => (n ? (r - 1 + n) % n : 0))
    else if (
      (k.name === "left" || ks === "h") &&
      s &&
      (s.type.kind === "number" ||
        s.type.kind === "enum" ||
        s.type.kind === "theme" ||
        s.type.kind === "adapter" ||
        s.type.kind === "style" ||
        s.type.kind === "model")
    )
      cycle(s, -1)
    else if (k.name === "left" || ks === "h") setPane("sections")
    else if (!s) return
    else if (k.name === "right" || ks === "l" || ks === "space" || k.name === "space") cycle(s, 1)
    else if (k.name === "return" || k.name === "enter") open(s)
    else if (ks === "r") write(s, undefined)
  })

  const W = () => Math.min(120, dims().width - 4)
  const H = () => Math.min(36, dims().height - 2)
  const leftW = 27
  const rightW = () => W() - leftW - 7
  const bodyH = () => H() - 9

  const sectionLines = createMemo<Line[]>(() => {
    const t = ui.theme()
    const out: Line[] = SECTIONS.map((sec, i) => {
      const active = i === section() && filter() === null
      const focused = pane() === "sections" && active
      const bg = focused ? t.selection : undefined
      const count = SETTINGS.filter((s) => s.section === sec.name).length
      return {
        bg,
        segs: [
          { text: active ? "▌" : " ", fg: t.primary, bg },
          { text: ` ${sec.icon} `, fg: active ? t.primary : t.textSubtle, bg },
          { text: clip(sec.name, leftW - 9).padEnd(leftW - 8), fg: active ? t.text : t.textMuted, bold: active, bg },
          { text: String(count).padStart(3), fg: t.textSubtle, bg },
        ],
      }
    })
    out.push({ segs: [] })
    const quick: [string, string][] = [
      ["ctrl+t", "themes"],
      ["/style", "style gallery"],
      ["shift+tab", "autonomy"],
    ]
    out.push({ segs: [{ text: "  quick keys", fg: t.textSubtle }] })
    for (const [key, what] of quick) out.push({ segs: [{ text: "  " }, keycap(t, key), { text: ` ${what}`, fg: t.textMuted }] })
    return out
  })

  // every control starts with the 2-column slot choices use for their ‹ › arrows
  const control = (s: SettingDef, active: boolean, width: number): Seg[] => {
    const c = rawControl(s, active, width - 2)
    return s.type.kind === "enum" ? c : [{ text: "  " }, ...c]
  }
  const rawControl = (s: SettingDef, active: boolean, width: number): Seg[] => {
    const t = ui.theme()
    const v = value(s)
    const ty = s.type
    switch (ty.kind) {
      case "bool":
        return toggle(t, !!v, active)
      case "enum": {
        const idx = ty.options.indexOf(String(v))
        const label = ty.labels?.[String(v)] ?? String(v ?? "—")
        const color = s.key === "policy.autonomy" ? (v === "yolo" ? t.error : v === "auto" ? t.warning : v === "ask" ? t.info : t.accent) : t.accent
        const widest = Math.max(...ty.options.map((o) => sw(ty.labels?.[o] ?? o)))
        return choice(t, label, Math.max(0, idx), ty.options.length, active, color, widest)
      }
      case "number": {
        const unit = ty.unit ? (ty.unit === "$" ? "" : ` ${ty.unit}`) : ""
        const shown = v === undefined || v === null ? "—" : `${ty.unit === "$" ? "$" : ""}${v}${unit}`
        if (typeof v === "number" && ty.min !== undefined && ty.max !== undefined && width >= 22)
          return [...slider(t, v, ty.min, ty.max, 10), { text: `  ${shown}`, fg: t.accent, bold: active }]
        return [{ text: shown, fg: v === undefined ? t.textSubtle : t.accent, bold: active }]
      }
      case "theme":
        return [{ text: String(v), fg: t.accent, bold: active }, { text: "  " }, ...swatch(t), { text: active ? "   enter: gallery" : "", fg: t.textSubtle }]
      case "style": {
        const st = STYLES.find((x) => x.name === v)
        return [
          { text: st?.title ?? String(v), fg: t.accent, bold: active },
          { text: `  ${clip(st ? st.description : "your own mix of frames, borders and status bar", Math.max(0, width - 14))}`, fg: t.textSubtle },
        ]
      }
      case "adapter": {
        const look = agentLook(ui, { adapter: String(v), name: String(v) })
        return [
          { text: `${look.glyph} `, fg: look.color, bold: true },
          { text: String(v), fg: t.accent, bold: active },
        ]
      }
      case "list": {
        const items = Array.isArray(v) ? (v as string[]) : []
        if (!items.length) return [{ text: "none", fg: t.textSubtle }]
        return items.flatMap((x, i) => [
          { text: i ? " " : "" },
          { text: ` ${x} `, fg: t.text, bg: t.backgroundElement === "transparent" ? undefined : t.backgroundElement },
        ])
      }
      default: {
        const str = v === undefined || v === null || v === "" ? undefined : String(v)
        return str
          ? [{ text: clip(str, width), fg: t.accent, bold: active }]
          : [{ text: (ty as { placeholder?: string }).placeholder ?? "—", fg: t.textSubtle, italic: true }]
      }
    }
  }

  const settingLines = createMemo<Line[]>(() => {
    tick()
    ui.version()
    const t = ui.theme()
    const rw = rightW()
    const labelW = 24
    const srcW = 13
    const list = visible()
    const out: Line[] = []
    if (filter() === null) {
      const sec = SECTIONS[section()]!
      out.push({ segs: [{ text: `${sec.icon} ${sec.name}`, fg: t.primary, bold: true }] })
      for (const l of wrap(sec.blurb, rw).slice(0, 2)) out.push({ segs: [{ text: l, fg: t.textMuted }] })
      out.push({ segs: [] })
    } else {
      out.push({ segs: [{ text: `${list.length} match${list.length === 1 ? "" : "es"}`, fg: t.textMuted }] })
      out.push({ segs: [] })
    }
    const height = bodyH() - out.length
    const sel = Math.min(row(), list.length - 1)
    const start = Math.max(0, Math.min(sel - Math.floor(height / 2), list.length - height))
    for (const [i, s] of list.slice(start, start + height).entries()) {
      const active = start + i === sel && pane() === "settings"
      const bg = active ? t.selection : undefined
      const src = source(s)
      const changed = src !== "default"
      const ctrlW = rw - labelW - srcW - 3
      const ctrl = control(s, active, ctrlW).map((x) => ({ ...x, bg: x.bg ?? bg }))
      const ctrlUsed = ctrl.reduce((n, x) => n + sw(x.text), 0)
      const prefix = filter() !== null ? `${SECTIONS.find((x) => x.name === s.section)?.icon ?? " "} ` : ""
      const gap = Math.max(1, rw - 2 - labelW - Math.min(ctrlUsed, ctrlW) - srcW)
      out.push({
        bg,
        segs: [
          { text: changed ? "• " : "  ", fg: t.accent, bg },
          { text: clip(`${prefix}${s.label}`, labelW - 1).padEnd(labelW), fg: active ? t.text : t.textMuted, bold: active, bg },
          ...ctrl,
          { text: " ".repeat(gap), bg },
          { text: changed ? clip(src, srcW).padStart(srcW) : " ".repeat(srcW), fg: src.startsWith("this") ? t.warning : t.info, bg },
        ],
      })
    }
    if (!list.length) out.push({ segs: [{ text: "no matching settings", fg: t.textMuted }] })
    return out
  })

  const helpLines = createMemo<Line[]>(() => {
    const t = ui.theme()
    const s = current()
    if (!s) return []
    const src = source(s)
    return [
      {
        segs: [
          { text: s.label, fg: t.text, bold: true },
          { text: `  ${s.key}`, fg: t.textSubtle },
          { text: src === "default" ? "  · default" : `  · set in ${src}`, fg: src === "default" ? t.textSubtle : t.info },
        ],
      },
      ...wrap(s.help, W() - 4)
        .slice(0, s.type.kind === "model" ? 2 : 3)
        .map((l) => ({ segs: [{ text: l, fg: t.textMuted }] })),
      ...(s.type.kind === "model" ? [modelLine(s.type.adapterKey)] : []),
    ]
  })

  /** "codex offers: gpt-5, gpt-5-mini, …" under a model setting. */
  const modelLine = (adapterKey: string): Line => {
    const t = ui.theme()
    const adapter = String(getPath(loaded().config, adapterKey) ?? "")
    const list = modelsFor(ui.client, adapter)
    return {
      segs: [
        { text: `${adapter} offers: `, fg: t.textSubtle },
        { text: clip(list.length ? list.join(", ") : "no list (type any model name)", Math.max(0, W() - 8 - adapter.length - 9)), fg: t.info },
      ],
    }
  }

  const hint = () => {
    const s = current()
    if (editing()) return "enter save · empty = unset · esc cancel"
    if (pane() === "sections") return "↑↓ section · → settings · / search · esc close"
    const kind = s?.type.kind
    const change =
      kind === "bool"
        ? "space toggle"
        : kind === "theme" || kind === "style"
          ? "←→ change · enter gallery"
          : kind === "number" || kind === "model"
            ? `←→ ${kind === "model" ? "pick" : "adjust"} · enter type`
            : kind === "string" || kind === "list"
              ? "enter edit"
              : "←→ change"
    return `↑↓ move · ${change} · r reset · s scope · / search · esc`
  }

  const header = (): Line[] => {
    const t = ui.theme()
    const f = filter()
    const crumb = f !== null ? `search: ${f}` : `${SECTIONS[section()]!.icon} ${SECTIONS[section()]!.name}${current() ? `  ›  ${current()!.label}` : ""}`
    const scopeSegs: Seg[] = [
      { text: "save to ", fg: t.textMuted },
      { text: scope() === "project" ? "◉ project" : "○ project", fg: scope() === "project" ? t.accent : t.textSubtle, bold: scope() === "project" },
      { text: "  " },
      { text: scope() === "global" ? "◉ global" : "○ global", fg: scope() === "global" ? t.accent : t.textSubtle, bold: scope() === "global" },
      { text: "  " },
      keycap(t, "s"),
    ]
    const sw2 = scopeSegs.reduce((n, x) => n + sw(x.text), 0)
    return [
      {
        segs: [
          { text: clip(crumb, W() - 8 - sw2), fg: t.text, bold: true },
          { text: " ".repeat(Math.max(1, W() - 4 - sw(clip(crumb, W() - 8 - sw2)) - sw2)) },
          ...scopeSegs,
        ],
      },
    ]
  }

  const rule = () => toStyled([{ segs: [{ text: "─".repeat(Math.max(0, W() - 4)), fg: ui.theme().borderSubtle }] }], W() - 4)

  return (
    <Modal title="Settings" width={W()} height={H()} hint={hint()}>
      <Show when={filter() !== null} fallback={<Txt value={toStyled(header(), W() - 4)} />}>
        <box height={1} flexDirection="row">
          <Txt value={toStyled([{ segs: [{ text: "/ ", fg: ui.theme().primary, bold: true }] }], 2)} />
          <input
            flexGrow={1}
            focused
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            textColor={ui.theme().text}
            focusedTextColor={ui.theme().text}
            placeholder="search settings — try 'yolo', 'background', 'budget'…"
            onInput={(v: string) => {
              setFilter(v)
              setRow(0)
              setPane("settings")
            }}
            onSubmit={
              (() => {
                // Enter in the search box acts on the highlighted result
                const s = current()
                if (s) open(s)
              }) as never
            }
          />
        </box>
      </Show>
      <Txt value={rule()} />
      <box flexDirection="row" height={bodyH()}>
        <box width={leftW} flexDirection="column">
          <Txt value={toStyled(sectionLines(), leftW, bodyH())} />
        </box>
        <Txt
          value={toStyled(
            Array.from({ length: bodyH() }, () => ({ segs: [{ text: "│ ", fg: ui.theme().borderSubtle }] })),
            2,
          )}
        />
        <box width={rightW() + 2} paddingLeft={1}>
          <Txt value={toStyled(settingLines(), rightW(), bodyH())} />
        </box>
      </box>
      <Txt value={rule()} />
      <Show when={editing()} fallback={<Txt value={toStyled(helpLines(), W() - 4, 4)} height={4} />}>
        <box height={1} flexDirection="row">
          <Txt value={toStyled([{ segs: [{ text: `${editing()!.label}: `, fg: ui.theme().primary, bold: true }] }], editing()!.label.length + 2)} />
          <input
            ref={(r: InputRenderable) => {
              editRef = r
              const v = value(editing()!)
              r.value = v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v)
            }}
            flexGrow={1}
            focused
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            textColor={ui.theme().text}
            focusedTextColor={ui.theme().text}
            placeholder={(editing()!.type as { placeholder?: string }).placeholder ?? ""}
            onSubmit={((v: unknown) => commitEdit(typeof v === "string" ? v : (editRef?.value ?? ""))) as never}
          />
        </box>
        <Txt value={toStyled([{ segs: [{ text: "enter save · empty = unset · esc cancel", fg: ui.theme().textSubtle }] }], W() - 4)} />
      </Show>
    </Modal>
  )
}
