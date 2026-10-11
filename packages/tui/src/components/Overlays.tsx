/** Modal overlays: command palette, approvals inbox, help. */

import { type AttentionItem, type AttentionKind, attentionItems } from "@batonsh/kernel"
import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { clip, type Line, type Seg, width as sw, wrap } from "../lines.ts"
import { segs, toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { keycap } from "../ui/widgets.ts"

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

const KIND_STYLE: Record<AttentionKind, { glyph: string; token: "warning" | "error" | "info" | "success" | "accent" }> = {
  approval: { glyph: "?", token: "warning" },
  plan: { glyph: "◆", token: "warning" },
  failed: { glyph: "✗", token: "error" },
  conflict: { glyph: "▲", token: "warning" },
  merge: { glyph: "✗", token: "error" },
  budget: { glyph: "$", token: "error" },
  stalled: { glyph: "‖", token: "warning" },
  looping: { glyph: "↻", token: "warning" },
  scope: { glyph: "↗", token: "warning" },
  ready: { glyph: "✓", token: "success" },
}

export function attentionGlyph(kind: AttentionKind): { glyph: string; token: "warning" | "error" | "info" | "success" | "accent" } {
  return KIND_STYLE[kind]
}

/**
 * Inbox: everything waiting on you across all agents — approvals (answer in place), plans,
 * failures, conflicts, stuck agents, finished work to merge. Enter jumps to the item.
 */
export function Inbox(props: { onClose: () => void; onJump: (item: AttentionItem) => void }) {
  const ui = useUi()
  const [sel, setSel] = createSignal(0)
  const items = createMemo(() => {
    ui.version()
    return attentionItems(ui.run)
  })
  const current = () => items()[Math.min(sel(), items().length - 1)]
  const selClamped = () => Math.max(0, Math.min(sel(), items().length - 1))
  const respond = async (kind: "allow_once" | "allow_always" | "reject_once" | "reject_always") => {
    const it = current()
    if (it?.kind !== "approval" || !ui.client) return
    const p = ui.run.approvals.get(it.requestId!)
    if (!p) return
    const opt = p.options.find((o) => o.kind === kind) ?? p.options.find((o) => o.kind.startsWith(kind.split("_")[0]!))
    try {
      await ui.client.respond(p.agentId, p.requestId, opt?.optionId ?? null)
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error")
    }
    // only close if the inbox is still what's open (the user may have moved on meanwhile)
    if (items().length <= 1 && ui.overlay() === "inbox") props.onClose()
  }
  useKeyboard((k) => {
    const n = items().length
    const ks = keyString(k)
    const it = current()
    if (k.name === "escape") props.onClose()
    else if (k.name === "down" || k.name === "j") setSel((s) => (n ? (s + 1) % n : 0))
    else if (k.name === "up" || k.name === "k") setSel((s) => (n ? (s - 1 + n) % n : 0))
    else if (!it) return
    else if (it.kind === "approval" && (ks === "a" || ks === "y")) void respond("allow_once")
    else if (it.kind === "approval" && ks === "shift+a") void respond("allow_always")
    else if (it.kind === "approval" && (ks === "d" || ks === "n")) void respond("reject_once")
    else if (it.kind === "approval" && ks === "shift+d") void respond("reject_always")
    else if (k.name === "return" || k.name === "enter") {
      if (it.kind === "approval") void respond("allow_once")
      else {
        props.onClose()
        props.onJump(it)
      }
    }
  })
  const detail = createMemo(() => {
    const it = current()
    const t = ui.theme()
    if (!it) return []
    const lines: Seg[][] = [[{ text: it.title, fg: t.text, bold: true }]]
    if (it.detail) for (const l of wrap(it.detail, 82).slice(0, 5)) lines.push([{ text: l, fg: t.textMuted }])
    if (it.kind === "approval") {
      const p = ui.run.approvals.get(it.requestId!)
      if (p) lines.push([{ text: `options: ${p.options.map((o) => o.name).join(" · ")}`, fg: t.textSubtle }])
    }
    const hint: Partial<Record<AttentionKind, string>> = {
      approval: "a allow · A always · d deny · D never",
      plan: "enter: review the plan",
      failed: "enter: open the agent",
      conflict: "enter: open changes — merge one side, then /sync the other",
      merge: "enter: open changes",
      stalled: "enter: peek — nudge it, interrupt (x) or reassign",
      looping: "enter: peek — nudge it or interrupt (x)",
      scope: "enter: check its diff before merging",
      budget: "raise the budget in settings (ctrl+s) to continue",
      ready: "enter: review the diff, m to merge",
    }
    lines.push([{ text: hint[it.kind] ?? "", fg: t.textSubtle }])
    return lines
  })
  return (
    <Modal title={`Inbox (${items().length})`} width={88} height={24} hint="↑↓ select · enter act · esc close">
      <Show when={items().length > 0} fallback={<Txt value={segs({ text: "All clear — nothing needs you right now.", fg: ui.theme().textMuted })} />}>
        <ListView
          items={items().map((it) => {
            const st = KIND_STYLE[it.kind]
            const a = it.agentId ? ui.run.agents.get(it.agentId) : undefined
            const look = a ? agentLook(ui, a) : undefined
            return {
              label: [
                { text: `${st.glyph} `, fg: ui.theme()[st.token] },
                { text: look ? `${look.glyph} ` : "  ", fg: look?.color ?? ui.theme().text },
                { text: clip(it.title, 62), fg: ui.theme().text },
              ],
              right: it.kind,
            }
          })}
          selected={selClamped()}
          width={84}
          height={Math.min(12, Math.max(1, items().length))}
        />
        <Txt value={segs({ text: "─".repeat(84), fg: ui.theme().borderSubtle })} />
        <For each={detail()}>{(l) => <Txt wrapMode="word" value={segs(...l)} />}</For>
      </Show>
    </Modal>
  )
}

export function HelpOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  useKeyboard((k) => {
    if (k.name === "escape" || k.name === "q" || k.name === "?") props.onClose()
  })
  // two columns when the terminal is wide enough, so everything fits on one screen
  const twoCols = () => dims().width >= 124
  const W = () => (twoCols() ? Math.min(150, dims().width - 4) : Math.min(92, dims().width - 4))
  const colW = () => (twoCols() ? Math.floor((W() - 7) / 2) : W() - 4)
  const block = (ctx: string, title: string): Seg[][] => {
    const t = ui.theme()
    const out: Seg[][] = [[{ text: title, fg: t.primary, bold: true }]]
    for (const c of ui.keymap.commands.filter((x) => x.context === ctx && x.keys.length)) {
      const caps: Seg[] = c.keys.slice(0, 2).flatMap((k, i) => [...(i ? [{ text: " " }] : []), keycap(t, k)])
      const used = caps.reduce((n, x) => n + sw(x.text), 0)
      out.push([{ text: " " }, ...caps, { text: " ".repeat(Math.max(1, 20 - used)) }, { text: clip(c.title, colW() - 22), fg: t.textMuted }])
    }
    out.push([])
    return out
  }
  const inputBlock = (): Seg[][] => {
    const t = ui.theme()
    const row = (k: string, d: string): Seg[] => {
      const cap = keycap(t, k)
      return [{ text: " " }, cap, { text: " ".repeat(Math.max(1, 20 - sw(cap.text))) }, { text: clip(d, colW() - 22), fg: t.textMuted }]
    }
    const out: Seg[][] = [
      [{ text: "In the input", fg: t.primary, bold: true }],
      row("@name text", "talk to one agent directly (@all, @role:x)"),
      row("!name", "interrupt an agent (!all)"),
      row("/command", "/spawn /style /autonomy /merge … (tab completes)"),
    ]
    const conflicts = ui.keymap.conflicts()
    if (conflicts.length) {
      out.push([], [{ text: "Conflicting bindings", fg: t.warning, bold: true }])
      for (const c of conflicts) out.push([{ text: `  ${c}`, fg: t.warning }])
    }
    return out
  }
  const columns = createMemo(() => {
    const left = block("global", "Everywhere")
    const right = [...block("input", "While typing"), ...block("grid", "Agent grid (tab to focus)"), ...block("zoom", "Zoomed agent"), ...inputBlock()]
    return twoCols() ? [left, right] : [[...left, ...right]]
  })
  const rows = () => Math.max(...columns().map((c) => c.length))
  const H = () => Math.min(dims().height - 2, rows() + 3)
  return (
    <Modal title="Keyboard shortcuts" width={W()} height={H()} hint="esc close · rebind any key in config [keys]">
      <box flexDirection="row" height={H() - 3}>
        <For each={columns()}>
          {(col, i) => (
            <box width={colW() + (i() === 0 && twoCols() ? 3 : 0)} paddingRight={i() === 0 && twoCols() ? 3 : 0}>
              <Txt
                wrapMode="none"
                value={toStyled(
                  col.map((l) => ({ segs: l })),
                  colW(),
                  H() - 3,
                )}
              />
            </box>
          )}
        </For>
      </box>
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
