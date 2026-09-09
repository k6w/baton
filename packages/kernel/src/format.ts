/** Shared formatting helpers (used by TUI, CLI and status lines). */

export function formatTokens(n: number): string {
  if (n < 1000) return `${Math.round(n)}`
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0"
  if (usd < 0.01) return "<$0.01"
  if (usd < 100) return `$${usd.toFixed(2)}`
  return `$${Math.round(usd)}`
}

export function formatClock(ts: number, style: "ss.mmm" | "hh:mm:ss" | "relative", now = Date.now()): string {
  const d = new Date(ts)
  if (style === "hh:mm:ss") return d.toTimeString().slice(0, 8)
  if (style === "relative") return `${formatDuration(now - ts)} ago`
  return `${String(d.getSeconds()).padStart(2, "0")}.${String(d.getMilliseconds()).padStart(3, "0")}`
}

/** Expand "{key}" placeholders; unknown keys render empty. */
export function template(fmt: string, vars: Record<string, string | number | undefined>): string {
  return fmt.replace(/\{(\w+(?:\.\w+)?)\}/g, (_, k: string) => {
    const v = vars[k]
    return v === undefined ? "" : String(v)
  })
}

export function truncate(s: string, width: number): string {
  if (width <= 0) return ""
  if (s.length <= width) return s
  if (width === 1) return "…"
  return `${s.slice(0, width - 1)}…`
}

export function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}
