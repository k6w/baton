/**
 * Settings screen: every setting, grouped by section, showing the effective value and which
 * layer set it. Edits are written to the project or global config file (comments preserved);
 * appearance changes apply instantly, agent-side ones are reloaded into the daemon.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BatonConfig, configDir, getPath, loadConfig, projectPaths, SETTING_SECTIONS, SETTINGS, type SettingDef, setTomlValue } from "@batonsh/kernel"
import { listThemes } from "@batonsh/themes"
import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Show } from "solid-js"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { clip, type Line, type Seg, width as sw, wrap } from "../lines.ts"
import type { Prefs } from "../state.ts"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
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
const PREF_KEYS = new Set(["theme", "appearance", "layout", "icons", "border", "density", "render_style", "show_bus", "show_thoughts", "animations", "spinner"])

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
  let searchRef: InputRenderable | undefined
  const themes = listThemes({ global: join(configDir(), "themes"), project: join(projectPaths(root).dir, "themes") }).map((t) => t.name)

  // fresh config + provenance from disk (re-read after every write)
  const loaded = createMemo(() => {
    tick()
    return loadConfig({ projectRoot: root })
  })
  const value = (s: SettingDef): unknown => {
    const k = s.key.split(".")[1] as string
    if (s.key.startsWith("ui.") && PREF_KEYS.has(k)) return (ui.prefs as Record<string, unknown>)[k]
    return getPath(loaded().config, s.key)
  }
  const source = (s: SettingDef): string => {
    const k = s.key.split(".")[1] as string
    const fromFile = loaded().provenance[s.key]
    if (s.key.startsWith("ui.") && PREF_KEYS.has(k) && getPath(loaded().config, s.key) !== value(s)) return "session"
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
    return SETTINGS.filter((s) => s.section === SETTING_SECTIONS[section()])
  })
  const current = () => visible()[Math.min(row(), visible().length - 1)]

  const write = (s: SettingDef, v: unknown) => {
    const path = scopePath(scope(), root)
    mkdirSync(dirname(path), { recursive: true })
    const text = existsSync(path) ? readFileSync(path, "utf8") : ""
    const next = setTomlValue(text, s.key, v)
    // validate the whole file before writing so a bad value can't break the config
    const check = BatonConfig.safeParse(Bun.TOML.parse(next))
    if (!check.success) {
      ui.toast(`invalid value for ${s.label}: ${check.error.issues[0]?.message ?? "?"}`, "error")
      return
    }
    writeFileSync(path, next)
    setTick((t) => t + 1)
    // apply live
    const [sec, key] = s.key.split(".") as [string, string]
    if (sec === "ui" && PREF_KEYS.has(key)) {
      ui.setPrefs(key as keyof Prefs, (v ?? getPath(loaded().config, s.key)) as never)
      ui.persistPrefs()
      if (key === "theme" || key === "appearance") props.applyTheme(ui.prefs.theme)
    }
    const fresh = getPath(loaded().config, s.key)
    // biome-ignore lint/suspicious/noExplicitAny: path-based store update
    ;(ui.setConfig as any)(sec, key, fresh)
    ui.bump()
    if (!s.ui) void ui.client?.call("config.reload", {}).then((r) => r.errors.length && ui.toast(r.errors[0]!, "warn"))
    ui.toast(`${s.label}: ${formatValue(v ?? fresh)} (${scope()})`)
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
      case "adapter":
        return write(s, step(ADAPTERS))
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
    write(s, text)
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
      if (k.name === "down" || ks === "j") setSection((i) => (i + 1) % SETTING_SECTIONS.length)
      else if (k.name === "up" || ks === "k") setSection((i) => (i - 1 + SETTING_SECTIONS.length) % SETTING_SECTIONS.length)
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
      (s.type.kind === "number" || s.type.kind === "enum" || s.type.kind === "theme" || s.type.kind === "adapter")
    )
      cycle(s, -1)
    else if (k.name === "left" || ks === "h") setPane("sections")
    else if (!s) return
    else if (k.name === "right" || ks === "l" || ks === "space" || k.name === "space") cycle(s, 1)
    else if (k.name === "return" || k.name === "enter") {
      if (s.type.kind === "theme") {
        props.onClose()
        ui.setOverlay("theme")
      } else if (s.type.kind === "string" || s.type.kind === "number" || s.type.kind === "list") setTimeout(() => setEditing(s), 0)
      else cycle(s, 1)
    } else if (ks === "r") write(s, undefined)
  })

  const W = () => Math.min(110, dims().width - 4)
  const H = () => Math.min(30, dims().height - 2)
  const leftW = 20
  const rightW = () => W() - leftW - 5

  const sectionLines = createMemo<Line[]>(() => {
    const t = ui.theme()
    return SETTING_SECTIONS.map((name, i) => {
      const active = i === section() && filter() === null
      const focused = pane() === "sections" && active
      return {
        bg: focused ? t.selection : undefined,
        segs: [{ text: `${active ? "▸ " : "  "}${name}`, fg: active ? t.text : t.textMuted, bold: active, bg: focused ? t.selection : undefined }],
      }
    })
  })

  const settingLines = createMemo<Line[]>(() => {
    tick()
    ui.version()
    const t = ui.theme()
    const rw = rightW()
    const labelW = 22
    const srcW = 9
    const list = visible()
    const height = H() - 8
    const sel = Math.min(row(), list.length - 1)
    const start = Math.max(0, Math.min(sel - Math.floor(height / 2), list.length - height))
    return list.slice(start, start + height).map((s, i) => {
      const active = start + i === sel && pane() === "settings"
      const bg = active ? t.selection : undefined
      const src = source(s)
      const v = formatValue(value(s))
      const valW = rw - labelW - srcW - 4
      const val: Seg =
        s.type.kind === "bool"
          ? { text: value(s) ? "● on" : "○ off", fg: value(s) ? t.success : t.textMuted, bg }
          : { text: clip(v, valW), fg: v === "—" ? t.textSubtle : t.accent, bg }
      const gap = Math.max(1, rw - labelW - sw(val.text) - srcW - 2)
      return {
        bg,
        segs: [
          { text: clip(s.label, labelW - 1).padEnd(labelW), fg: active ? t.text : t.textMuted, bold: active, bg },
          val,
          { text: " ".repeat(gap), bg },
          { text: src.padStart(srcW), fg: src === "default" ? t.textSubtle : src === "session" ? t.warning : t.info, bg },
        ],
      }
    })
  })

  const helpLines = createMemo<Line[]>(() => {
    const t = ui.theme()
    const s = current()
    if (!s) return [{ segs: [{ text: filter() !== null ? "no matching settings" : "", fg: t.textMuted }] }]
    const kindHint =
      s.type.kind === "enum" || s.type.kind === "theme" || s.type.kind === "adapter"
        ? "←→ / space change"
        : s.type.kind === "bool"
          ? "space toggle"
          : s.type.kind === "number"
            ? "←→ adjust · enter type a value"
            : "enter edit"
    return [
      {
        segs: [
          { text: s.key, fg: t.textSubtle },
          { text: `   ${kindHint} · r reset`, fg: t.textSubtle },
        ],
      },
      ...wrap(s.help, W() - 4)
        .slice(0, 2)
        .map((l) => ({ segs: [{ text: l, fg: t.textMuted }] })),
    ]
  })

  const header = (): Line[] => {
    const t = ui.theme()
    const f = filter()
    return [
      {
        segs: [
          { text: f !== null ? `/ ${f}` : "Settings apply instantly where possible.", fg: f !== null ? t.text : t.textMuted },
          { text: " ".repeat(Math.max(1, W() - 4 - (f !== null ? f.length + 2 : 40) - 28)) },
          { text: "write to: ", fg: t.textMuted },
          { text: scope() === "project" ? "▸project" : " project", fg: scope() === "project" ? t.accent : t.textSubtle, bold: scope() === "project" },
          { text: scope() === "global" ? " ▸global" : "  global", fg: scope() === "global" ? t.accent : t.textSubtle, bold: scope() === "global" },
        ],
      },
    ]
  }

  return (
    <Modal title="Settings" width={W()} height={H()} hint="↑↓ select · ←→ change · enter edit · / search · tab sections · s scope · r reset · esc">
      <Show when={filter() !== null} fallback={<Txt value={toStyled(header(), W() - 4)} />}>
        <box height={1} flexDirection="row">
          <Txt value={toStyled([{ segs: [{ text: "/ ", fg: ui.theme().primary }] }], 2)} />
          <input
            flexGrow={1}
            focused
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            textColor={ui.theme().text}
            focusedTextColor={ui.theme().text}
            placeholder="search settings…"
            ref={(r: InputRenderable) => {
              searchRef = r
            }}
            onInput={(v: string) => {
              setFilter(v)
              setRow(0)
              setPane("settings")
            }}
            onSubmit={
              (() => {
                // Enter in the search box acts on the highlighted result
                const s = current()
                if (!s) return
                if (s.type.kind === "string" || s.type.kind === "number" || s.type.kind === "list") setTimeout(() => setEditing(s), 0)
                else cycle(s, 1)
              }) as never
            }
          />
        </box>
      </Show>
      <Txt value={toStyled([{ segs: [{ text: "─".repeat(Math.max(0, W() - 4)), fg: ui.theme().borderSubtle }] }], W() - 4)} />
      <box flexDirection="row" height={H() - 8}>
        <box width={leftW} flexDirection="column">
          <Txt value={toStyled(sectionLines(), leftW, H() - 8)} />
        </box>
        <Txt
          value={toStyled(
            Array.from({ length: H() - 8 }, () => ({ segs: [{ text: "│ ", fg: ui.theme().borderSubtle }] })),
            2,
          )}
        />
        <box width={rightW() + 2} paddingLeft={1}>
          <Txt value={toStyled(settingLines(), rightW(), H() - 8)} />
        </box>
      </box>
      <Txt value={toStyled([{ segs: [{ text: "─".repeat(Math.max(0, W() - 4)), fg: ui.theme().borderSubtle }] }], W() - 4)} />
      <Show when={editing()} fallback={<Txt value={toStyled(helpLines(), W() - 4, 3)} height={3} />}>
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
