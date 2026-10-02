/** Phone & web: starts the daemon's web view and shows its QR code + link (/web). */
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import type { Line } from "../lines.ts"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { keycap } from "../ui/widgets.ts"
import { Modal } from "./Overlays.tsx"

interface RemoteInfo {
  openUrl: string
  lanUrls: string[]
  lan: boolean
  qr: string[]
}

export function RemoteOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  const dims = useTerminalDimensions()
  const [info, setInfo] = createSignal<RemoteInfo | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const start = async (opts: { lan?: boolean; rotate?: boolean } = {}) => {
    try {
      setInfo(await ui.client?.call("remote.start", opts))
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  onMount(() => void start())
  useKeyboard((k) => {
    const ks = keyString(k)
    if (k.name === "escape" || k.name === "return" || k.name === "enter") props.onClose()
    else if (ks === "l") void start({ lan: !info()?.lan })
    else if (ks === "r") void start({ lan: info()?.lan, rotate: true })
    else if (ks === "s") {
      void ui.client?.call("remote.stop", {}).then(() => ui.toast("web view stopped"))
      props.onClose()
    }
  })
  const lines = (): Line[] => {
    const t = ui.theme()
    const i = info()
    if (error()) return [{ segs: [{ text: error()!, fg: t.error }] }]
    if (!i) return [{ segs: [{ text: "starting…", fg: t.textMuted }] }]
    const out: Line[] = []
    // the code is always black on white, whatever the theme: phones need the contrast
    const fits = i.qr.length + 8 <= dims().height - 2
    if (fits) for (const q of i.qr) out.push({ segs: [{ text: "  " }, { text: q, fg: "#ffffff", bg: "#000000" }] })
    out.push({ segs: [] })
    out.push({ segs: [{ text: i.openUrl, fg: t.accent, bold: true }] })
    out.push({
      segs: [
        { text: i.lan ? "reachable from your network — " : "this machine only — ", fg: t.textMuted },
        { text: i.lan ? "scan it with your phone" : "press l to allow your phone (same Wi-Fi)", fg: i.lan ? t.success : t.warning },
      ],
    })
    out.push({ segs: [{ text: "The link carries an access token: treat it like a password.", fg: t.textSubtle }] })
    out.push({
      segs: [
        keycap(t, "l"),
        { text: i.lan ? " this machine only  " : " phone / network  ", fg: t.textMuted },
        keycap(t, "r"),
        { text: " new token  ", fg: t.textMuted },
        keycap(t, "s"),
        { text: " stop  ", fg: t.textMuted },
        keycap(t, "esc"),
        { text: " close", fg: t.textMuted },
      ],
    })
    return out
  }
  const W = () => Math.min(Math.max(64, (info()?.qr[0]?.length ?? 40) + 8), dims().width - 4)
  return (
    <Modal title="Phone & web" width={W()} height={Math.min(lines().length + 3, dims().height - 2)} hint="follow, approve and send tasks from a browser">
      <Txt value={toStyled(lines(), W() - 4)} />
    </Modal>
  )
}
