/**
 * A2A push notifications (webhooks) for the daemon's A2A server: URL validation with an SSRF
 * guard, and delivery with per-webhook ordering, a timeout and retries with exponential backoff.
 *
 * SSRF guard: only http(s) URLs; refuses loopback, private (RFC 1918 / ULA), link-local,
 * CGNAT, multicast and unspecified addresses — for IP literals, `localhost` names and whatever
 * the host name resolves to (checked again before every delivery). Redirects are not followed.
 * `allowPrivate` turns the guard off (local testing, LAN-only setups).
 */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { A2AError, ErrorCode, type PushConfig } from "@batonsh/adapter-a2a/wire"

export type PushTarget = PushConfig & { dialect: "1.0" | "0.3" }

function v4Private(ip: string): boolean {
  const p = ip.split(".").map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && p[2] === 0) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    a >= 224 // multicast, reserved, broadcast
  )
}

/** Loopback / private / link-local / unspecified / multicast addresses (v4 and v6). */
export function isPrivateAddress(ip: string): boolean {
  const addr = ip.replace(/^\[|\]$/g, "").toLowerCase()
  const kind = isIP(addr)
  if (kind === 4) return v4Private(addr)
  if (kind !== 6) return true
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr) ?? /^::(\d+\.\d+\.\d+\.\d+)$/.exec(addr)
  if (mapped) return v4Private(mapped[1] as string)
  const hexMapped = /^(?:0*:)*:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(addr)
  if (hexMapped) {
    const hi = Number.parseInt(hexMapped[1] as string, 16)
    const lo = Number.parseInt(hexMapped[2] as string, 16)
    return v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
  if (addr === "::" || addr === "::1") return true
  const first = Number.parseInt(addr.split(":")[0] || "0", 16)
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (first & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (first & 0xffc0) === 0xfec0 || // site-local (deprecated)
    (first & 0xff00) === 0xff00 || // multicast
    first === 0x64 // 64:ff9b::/96 NAT64 can reach v4 private space
  )
}

const bad = (msg: string) => new A2AError(ErrorCode.InvalidParams, `push notification url rejected: ${msg}`)

/** Validate a webhook URL; resolves the host name unless `allowPrivate`. Throws an A2AError (InvalidParams). */
export async function checkPushUrl(raw: string, allowPrivate: boolean): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw bad("not a URL")
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad("only http(s) URLs")
  if (url.username || url.password) throw bad("credentials in the URL (use authentication instead)")
  if (allowPrivate) return url
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    throw bad(`${host} is a local name (set a2a.allow_private_push to allow it)`)
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw bad(`${host} is a private or loopback address (set a2a.allow_private_push to allow it)`)
    return url
  }
  let addrs: { address: string }[]
  try {
    addrs = await lookup(host, { all: true, verbatim: true })
  } catch (e) {
    throw bad(`cannot resolve ${host} (${e instanceof Error ? e.message : e})`)
  }
  const priv = addrs.find((a) => isPrivateAddress(a.address))
  if (priv || !addrs.length) throw bad(`${host} resolves to ${priv?.address ?? "nothing"} (private; set a2a.allow_private_push to allow it)`)
  return url
}

export interface PushOptions {
  allowPrivate?: boolean
  /** Delivery attempts per notification (default 5). */
  attempts?: number
  /** First retry delay; doubles each time (default 500 ms). */
  baseDelayMs?: number
  /** Per-request timeout (default 10 s). */
  timeoutMs?: number
  log?: (level: "info" | "warn", message: string) => void
}

/** Delivers notifications; one ordered queue per webhook so a task's updates arrive in order. */
export class PushDispatcher {
  private chains = new Map<string, Promise<void>>()
  private stopped = false
  private timers = new Set<ReturnType<typeof setTimeout>>()
  /** Deliveries since start: [url, ok] — for diagnostics and tests. */
  readonly delivered: { url: string; ok: boolean; status?: number }[] = []

  constructor(private opts: PushOptions = {}) {}

  deliver(target: PushTarget, payload: unknown): void {
    if (this.stopped) return
    const key = `${target.taskId}\u0000${target.id}`
    const prev = this.chains.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.send(target, payload)).catch(() => {})
    this.chains.set(key, next)
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    })
  }

  /** Resolves when every queued delivery has finished (or given up). */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()])
  }

  stop(): void {
    this.stopped = true
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
  }

  private wait(ms: number): Promise<void> {
    return new Promise((r) => {
      const t = setTimeout(() => {
        this.timers.delete(t)
        r()
      }, ms)
      t.unref?.()
      this.timers.add(t)
    })
  }

  private async send(target: PushTarget, payload: unknown): Promise<void> {
    const attempts = Math.max(1, this.opts.attempts ?? 5)
    const base = this.opts.baseDelayMs ?? 500
    const body = JSON.stringify(payload)
    const headers: Record<string, string> = { "content-type": target.dialect === "1.0" ? "application/a2a+json" : "application/json" }
    if (target.token) headers["X-A2A-Notification-Token"] = target.token
    if (target.authentication?.scheme)
      headers.Authorization = `${target.authentication.scheme}${target.authentication.credentials ? ` ${target.authentication.credentials}` : ""}`
    let lastErr = ""
    for (let i = 0; i < attempts && !this.stopped; i++) {
      if (i > 0) await this.wait(base * 2 ** (i - 1))
      if (this.stopped) return
      try {
        await checkPushUrl(target.url, this.opts.allowPrivate === true)
        const res = await fetch(target.url, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000) })
        await res.body?.cancel().catch(() => {})
        if (res.status >= 200 && res.status < 300) {
          this.delivered.push({ url: target.url, ok: true, status: res.status })
          return
        }
        lastErr = `HTTP ${res.status}`
        // client errors other than timeouts / rate limits won't get better by retrying
        if (res.status < 500 && res.status !== 408 && res.status !== 429) break
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e)
        if (e instanceof A2AError) break
      }
    }
    this.delivered.push({ url: target.url, ok: false })
    this.opts.log?.("warn", `A2A push to ${target.url} (task ${target.taskId}) failed: ${lastErr}`)
  }
}
