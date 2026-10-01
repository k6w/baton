/**
 * Looks: the style picker (shapes — frames, status bar, background — as opposed to the theme's
 * colors) and a miniature preview of Baton drawn with the real components, so every style can
 * be judged before it is applied. Moving through the list also previews it on the whole app.
 */
import { join } from "node:path"
import { configDir, projectBatonDir } from "@batonsh/kernel"
import { listThemes, loadTheme, mix, STYLES, type StylePrefs } from "@batonsh/themes"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { agentLook } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { clip, type Line, type Seg, wrap } from "../lines.ts"
import type { Prefs } from "../state.ts"
import { Frame, innerSize } from "../ui/Frame.tsx"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { swatch } from "../ui/widgets.ts"
import { ListView, Modal } from "./Overlays.tsx"
import { renderStatusRow } from "./StatusBar.tsx"

/** A tiny Baton: lead pane, two agent cards, status row — drawn in the given style. */
export function StylePreview(props: { prefs: StylePrefs; width: number; height: number }) {
  const ui = useUi()
  const t = () => ui.theme()
  const claude = () => agentLook(ui, { adapter: "claude", name: "claude-1" })
  const codex = () => agentLook(ui, { adapter: "codex", name: "codex-1" })
  const leadH = () => Math.max(4, Math.floor((props.height - 1) * 0.4))
  const cardH = () => Math.max(4, props.height - 1 - leadH())
  const cardW = () => Math.floor(props.width / 2)
  const p = () => props.prefs
  const border = (color: string) => (p().brand_borders ? (t().background.startsWith("#") ? mix(color, t().background, 0.4) : color) : t().border)
  const body = (lines: Seg[][], w: number, h: number) => toStyled(lines.map((segs) => ({ segs })) as Line[], w, h)

  const leadLines = (): Seg[][] => {
    const th = t()
    return [
      [
        { text: "❯ ", fg: th.primary, bold: true },
        { text: "add tests for the auth module", fg: th.text },
      ],
      [
        { text: "⇄ ", fg: th.textMuted },
        { text: "codex-1", fg: codex().color },
        { text: " → ", fg: th.textMuted },
        { text: "lead", fg: th.busTo },
        { text: "  result ok (+12 −3)", fg: th.success },
      ],
    ]
  }
  const cardLines = (kind: "claude" | "codex"): Seg[][] => {
    const th = t()
    return kind === "claude"
      ? [
          [
            { text: "● ", fg: th.success },
            { text: "Read", fg: th.toolName, bold: true },
            { text: "(auth.ts)", fg: th.toolArgs },
          ],
          [{ text: "  ⎿ 214 lines", fg: th.textMuted }],
          [{ text: "+ expect(login()).ok", fg: th.diffAdded, bg: th.diffAddedBg }],
        ]
      : [
          [
            { text: "• ", fg: th.textMuted },
            { text: "Ran ", fg: th.text, bold: true },
            { text: "bun test", fg: th.toolArgs },
          ],
          [{ text: "  └ 42 pass", fg: th.success }],
          [{ text: "- if (!token) return", fg: th.diffRemoved, bg: th.diffRemovedBg }],
        ]
  }
  const status = () => {
    const th = t()
    const row = renderStatusRow(
      [{ segs: [{ text: "● 2/2 agents running", fg: th.text }] }, { segs: [{ text: "18 calls", fg: th.text }] }],
      [{ segs: [{ text: "⎇ 3 unmerged", fg: th.accent }] }, { segs: [{ text: "app@main", fg: th.statusText }] }],
      { style: p().status_style, width: props.width, theme: th },
    )
    return toStyled([row], props.width)
  }
  const inner = (w: number, h: number) => innerSize(w, h, p().border, 1, p().frame)

  return (
    <box width={props.width} height={props.height} flexDirection="column" backgroundColor={t().background}>
      <Frame
        width={props.width}
        height={leadH()}
        frame={p().frame}
        border={p().border}
        borderColor={t().borderActive}
        focused
        accent={t().primary}
        icon={{ text: claude().glyph, fg: t().primary, bold: true }}
        title={[{ text: "orchestrator", fg: t().text, bold: true }]}
        right={[{ text: "claude · sonnet", fg: t().textMuted }]}
      >
        <Txt wrapMode="none" value={body(leadLines(), inner(props.width, leadH()).width, inner(props.width, leadH()).height)} />
      </Frame>
      <box flexDirection="row" height={cardH()}>
        <Frame
          width={cardW()}
          height={cardH()}
          frame={p().frame}
          border={p().border}
          borderColor={border(claude().color)}
          accent={claude().color}
          icon={{ text: claude().glyph, fg: claude().color, bold: true }}
          title={[{ text: "claude-1", fg: t().text, bold: true }]}
          right={[{ text: "tests", fg: t().textMuted }]}
        >
          <Txt wrapMode="none" value={body(cardLines("claude"), inner(cardW(), cardH()).width, inner(cardW(), cardH()).height)} />
        </Frame>
        <Frame
          width={props.width - cardW()}
          height={cardH()}
          frame={p().frame}
          border={p().border}
          borderColor={border(codex().color)}
          accent={codex().color}
          icon={{ text: codex().glyph, fg: codex().color, bold: true }}
          title={[{ text: "codex-1", fg: t().text, bold: true }]}
          right={[{ text: "fix", fg: t().textMuted }]}
        >
          <Txt wrapMode="none" value={body(cardLines("codex"), inner(props.width - cardW(), cardH()).width, inner(props.width - cardW(), cardH()).height)} />
        </Frame>
      </box>
      <Txt height={1} wrapMode="none" value={status()} />
    </box>
  )
}

export function StylePicker(props: { onClose: () => void; onPick: (name: string) => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const keys = Object.keys(STYLES[0]!.prefs) as (keyof StylePrefs)[]
  // restore exactly what was there (a hand-tuned "custom" combination included) on escape
  const original = Object.fromEntries([...keys, "style"].map((k) => [k, ui.prefs[k as keyof Prefs]])) as Partial<Prefs>
  const startIdx = Math.max(
    0,
    STYLES.findIndex((s) => s.name === ui.prefs.style),
  )
  const [sel, setSel] = createSignal(startIdx)
  const apply = (prefs: Partial<Prefs>) => {
    for (const [k, v] of Object.entries(prefs)) ui.setPrefs(k as keyof Prefs, v as never)
    ui.bump()
  }
  const preview = (i: number) => {
    const st = STYLES[i]
    if (st) apply({ ...st.prefs, style: st.name })
  }
  let done = false
  onCleanup(() => {
    if (!done) apply(original)
  })
  useKeyboard((k) => {
    const n = STYLES.length
    if (k.name === "escape") {
      apply(original)
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
      props.onPick(STYLES[sel()]!.name)
      props.onClose()
    }
  })

  const W = () => Math.min(108, dims().width - 4)
  const H = () => Math.min(24, dims().height - 2)
  const listW = 30
  const previewW = () => Math.max(30, W() - listW - 7)
  const previewH = () => H() - 7
  const current = () => STYLES[sel()]!
  const about = createMemo<Line[]>(() => {
    const th = ui.theme()
    const st = current()
    const facts = `${st.prefs.frame} frames · ${st.prefs.border === "none" ? "no box lines" : `${st.prefs.border} lines`} · ${st.prefs.status_style} status · ${st.prefs.background === "terminal" ? "terminal background" : "theme background"}${st.prefs.brand_borders ? " · brand colors" : ""}`
    return [
      { segs: [{ text: st.title, fg: th.text, bold: true }] },
      ...wrap(st.description, W() - 4)
        .slice(0, 2)
        .map((l) => ({ segs: [{ text: l, fg: th.textMuted }] })),
      { segs: [{ text: clip(facts, W() - 4), fg: th.textSubtle }] },
    ]
  })
  return (
    <Modal title="Style" width={W()} height={H()} hint="↑↓ preview · enter keep · esc revert · ctrl+t for colors">
      <box flexDirection="row" height={previewH()}>
        <box width={listW}>
          <ListView
            items={STYLES.map((s) => ({
              label: [{ text: s.title, fg: ui.theme().text }],
              right: s.name === ui.prefs.style && s === current() ? "●" : "",
            }))}
            selected={sel()}
            width={listW}
            height={Math.min(STYLES.length, previewH())}
          />
        </box>
        <box width={2} />
        <StylePreview prefs={current().prefs} width={previewW()} height={previewH()} />
      </box>
      <box height={1} />
      <Txt value={toStyled(about(), W() - 4, 4)} height={4} />
    </Modal>
  )
}

/** Themes, previewed live on the whole app and in a miniature drawn in your current style. */
export function ThemePicker(props: { onClose: () => void; onPick: (name: string) => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const dirs = { global: join(configDir(), "themes"), project: ui.run.projectRoot ? join(projectBatonDir(ui.run.projectRoot), "themes") : undefined }
  const themes = listThemes(dirs)
  const original = ui.rawTheme()
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
    } else if (k.name === "down" || k.name === "j" || k.name === "pagedown") {
      const i = (sel() + (k.name === "pagedown" ? 10 : 1)) % n
      setSel(i)
      preview(i)
    } else if (k.name === "up" || k.name === "k" || k.name === "pageup") {
      const i = (sel() - (k.name === "pageup" ? 10 : 1) + n * 10) % n
      setSel(i)
      preview(i)
    } else if (k.name === "return" || k.name === "enter") {
      done = true
      props.onPick(themes[sel()]!.name)
      props.onClose()
    }
  })
  const swatchOf = (name: string) => {
    const entry = themes.find((t) => t.name === name)
    return entry ? swatch(loadTheme(name, { appearance: entry.appearance, dirs })) : []
  }
  const W = () => Math.min(104, dims().width - 4)
  const H = () => Math.min(26, dims().height - 2)
  const listW = 38
  const showPreview = () => W() - listW - 6 >= 34
  const current = () => ui.prefs as unknown as StylePrefs
  return (
    <Modal title="Theme" width={showPreview() ? W() : listW + 4} height={H()} hint="↑↓ preview · enter keep · esc revert · /style for shapes">
      <box flexDirection="row" height={H() - 3}>
        <box width={listW}>
          <ListView
            items={themes.map((t) => ({
              label: [...swatchOf(t.name), { text: `  ${t.name}`, fg: ui.theme().text }],
              right: t.source === "builtin" ? (t.appearance ?? "") : t.source,
            }))}
            selected={sel()}
            width={listW}
            height={H() - 3}
          />
        </box>
        <Show when={showPreview()}>
          <box width={2} />
          <StylePreview prefs={current()} width={W() - listW - 6} height={Math.min(16, H() - 3)} />
        </Show>
      </box>
    </Modal>
  )
}
