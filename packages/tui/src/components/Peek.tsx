/**
 * Peek: look at one agent's latest activity and answer it without leaving the grid.
 * Pending approval → a/A/d/D answer it; otherwise type a reply (sent to that agent, injected
 * into its current turn when the agent supports steering).
 */
import type { InputRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Show } from "solid-js"
import { agentLook, whoFn } from "../agent-style.ts"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import { type Line, renderFeed, statusLine, workspaceLine } from "../lines.ts"
import { segs, toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { Modal } from "./Overlays.tsx"

export function PeekOverlay(props: { agentId: string; onClose: () => void; onZoom: () => void; onDiff: () => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const W = () => Math.min(110, dims().width - 4)
  const H = () => Math.min(32, dims().height - 2)
  const agent = createMemo(() => {
    ui.version()
    const a = ui.run.agents.get(props.agentId)
    return a ? { ...a } : undefined
  })
  const approval = createMemo(() => {
    ui.version()
    return [...ui.run.approvals.values()].find((p) => p.agentId === props.agentId)
  })
  const [replying, setReplying] = createSignal(!approval())
  let inputRef: InputRenderable | undefined

  const answer = async (kind: "allow_once" | "allow_always" | "reject_once" | "reject_always") => {
    const p = approval()
    if (!p || !ui.client) return
    const opt = p.options.find((o) => o.kind === kind) ?? p.options.find((o) => o.kind.startsWith(kind.split("_")[0]!))
    try {
      await ui.client.respond(p.agentId, p.requestId, opt?.optionId ?? null)
      ui.toast(`${kind.startsWith("allow") ? "allowed" : "denied"}: ${p.title}`)
    } catch (e) {
      ui.toast(e instanceof Error ? e.message : String(e), "error")
    }
  }

  useKeyboard((k) => {
    const ks = keyString(k)
    if (k.name === "escape") {
      if (replying() && approval()) setReplying(false)
      else props.onClose()
      return
    }
    if (replying()) return
    if (ks === "a" || ks === "y") void answer("allow_once")
    else if (ks === "shift+a") void answer("allow_always")
    else if (ks === "d" || ks === "n") void answer("reject_once")
    else if (ks === "shift+d") void answer("reject_always")
    // open on the next tick so the "r" itself doesn't land in the freshly focused input
    else if (ks === "r" || k.name === "tab") setTimeout(() => setReplying(true), 0)
    else if (ks === "z") props.onZoom()
    else if (ks === "x") void ui.client?.interrupt(props.agentId).then(() => ui.toast("interrupted"))
    else if (ks === "v") props.onDiff()
  })

  const lines = createMemo<Line[]>(() => {
    ui.version()
    const a = agent()
    if (!a) return []
    const look = agentLook(ui, a)
    const width = W() - 4
    const height = H() - 9
    const feed = renderFeed(ui.run.feed(props.agentId).items.slice(-80), {
      theme: ui.theme(),
      width,
      look: look.look,
      showThoughts: ui.prefs.show_thoughts,
      maxDiffLines: 8,
      maxOutputLines: 6,
      who: whoFn(ui),
    })
    return feed.slice(-height)
  })

  const footer = createMemo<Line[]>(() => {
    ui.version()
    const a = agent()
    if (!a) return []
    const t = ui.theme()
    const look = agentLook(ui, a)
    const frames = ui.spinnerFrames()
    const out: Line[] = [statusLine(a, { theme: t, look: look.look, frame: frames[ui.frame() % frames.length] ?? "·", verbs: ui.verbs, now: ui.now() })]
    const ws = workspaceLine(ui.run.workspaces.get(props.agentId), { theme: t, width: W() - 4, who: whoFn(ui) })
    if (ws) out.push(ws)
    const p = approval()
    if (p)
      out.push({
        segs: [
          { text: "? ", fg: t.warning, bold: true },
          { text: p.title, fg: t.warning, bold: true },
          { text: "   a allow · A always · d deny · D never", fg: t.textMuted },
        ],
      })
    return out
  })

  const title = () => {
    const a = agent()
    return a ? `${agentLook(ui, a).glyph} ${a.name}${a.label ? ` · ${a.label}` : ""}` : "agent"
  }

  return (
    <Modal title={title()} width={W()} height={H()} hint={replying() ? "enter send · esc back" : "r reply · z zoom · v diff · x interrupt · esc close"}>
      <Txt value={toStyled(lines(), W() - 4, H() - 9)} height={H() - 9} />
      <Txt value={segs({ text: "─".repeat(W() - 4), fg: ui.theme().borderSubtle })} />
      <Txt value={toStyled(footer(), W() - 4, 3)} height={3} />
      <Show when={replying()} fallback={<Txt value={segs({ text: approval() ? "r to reply instead" : "r to reply", fg: ui.theme().textSubtle })} />}>
        <box height={1} flexDirection="row">
          <Txt value={segs({ text: "❯ ", fg: ui.theme().primary, bold: true })} />
          <input
            ref={(r: InputRenderable) => {
              inputRef = r
            }}
            flexGrow={1}
            focused
            backgroundColor="transparent"
            focusedBackgroundColor="transparent"
            textColor={ui.theme().text}
            focusedTextColor={ui.theme().text}
            placeholder={`message ${agent()?.name ?? "agent"} (injected into its current turn when possible)`}
            onSubmit={
              ((v: unknown) => {
                const text = (typeof v === "string" ? v : (inputRef?.value ?? "")).trim()
                const a = agent()
                if (!text || !a || !ui.client) return
                if (inputRef) inputRef.value = ""
                void ui.client.submit(`@${a.name} ${text}`).then(
                  () => ui.toast(`sent to ${a.name}`),
                  (e: unknown) => ui.toast(e instanceof Error ? e.message : String(e), "error"),
                )
              }) as never
            }
          />
        </box>
      </Show>
    </Modal>
  )
}
