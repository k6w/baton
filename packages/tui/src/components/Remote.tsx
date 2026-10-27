/** Phone & web: starts the daemon's web view and shows its QR code + link (/web). */
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createSignal, onMount } from "solid-js"
import { copyText } from "../clipboard.ts"
import { useUi } from "../context.ts"
import { keyString } from "../keymap.ts"
import type { Line } from "../lines.ts"
import { toStyled } from "../ui/styled.ts"
import { Txt } from "../ui/Txt.tsx"
import { keycap } from "../ui/widgets.ts"
import { Modal } from "./Overlays.tsx"

interface RemoteInfo {
  url: string
  openUrl: string
  lanUrls: string[]
  lan: boolean
  qr: string[]
  tls?: boolean
  fingerprint?: string
  publicUrl?: string
}

/** A link cut into rows of `width` (links have no spaces to wrap at), so all of it shows. */
function chunks(text: string, width: number): string[] {
  const w = Math.max(10, width)
  const out: string[] = []
  for (let i = 0; i < text.length; i += w) out.push(text.slice(i, i + w))
  return out.length ? out : [""]
}

export function RemoteOverlay(props: { onClose: () => void }) {
  const ui = useUi()
  const renderer = useRenderer()
  const dims = useTerminalDimensions()
  const [info, setInfo] = createSignal<RemoteInfo | undefined>()
  const [error, setError] = createSignal<string | undefined>()
  const start = async (opts: { lan?: boolean; rotate?: boolean; tls?: boolean; tailscale?: boolean } = {}) => {
    try {
      setInfo(await ui.client?.call("remote.start", opts))
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const copy = (text: string) => {
    const via = copyText(renderer, text)
    ui.toast(via.startsWith("nothing") ? `couldn't copy the link: ${via}` : "link copied — treat it like a password")
  }
  onMount(() => void start())
  useKeyboard((k) => {
    const ks = keyString(k)
    const i = info()
    if (k.name === "escape" || k.name === "return" || k.name === "enter") props.onClose()
    else if ((ks === "c" || ks === "y") && i) copy(i.openUrl)
    else if (ks === "l") void start({ lan: !i?.lan, tls: i?.tls })
    else if (ks === "h") void start({ lan: i?.lan, tls: !i?.tls })
    else if (ks === "t") void start({ lan: i?.lan, tailscale: !i?.publicUrl })
    else if (ks === "r") void start({ lan: i?.lan, tls: i?.tls, rotate: true })
    else if (ks === "s") {
      void ui.client?.call("remote.stop", {}).then(() => ui.toast("web view stopped"))
      props.onClose()
    }
  })
  /** Other ways in: the remaining network addresses and this machine's. */
  const others = (i: RemoteInfo) => [...new Set([...i.lanUrls, i.url])].filter((u) => u && u !== i.openUrl)
  const inner = () => W() - 4
  const text = (): Line[] => {
    const t = ui.theme()
    const i = info()
    if (error()) return [{ segs: [{ text: error()!, fg: t.error }] }]
    if (!i) return [{ segs: [{ text: "starting…", fg: t.textMuted }] }]
    const out: Line[] = []
    for (const row of chunks(i.openUrl, inner())) out.push({ segs: [{ text: row, fg: t.accent, bold: true }] })
    out.push({
      segs: [
        { text: i.lan ? "reachable from your network — " : "this machine only — ", fg: t.textMuted },
        { text: i.lan ? "scan it with your phone" : "press l to allow your phone (same Wi-Fi)", fg: i.lan ? t.success : t.warning },
      ],
    })
    const more = others(i)
    if (more.length) {
      out.push({ segs: [{ text: "also at:", fg: t.textMuted }] })
      for (const u of more) for (const row of chunks(u, inner() - 2)) out.push({ segs: [{ text: `  ${row}`, fg: t.textMuted }] })
    }
    out.push({ segs: [{ text: "The link carries an access token: treat it like a password.", fg: t.textSubtle }] })
    if (i.publicUrl) out.push({ segs: [{ text: "Published on your tailnet with a real HTTPS certificate.", fg: t.success }] })
    else if (i.tls)
      out.push({ segs: [{ text: `HTTPS (Baton's certificate — trust it once on the phone) · ${i.fingerprint?.slice(0, 23) ?? ""}…`, fg: t.success }] })
    else if (i.lan) out.push({ segs: [{ text: "Plain HTTP on your network — h for HTTPS, t for Tailscale.", fg: t.warning }] })
    out.push({
      segs: [
        keycap(t, "c"),
        { text: " copy link  ", fg: t.textMuted },
        keycap(t, "l"),
        { text: i.lan ? " this machine only  " : " phone / network  ", fg: t.textMuted },
        keycap(t, "h"),
        { text: i.tls ? " http  " : " https  ", fg: t.textMuted },
        keycap(t, "t"),
        { text: " tailscale", fg: t.textMuted },
      ],
    })
    out.push({
      segs: [
        keycap(t, "r"),
        { text: " new token  ", fg: t.textMuted },
        keycap(t, "s"),
        { text: " stop  ", fg: t.textMuted },
        keycap(t, "esc"),
        { text: " close (keeps running)", fg: t.textMuted },
      ],
    })
    return out
  }
  const lines = (): Line[] => {
    const i = info()
    const body = text()
    // the code is always black on white, whatever the theme: phones need the contrast
    if (!i || error() || i.qr.length + body.length + 4 > dims().height - 2) return body
    return [...i.qr.map((q): Line => ({ segs: [{ text: "  " }, { text: q, fg: "#ffffff", bg: "#000000" }] })), { segs: [] }, ...body]
  }
  // wide enough for the whole link when the terminal is
  const W = () => Math.min(Math.max(64, (info()?.qr[0]?.length ?? 40) + 8, (info()?.openUrl.length ?? 0) + 4), dims().width - 4)
  return (
    <Modal title="Phone & web" width={W()} height={Math.min(lines().length + 3, dims().height - 2)} hint="follow, approve and send tasks from a browser">
      <Txt value={toStyled(lines(), inner())} />
    </Modal>
  )
}
