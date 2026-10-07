/**
 * DNS-rebinding guard for Baton's HTTP servers (web view, A2A, the MCP bus).
 *
 * A web page on evil.example can re-point its own name at 127.0.0.1 (or a LAN address) and make
 * your browser talk to a local server as "evil.example". Such requests carry `Host: evil.example`.
 * So: requests must name the server by an IP literal, localhost, this machine's own names, or
 * a hostname Baton was told about (public_url, the Tailscale name). Everything else gets 421.
 */

import { isIP } from "node:net"
import { hostname } from "node:os"

export function hostOf(header: string | null): string {
  if (!header) return ""
  const h = header.trim().toLowerCase()
  if (h.startsWith("[")) return h.slice(1, h.indexOf("]"))
  return h.replace(/:\d+$/, "").replace(/\.$/, "")
}

/** This machine's names: "mbp", "mbp.local" (mDNS). */
export function machineNames(): string[] {
  const h = hostname().toLowerCase().replace(/\.$/, "")
  const short = h.split(".")[0] ?? h
  return [...new Set([h, short, `${short}.local`])]
}

export function hostAllowed(header: string | null, extra: readonly string[] = []): boolean {
  const host = hostOf(header)
  // HTTP/1.0 clients may omit Host; such a request can't come from a browser page
  if (!host) return true
  if (isIP(host) || host === "localhost" || host.endsWith(".localhost")) return true
  const names = [...machineNames(), ...extra.map((x) => hostOf(x.includes("://") ? new URL(x).host : x))]
  return names.includes(host)
}

export const misdirected = () =>
  new Response("unknown host — open Baton by IP address or its configured URL", { status: 421, headers: { "content-type": "text/plain" } })
