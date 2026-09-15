/** Modal overlays: command palette, theme picker, approvals inbox, help. */

import { join } from "node:path"
import { configDir, projectBatonDir } from "@batonsh/kernel"
import { listThemes, loadTheme } from "@batonsh/themes"
import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { clip, type Line, type Seg, width as sw, wrap } from "../lines.ts"
import { segs, toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"

export interface PaletteItem {
  id: string
  label: string
  detail?: string
  keys?: string
  run: () => void
}

export function Modal(props: { title: string; width: number; height: number; children: JSX.Element; hint?: string }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const w = () => Math.min(props.width, dims().width - 4)
  const h = () => Math.min(props.height, dims().height - 2)
  return (
    <box
      position="absolute"
      left={Math.max(0, Math.floor((dims().width - w()) / 2))}
      top={Math.max(0, Math.floor((dims().height - h()) / 3))}
      width={w()}
      height={h()}
      zIndex={100}
      border
      borderStyle={ui.prefs.border === "none" || ui.prefs.border === "ascii" ? "single" : ui.prefs.border}
      borderColor={ui.theme().borderActive}
      backgroundColor={ui.theme().backgroundOverlay}
      title={` ${props.title} `}
      titleColor={ui.theme().text}
      bottomTitle={props.hint ? ` ${props.hint} ` : undefined}
      bottomTitleAlignment="right"
      paddingLeft={1}
      paddingRight={1}
      flexDirection="column"
    >
      {props.children}
    </box>
  )
}

function fuzzy(q: string, s: string): number {
  if (!q) return 1
  const a = q.toLowerCase()
  const b = s.toLowerCase()
  if (b.includes(a)) return 100 - b.indexOf(a)
  let i = 0
  let score = 0
  for (const ch of b) {
    if (ch === a[i]) {
      i++
      score++
      if (i === a.length) return score
    }
  }
  return 0
}

export function ListView(props: { items: { label: Seg[]; detail?: string; right?: string }[]; selected: number; width: number; height: number }) {
  const ui = useUi()
  // a single padded text block — per-row reactive texts accumulate stale chunks on update
  const lines = (): Line[] => {
    const t = ui.theme()
    const start = Math.max(0, Math.min(props.selected - Math.floor(props.height / 2), props.items.length - props.height))
    return props.items.slice(start, start + props.height).map((it, i) => {
      const active = start + i === props.selected
      const bg = active ? t.selection : undefined
      const right = it.right ?? ""
      const labelW = it.label.reduce((n, s) => n + sw(s.text), 0)
      const detail = it.detail ? clip(` ${it.detail}`, Math.max(0, props.width - labelW - sw(right) - 6)) : ""
      const gap = Math.max(1, props.width - 2 - labelW - sw(detail) - sw(right))
      return {
        bg,
        segs: [
          { text: active ? "› " : "  ", fg: t.primary, bg },
          ...it.label.map((s) => ({ ...s, bg, bold: active || s.bold })),
          { text: detail, fg: t.textMuted, bg },
          { text: " ".repeat(gap), bg },
          { text: right, fg: t.textSubtle, bg },
        ],
      }
    })
  }
  return <Txt height={props.height} wrapMode="none" value={toStyled(lines(), props.width, props.height)} />
}

export function CommandPalette(props: { items: PaletteItem[]; onClose: () => void }) {
  const ui = useUi()
  const [query, setQuery] = createSignal("")
  const [sel, setSel] = createSignal(0)
  const filtered = createMemo(() =>
    props.items
      .map((it) => ({ it, s: Math.max(fuzzy(query(), it.label), fuzzy(query(), it.detail ?? "") / 2) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.it),
  )
  useKeyboard((k) => {
    const n = filtered().length
    if (k.name === "escape") props.onClose()
    else if (k.name === "down" || (k.ctrl && k.name === "n")) setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "up" || (k.ctrl && k.name === "p")) setSel((s) => (n ? (s - 1 + n) % n : 0))
  })
  const width = 72
  return (
    <Modal title="Commands" width={width} height={22} hint="↑↓ select · enter run · esc close">
      <box height={1} flexDirection="row">
        <Txt wrapMode="none" value={segs({ text: "› ", fg: ui.theme().primary, bold: true })} />
        <input
          flexGrow={1}
          focused
          placeholder="type to search commands, themes, agents…"
          backgroundColor="transparent"
          focusedBackgroundColor="transparent"
          textColor={ui.theme().text}
          focusedTextColor={ui.theme().text}
          placeholderColor={ui.theme().textSubtle}
          onInput={(v: string) => {
            setQuery(v)
            setSel(0)
          }}
          onSubmit={() => {
            const it = filtered()[sel()]
            props.onClose()
            it?.run()
          }}
        />
      </box>
      <Txt wrapMode="none" value={segs({ text: "─".repeat(width - 4), fg: ui.theme().borderSubtle })} />
      <ListView
        items={filtered().map((it) => ({ label: [{ text: it.label, fg: ui.theme().text }], detail: it.detail, right: it.keys }))}
        selected={sel()}
        width={width - 4}
        height={17}
      />
    </Modal>
  )
}

export function ThemePicker(props: { onClose: () => void; onPick: (name: string) => void }) {
  const ui = useUi()
  const dirs = { global: join(configDir(), "themes"), project: ui.run.projectRoot ? join(projectBatonDir(ui.run.projectRoot), "themes") : undefined }
  const themes = listThemes(dirs)
  const original = ui.theme()
  const startIdx = Math.max(
    0,
    themes.findIndex((t) => t.name === ui.prefs.theme),
  )
  const [sel, setSel] = createSignal(startIdx)
  const preview = (i: number) => {
    const t = themes[i]
    if (!t) return
    ui.setTheme(loadTheme(t.name, { appearance: t.appearance ?? ui.prefs.appearance, dirs }))
  }
  let done = false
  onCleanup(() => {
    if (!done) ui.setTheme(original)
  })
  useKeyboard((k) => {
    const n = themes.length
    if (k.name === "escape") {
      ui.setTheme(original)
      done = true
      props.onClose()
    } else if (k.name === "down" || k.name === "j") {
      const i = (sel() + 1) % n
      setSel(i)
      preview(i)
    } else if (k.name === "up" || k.name === "k") {
      const i = (sel() - 1 + n) % n
      setSel(i)
      preview(i)
    } else if (k.name === "return" || k.name === "enter") {
      done = true
      props.onPick(themes[sel()]!.name)
      props.onClose()
    }
  })
  const swatch = (name: string): Seg[] => {
    const entry = themes.find((t) => t.name === name)
    if (!entry) return []
    const t = loadTheme(name, { appearance: entry.appearance, dirs })
    return ["primary", "accent", "success", "warning", "error", "agentClaude"].map((k) => ({ text: "■", fg: (t as Record<string, string>)[k] }))
  }
  return (
    <Modal title="Theme" width={56} height={24} hint="↑↓ preview · enter keep · esc revert">
      <ListView
        items={themes.map((t) => ({
          label: [...swatch(t.name), { text: `  ${t.name}`, fg: ui.theme().text }],
          right: t.source === "builtin" ? (t.appearance ?? "") : t.source,
        }))}
        selected={sel()}
        width={52}
        height={21}
      />
    </Modal>
  )
}

export function ApprovalsInbox(props: { onClose: () => void }) {
  const ui = useUi()
  const [sel, setSel] = createSignal(0)
  const pending = createMemo(() => {
    ui.version()
    return [...ui.run.approvals.values()].sort((a, b) => a.ts - b.ts)
  })
  const respond = async (kind: "allow_once" | "allow_always" | "reject_once" | "reject_always") => {
    const p = pending()[sel()]
    if (!p || !ui.client) return
    const opt = p.options.find((o) => o.kind === kind) ?? p.options.find((o) => o.kind.startsWith(kind.split("_")[0]!))
    try {
      await ui.client.respond(p.agentId, p.requestId, opt?.optionId ?? null)
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error")
    }
    if (pending().length <= 1) props.onClose()
  }
  useKeyboard((k) => {
    const n = pending().length
    const ks = keyString(k)
    if (k.name === "escape") props.onClose()
    else if (k.name === "down" || k.name === "j") setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "up" || k.name === "k") setSel((s) => (n ? (s - 1 + n) % n : 0))
    else if (ks === "a" || k.name === "return" || k.name === "enter" || ks === "y") void respond("allow_once")
    else if (ks === "shift+a") void respond("allow_always")
    else if (ks === "d" || ks === "n") void respond("reject_once")
    else if (ks === "shift+d") void respond("reject_always")
  })
  const detail = createMemo(() => {
    const p = pending()[sel()]
    if (!p) return []
    const t = ui.theme()
    const a = ui.run.agents.get(p.agentId)
    const lines: Seg[][] = [[{ text: `${a?.name ?? "agent"} wants to:`, fg: t.textMuted }], [{ text: p.title, fg: t.text, bold: true }]]
    if (p.detail) for (const l of wrap(p.detail, 66).slice(0, 6)) lines.push([{ text: l, fg: t.textMuted }])
    lines.push([{ text: p.options.map((o) => o.name).join(" · "), fg: t.textSubtle }])
    return lines
  })
  return (
    <Modal title={`Approvals (${pending().length})`} width={74} height={22} hint="a allow · A always · d deny · D never · esc">
      <Show when={pending().length > 0} fallback={<Txt value={segs({ text: "Nothing pending.", fg: ui.theme().textMuted })} />}>
        <ListView
          items={pending().map((p) => {
            const a = ui.run.agents.get(p.agentId)
            const look = a ? agentLook(ui, a) : undefined
            return {
              label: [
                { text: `${look?.glyph ?? "●"} `, fg: look?.color ?? ui.theme().text },
                { text: (a?.name ?? "agent").padEnd(12), fg: ui.theme().text },
                { text: p.title, fg: ui.theme().text },
              ],
              right: p.kind ?? "",
            }
          })}
          selected={sel()}
          width={70}
          height={Math.min(10, Math.max(1, pending().length))}
        />
        <Txt wrapMode="none" value={segs({ text: "─".repeat(70), fg: ui.theme().borderSubtle })} />
        <For each={detail()}>{(l) => <Txt wrapMode="word" value={segs(...l)} />}</For>
      </Show>
    </Modal>
  )
}

export function HelpOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q" || k.name === "?") props.onClose()
  })
  const lines = () => {
    const t = ui.theme()
    const out: Seg[][] = []
    const groups: [string, string][] = [
      ["global", "Everywhere"],
      ["input", "While typing"],
      ["grid", "Agent grid (tab to focus)"],
      ["zoom", "Zoomed agent"],
    ]
    for (const [ctx, title] of groups) {
      out.push([{ text: title, fg: t.primary, bold: true }])
      for (const c of ui.keymap.commands.filter((x) => x.context === ctx && x.keys.length)) {
        out.push([
          { text: `  ${c.keys.join(", ").padEnd(22)}`, fg: t.text },
          { text: c.title, fg: t.textMuted },
        ])
      }
    }
    out.push([{ text: "Input", fg: t.primary, bold: true }])
    out.push([
      { text: "  @name text".padEnd(24), fg: t.text },
      { text: "talk to one agent directly (@all, @role:x)", fg: t.textMuted },
    ])
    out.push([
      { text: "  !name".padEnd(24), fg: t.text },
      { text: "interrupt an agent (!all)", fg: t.textMuted },
    ])
    out.push([
      { text: "  /command".padEnd(24), fg: t.text },
      { text: "/spawn /kill /mode /theme /layout … (tab completes)", fg: t.textMuted },
    ])
    const conflicts = ui.keymap.conflicts()
    if (conflicts.length) {
      out.push([{ text: "Conflicting bindings", fg: t.warning, bold: true }])
      for (const c of conflicts) out.push([{ text: `  ${c}`, fg: t.warning }])
    }
    return out
  }
  return (
    <Modal title="Keyboard shortcuts" width={78} height={Math.min(40, lines().length + 3)} hint="esc close · rebind any key in config [keys]">
      <For each={lines()}>{(l) => <Txt wrapMode="none" value={segs(...l)} />}</For>
    </Modal>
  )
}

export function Toasts(props: { width: number }) {
  const ui = useUi()
  return (
    <Show when={ui.toasts().length > 0}>
      <box position="absolute" right={1} bottom={1} zIndex={90} flexDirection="column" width={Math.min(60, props.width - 2)}>
        <For each={ui.toasts()}>
          {(t) => {
            const th = ui.theme()
            const color = t.level === "error" ? th.error : t.level === "warn" ? th.warning : th.info
            return (
              <box border borderStyle="rounded" borderColor={color} backgroundColor={th.backgroundOverlay} paddingLeft={1} paddingRight={1}>
                <Txt wrapMode="word" value={segs({ text: t.text, fg: th.text })} />
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

export type { InputRenderable }
