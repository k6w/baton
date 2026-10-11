/**
 * web_fetch: GET an http(s) URL and return readable text.
 *   - follows up to 5 redirects (each hop re-checked), 15 s timeout, 2 MB body cap;
 *   - HTML is converted to text (scripts/styles/nav dropped; headings, links and code kept);
 *   - SSRF guard: loopback / private / link-local addresses are refused unless allowPrivate.
 * DNS rebinding: plain-http requests connect to the exact address that passed the check (Host header
 * kept), so a second, different DNS answer is never used. https needs no pinning: a rebound name
 * can't present a valid certificate for the internal service, so the TLS handshake fails.
 */
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export const FETCH_TIMEOUT_MS = 15_000
export const FETCH_MAX_BYTES = 2 * 1024 * 1024
export const FETCH_MAX_CHARS = 20_000
const MAX_REDIRECTS = 5

export class FetchRefused extends Error {}

// ───────────────────────────── SSRF guard ─────────────────────────────

function v4ToInt(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + Number(o), 0) >>> 0
}

const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]

export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const n = v4ToInt(ip)
    return V4_BLOCKS.some(([base, bits]) => (n & (bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0)) >>> 0 === v4ToInt(base))
  }
  if (v === 6) {
    const a = ip.toLowerCase().replace(/^\[|\]$/g, "")
    if (a === "::" || a === "::1") return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a)
    if (mapped?.[1]) return isPrivateAddress(mapped[1])
    if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(a)) return true // hex-mapped v4: be conservative
    const first = Number.parseInt(a.split(":")[0] || "0", 16)
    if ((first & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true // multicast
    return false
  }
  return false
}

/** Checks the host; returns the vetted address to connect to (undefined when private hosts are allowed). */
async function checkHost(url: URL, allowPrivate: boolean, resolve = lookup): Promise<string | undefined> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new FetchRefused(`only http(s) URLs can be fetched (got ${url.protocol})`)
  if (allowPrivate) return undefined
  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal"))
    throw new FetchRefused(`refusing to fetch a local address (${host})`)
  const addrs = isIP(host) ? [host] : (await resolve(host, { all: true, verbatim: true })).map((a) => a.address)
  const bad = addrs.find(isPrivateAddress)
  if (bad) throw new FetchRefused(`refusing to fetch a private or loopback address (${host} → ${bad})`)
  if (!addrs[0]) throw new FetchRefused(`${host} did not resolve`)
  return addrs[0]
}

/** http://name/path → http://<vetted ip>/path (+ Host: name); https and IP URLs unchanged. */
export function pinnedTarget(url: URL, ip: string | undefined): { target: URL; host?: string } {
  if (!ip || url.protocol !== "http:" || isIP(url.hostname.replace(/^\[|\]$/g, ""))) return { target: url }
  const target = new URL(url)
  target.hostname = isIP(ip) === 6 ? `[${ip}]` : ip
  return { target, host: url.host }
}

// ───────────────────────────── HTML → text ─────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", copy: "©" }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      try {
        return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
      } catch {
        return m
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "")
const inline = (s: string) => decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim()

/** Small HTML → markdown-ish text converter. */
export function htmlToText(html: string, baseUrl?: string): { title?: string; text: string } {
  let s = html.replace(/<!--[\s\S]*?-->/g, "")
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(s)?.[1]
  s = s.replace(/<head[\s>][\s\S]*?<\/head>/gi, "")
  s = s.replace(/<(script|style|noscript|nav|svg|template|iframe|object|canvas|select|button|form)\b[\s\S]*?<\/\1\s*>/gi, "")
  s = s.replace(/<(script|style|link|meta|input|img)\b[^>]*>/gi, "")
  const pres: string[] = []
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) => {
    pres.push(decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))).replace(/^\n+|\s+$/g, ""))
    return `\n\n\u0000PRE${pres.length - 1}\u0000\n\n`
  })
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => {
    const t = decodeEntities(stripTags(inner))
    return t ? `\`${t}\`` : ""
  })
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs: string, inner: string) => {
    const text = inline(inner)
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs)
    const raw = decodeEntities(href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim()
    if (!text) return ""
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|data):/i.test(raw)) return text
    let abs = raw
    try {
      abs = new URL(raw, baseUrl).toString()
    } catch {}
    return `[${text}](${abs})`
  })
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, n: string, inner: string) => `\n\n${"#".repeat(Number(n))} ${inline(inner)}\n\n`)
  s = s.replace(/<li\b[^>]*>/gi, "\n- ")
  s = s.replace(/<(br|hr)\b[^>]*>/gi, "\n")
  s = s.replace(/<\/?(p|div|section|article|main|header|footer|aside|ul|ol|table|tr|blockquote|dl|dt|dd|figure|figcaption|details|summary)\b[^>]*>/gi, "\n")
  s = s.replace(/<\/(td|th)\s*>/gi, " | ")
  s = decodeEntities(stripTags(s))
  s = s
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v\r ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  s = s.replace(/\u0000PRE(\d+)\u0000/g, (_, i: string) => `\`\`\`\n${pres[Number(i)] ?? ""}\n\`\`\``)
  return { title: title ? inline(title) : undefined, text: s }
}

// ───────────────────────────── fetch ─────────────────────────────

export interface FetchResult {
  url: string
  status: number
  contentType: string
  text: string
  truncated: boolean
  bytes: number
}

async function readCapped(res: Response, max: number): Promise<{ buf: Uint8Array; truncated: boolean }> {
  if (!res.body) return { buf: new Uint8Array(), truncated: false }
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (size + value.length > max) {
      chunks.push(value.slice(0, max - size))
      size = max
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
    size += value.length
  }
  const buf = new Uint8Array(size)
  let o = 0
  for (const c of chunks) {
    buf.set(c, o)
    o += c.length
  }
  return { buf, truncated }
}

export async function webFetch(
  rawUrl: string,
  opts: { signal?: AbortSignal; allowPrivate?: boolean; timeoutMs?: number; maxBytes?: number; fetch?: typeof fetch; resolve?: typeof lookup } = {},
): Promise<FetchResult> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new FetchRefused(`not a valid URL: ${rawUrl}`)
  }
  const doFetch = opts.fetch ?? fetch
  const signals = [AbortSignal.timeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS)]
  if (opts.signal) signals.push(opts.signal)
  const signal = AbortSignal.any(signals)
  let res: Response | undefined
  for (let hop = 0; ; hop++) {
    const ip = await checkHost(url, !!opts.allowPrivate, opts.resolve)
    const { target, host } = pinnedTarget(url, ip)
    res = await doFetch(target, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: {
        ...(host ? { host } : {}),
        "user-agent": "BatonAgent/0.1 (+https://github.com/k6w/baton)",
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
      },
    })
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      void res.body?.cancel().catch(() => {})
      if (hop >= MAX_REDIRECTS) throw new Error(`too many redirects (more than ${MAX_REDIRECTS})`)
      url = new URL(res.headers.get("location") as string, url)
      continue
    }
    break
  }
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase()
  const { buf, truncated } = await readCapped(res, opts.maxBytes ?? FETCH_MAX_BYTES)
  const isText = !contentType || /^text\/|json|xml|javascript|ecmascript|yaml|toml|csv|markdown/.test(contentType)
  let text: string
  if (!isText) text = `[binary content: ${contentType}, ${buf.length} bytes — not shown]`
  else {
    const charset = /charset=([\w-]+)/.exec(contentType)?.[1]
    let decoded: string
    try {
      decoded = new TextDecoder((charset || "utf-8") as "utf-8").decode(buf)
    } catch {
      decoded = new TextDecoder().decode(buf)
    }
    const looksHtml = /html/.test(contentType) || (!contentType && /^\s*(<!doctype html|<html)/i.test(decoded))
    if (looksHtml) {
      const h = htmlToText(decoded, url.toString())
      text = h.title ? `# ${h.title}\n\n${h.text}` : h.text
    } else text = decoded
  }
  return { url: url.toString(), status: res.status, contentType, text, truncated, bytes: buf.length }
}
