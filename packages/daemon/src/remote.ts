/**
 * Remote access: a small web app served by the daemon so you can follow a run and answer it from
 * a phone or another machine — the inbox (approve / deny), the lead's thread, every agent's
 * activity, a task input, the autonomy dial, merge and interrupt.
 *
 * Off until started (`baton web`, `/web`). Bound to 127.0.0.1 unless `lan` is asked for. Every
 * request carries the project's access token (`Authorization: Bearer …`; the page keeps it in the
 * URL fragment, which browsers never send to servers). One-tap approve/deny links in
 * notifications use per-request HMAC signatures instead, so the token never leaves the machine.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { hostname, networkInterfaces } from "node:os"
import { join } from "node:path"
import { attentionItems, type FeedItem, stateDir } from "@batonsh/kernel"
import qrcode from "qrcode-generator"
import { hostAllowed, hostOf, misdirected } from "./host-guard.ts"
import { handleInput } from "./input.ts"
import { pickOption } from "./policy.ts"
import { REMOTE_PAGE } from "./remote-page.ts"
import type { Runtime } from "./runtime.ts"

export interface RemoteServer {
  url: string
  /** URL with the access token in the fragment — what you open / scan. */
  openUrl: string
  /** The same for every LAN address when bound to all interfaces. */
  lanUrls: string[]
  port: number
  lan: boolean
  /** Served over HTTPS with Baton's self-signed certificate. */
  tls: boolean
  /** SHA-256 fingerprint of that certificate (to check on the phone). */
  fingerprint?: string
  /** Published through `tailscale serve` (https://<machine>.<tailnet>.ts.net). */
  publicUrl?: string
  stop(): void
}

interface Secrets {
  token: string
  secret: string
}

/** Token + signing secret per project, kept across restarts so bookmarks keep working. */
export function remoteSecrets(projectRoot: string, rotate = false): Secrets {
  const dir = join(stateDir(), "remote")
  const file = join(dir, `${createHash("sha1").update(projectRoot).digest("hex").slice(0, 16)}.json`)
  if (!rotate && existsSync(file)) {
    try {
      const s = JSON.parse(readFileSync(file, "utf8")) as Secrets
      if (s.token && s.secret) return s
    } catch {}
  }
  const s: Secrets = { token: randomBytes(24).toString("base64url"), secret: randomBytes(32).toString("base64url") }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify(s), { mode: 0o600 })
  return s
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function signAction(secret: string, agentId: string, requestId: string, decision: "allow" | "deny"): string {
  return createHmac("sha256", secret).update(`${agentId}|${requestId}|${decision}`).digest("base64url").slice(0, 32)
}

/** IPv4 addresses other devices on the network can reach. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address)
  return out
}

/** A QR code drawn with half blocks (two modules per character row), quiet zone included. */
export function qrLines(text: string): string[] {
  const q = qrcode(0, "M")
  q.addData(text)
  q.make()
  const n = q.getModuleCount()
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < n && c < n && q.isDark(r, c)
  const lines: string[] = []
  for (let r = -2; r < n + 2; r += 2) {
    let line = ""
    for (let c = -2; c < n + 2; c++) {
      const top = dark(r, c)
      const bottom = dark(r + 1, c)
      // light modules are drawn (█), dark ones left empty: scanners want dark-on-light
      line += top && bottom ? " " : top ? "▄" : bottom ? "▀" : "█"
    }
    lines.push(line)
  }
  return lines
}

// ───────────────────────────── view model ─────────────────────────────

type Item =
  | { k: "text"; role: "assistant" | "thought"; text: string; ts: number }
  | { k: "user"; text: string; from?: string; ts: number }
  | {
      k: "tool"
      title: string
      status: string
      summary?: string
      output?: string
      diffs: { path: string; added: number; removed: number; lines: string[] }[]
      ts: number
    }
  | { k: "bus"; from: string; to: string; body: string; ts: number }
  | { k: "note" | "error" | "ask"; text: string; ts: number }

function item(it: FeedItem, name: (id: string) => string): Item | undefined {
  switch (it.kind) {
    case "message":
      return it.text.trim() ? { k: "text", role: it.role, text: it.text.slice(-4000), ts: it.ts } : undefined
    case "user":
      // messages Baton relays between agents already show as bus lines
      if (it.text.startsWith("[baton]")) return undefined
      return { k: "user", text: it.text.slice(0, 2000), from: it.from ? name(it.from) : undefined, ts: it.ts }
    case "tool":
      return {
        k: "tool",
        title: it.title,
        status: it.status,
        summary: it.summary,
        output: it.output?.slice(-1500),
        diffs: it.diffs.slice(0, 4).map((d) => ({
          path: d.path,
          added: d.added,
          removed: d.removed,
          lines: d.lines
            .filter((l) => l.kind !== "ctx")
            .slice(0, 24)
            .map((l) => `${l.kind === "add" ? "+" : "-"} ${l.text}`),
        })),
        ts: it.ts,
      }
    case "bus":
      return { k: "bus", from: name(it.from), to: name(it.to), body: it.body.slice(0, 1500), ts: it.ts }
    case "permission":
      return { k: "ask", text: `${it.title}${it.resolved ? ` — ${it.resolved}` : ""}`, ts: it.ts }
    case "error":
      return { k: "error", text: it.text, ts: it.ts }
    case "note":
      return { k: "note", text: it.text, ts: it.ts }
  }
}

export function remoteView(rt: Runtime) {
  const s = rt.state
  const name = (id: string) => (id === "user" ? "you" : id === s.orchestratorId ? "lead" : (s.agents.get(id)?.name ?? s.findAgent(id)?.name ?? id))
  const feedOf = (id: string, n: number) =>
    s
      .feed(id)
      .items.slice(-n)
      .map((it) => item(it, name))
      .filter((x): x is Item => !!x)
  const lead = s.orchestratorId
  const thread: Item[] = lead ? feedOf(lead, 60) : []
  for (const m of s.bus.slice(-120)) {
    if (m.kind === "heartbeat" || m.kind === "progress" || m.from === lead || m.to === lead) continue
    thread.push({ k: "bus", from: name(m.from), to: name(m.to), body: m.body.slice(0, 1500), ts: m.ts })
  }
  thread.sort((a, b) => a.ts - b.ts)
  return {
    project: s.projectName,
    branch: s.branch,
    autonomy: s.autonomy,
    mode: s.mode,
    viewers: [...new Set(s.viewers.map((v) => v.name))],
    totals: s.totals,
    attention: attentionItems(s).map((a) => {
      const p = a.requestId ? s.approvals.get(a.requestId) : undefined
      return { ...a, agent: a.agentId ? name(a.agentId) : undefined, options: p?.options, detail: a.detail ?? p?.detail }
    }),
    lead: lead ? { id: lead, status: s.agents.get(lead)?.status, adapter: s.agents.get(lead)?.adapter } : undefined,
    thread: thread.slice(-80),
    agents: [...s.agents.values()]
      .filter((a) => a.status !== "exited" && !a.isOrchestrator)
      .map((a) => {
        const ws = s.workspaces.get(a.agentId)
        return {
          id: a.agentId,
          name: a.name,
          adapter: a.adapter,
          model: a.model,
          label: a.label,
          status: a.status,
          detail: a.statusDetail,
          approval: a.approval,
          cost: a.usage.costUsd,
          progress: a.progress,
          workspace: ws
            ? { mode: ws.mode, files: ws.files.length, added: ws.added, removed: ws.removed, merge: ws.merge?.status, conflicts: ws.conflicts.length }
            : undefined,
          feed: feedOf(a.agentId, 30),
        }
      }),
  }
}

// ───────────────────────────── server ─────────────────────────────

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })

/**
 * A self-signed certificate for the web view (P-256, ~2 years), covering localhost, this machine's
 * name and its LAN addresses; regenerated when those change. Needs `openssl` (LibreSSL works).
 */
export function remoteCertificate(projectRoot: string): { cert: string; key: string; fingerprint: string } {
  const dir = join(stateDir(), "remote")
  const base = join(dir, createHash("sha1").update(projectRoot).digest("hex").slice(0, 16))
  const names = [
    "DNS:localhost",
    `DNS:${hostname()}`,
    ...(hostname().endsWith(".local") ? [] : [`DNS:${hostname()}.local`]),
    "IP:127.0.0.1",
    ...lanAddresses().map((a) => `IP:${a}`),
  ]
  const san = names.join(",")
  const want = `${base}.san`
  if (!existsSync(`${base}.cert.pem`) || !existsSync(want) || readFileSync(want, "utf8") !== san) {
    if (!Bun.which("openssl")) throw new Error("HTTPS needs openssl to create a certificate (or use --tailscale)")
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const r = Bun.spawnSync(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        // a named curve, not explicit parameters: BoringSSL (Bun's TLS) rejects the latter
        "-pkeyopt",
        "ec_param_enc:named_curve",
        "-nodes",
        "-keyout",
        `${base}.key.pem`,
        "-out",
        `${base}.cert.pem`,
        "-days",
        "825",
        "-subj",
        "/CN=Baton web view",
        "-addext",
        `subjectAltName=${san}`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    )
    if (r.exitCode !== 0) throw new Error(`openssl failed: ${r.stderr.toString().trim().split("\n").at(-1)}`)
    chmodSync(`${base}.key.pem`, 0o600)
    writeFileSync(want, san)
  }
  const cert = readFileSync(`${base}.cert.pem`, "utf8")
  const der = Buffer.from(cert.replace(/-----[^-]+-----|\s/g, ""), "base64")
  const fingerprint = (createHash("sha256").update(der).digest("hex").match(/../g) ?? []).join(":").toUpperCase()
  return { cert, key: readFileSync(`${base}.key.pem`, "utf8"), fingerprint }
}

/** `tailscale serve` the web view on this machine's tailnet name (real HTTPS certificate). */
export function tailscaleServe(port: number): string {
  if (!Bun.which("tailscale")) throw new Error("tailscale isn't installed (https://tailscale.com/download)")
  const st = Bun.spawnSync(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "pipe" })
  if (st.exitCode !== 0) throw new Error(`tailscale isn't running: ${st.stderr.toString().trim()}`)
  const dns = (JSON.parse(st.stdout.toString()) as { Self?: { DNSName?: string } }).Self?.DNSName?.replace(/\.$/, "")
  if (!dns) throw new Error("tailscale reports no DNS name for this machine (enable MagicDNS)")
  const r = Bun.spawnSync(["tailscale", "serve", "--bg", `http://127.0.0.1:${port}`], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`tailscale serve failed: ${r.stderr.toString().trim() || r.stdout.toString().trim()}`)
  return `https://${dns}`
}

export function tailscaleUnserve(): void {
  if (Bun.which("tailscale")) Bun.spawnSync(["tailscale", "serve", "--https=443", "off"], { stdout: "ignore", stderr: "ignore" })
}

export function startRemoteServer(rt: Runtime, opts: { lan?: boolean; port?: number; tls?: boolean } = {}): RemoteServer {
  const certificate = opts.tls ? remoteCertificate(rt.projectRoot) : undefined
  const { token, secret } = remoteSecrets(rt.projectRoot)
  const authed = (req: Request, url: URL) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]
    const t = bearer ?? url.searchParams.get("t") ?? ""
    return t !== "" && same(t, token)
  }
  const respond = async (agentId: string, requestId: string, decision: "allow" | "deny" | string, who?: string) => {
    const p = rt.state.approvals.get(requestId)
    if (!p || p.agentId !== agentId) return false
    const opt = decision === "allow" || decision === "deny" ? pickOption(p.options, decision) : p.options.find((o) => o.optionId === decision)
    await rt.resolvePermission(agentId, requestId, opt?.optionId ?? null, "user", who)
    return true
  }
  const server = Bun.serve({
    hostname: opts.lan ? "0.0.0.0" : "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 0,
    ...(certificate ? { tls: { cert: certificate.cert, key: certificate.key } } : {}),
    async fetch(req) {
      // DNS rebinding: tailnet names (*.ts.net) are Tailscale's DNS, not an attacker's
      const host = hostOf(req.headers.get("host"))
      if (!host.endsWith(".ts.net") && !hostAllowed(host, rt.config.remote.public_url ? [rt.config.remote.public_url] : [])) return misdirected()
      const url = new URL(req.url)
      const path = url.pathname
      if (req.method === "GET" && (path === "/" || path === "/index.html"))
        return new Response(REMOTE_PAGE, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" },
        })
      // one-tap approve / deny from a notification: signed per request, no token needed
      const act = /^\/act\/([\w-]+)\/([\w-]+)\/(allow|deny)$/.exec(path)
      if (act) {
        const [, agentId, requestId, decision] = act as unknown as [string, string, string, "allow" | "deny"]
        if (!same(url.searchParams.get("sig") ?? "", signAction(secret, agentId, requestId, decision))) return new Response("bad signature", { status: 403 })
        // GET only shows a confirm button: link previews (Slack, chat apps) fetch URLs and must not approve anything
        if (req.method === "GET") {
          const p = rt.state.approvals.get(requestId)
          const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c)
          const page = p
            ? `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:16px system-ui;margin:2em;max-width:36em"><p>${esc(rt.state.agents.get(agentId)?.name ?? "agent")} asks:</p><h3>${esc(p.title)}</h3><form method="post"><button style="font:inherit;padding:.6em 1.4em">${decision === "allow" ? "Allow" : "Deny"}</button></form>`
            : "<!doctype html><p>Already answered.</p>"
          return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" } })
        }
        if (req.method !== "POST") return new Response(null, { status: 405 })
        const ok = await respond(agentId, requestId, decision)
        return new Response(ok ? `${decision === "allow" ? "Allowed" : "Denied"} ✓` : "Already answered", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        })
      }
      if (!path.startsWith("/api/")) return new Response("not found", { status: 404 })
      if (!authed(req, url)) return json({ error: "unauthorized" }, 401)
      // the person on the other end, as they introduced themselves (shared runs)
      const who = (req.headers.get("x-baton-user") ?? "").trim().slice(0, 40) || undefined
      try {
        if (req.method === "GET" && path === "/api/view") return json(remoteView(rt))
        if (req.method === "GET" && path === "/api/stream") return stream(rt, req.signal, who)
        if (req.method !== "POST") return json({ error: "method not allowed" }, 405)
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
        switch (path) {
          case "/api/submit": {
            const text = String(body.text ?? "").trim()
            if (!text) return json({ error: "empty" }, 400)
            return json(await handleInput(rt, text, { who }))
          }
          case "/api/respond":
            return json({ ok: await respond(String(body.agentId), String(body.requestId), String(body.decision ?? body.optionId), who) })
          case "/api/autonomy": {
            const mode = String(body.mode)
            if (!["normal", "ask", "auto", "yolo"].includes(mode)) return json({ error: "bad mode" }, 400)
            return json(await rt.setAutonomy(mode as "normal"))
          }
          case "/api/merge":
            return json(await rt.collab.merge(String(body.agentId)))
          case "/api/interrupt":
            await rt.interrupt(String(body.agentId))
            return json({ ok: true })
          case "/api/plan":
            return json({ ok: rt.collab.decidePlan(body.approve === true, typeof body.notes === "string" ? body.notes : undefined) })
        }
        return json({ error: "not found" }, 404)
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) }, 400)
      }
    },
  })
  const port = server.port as number
  const scheme = certificate ? "https" : "http"
  const local = `${scheme}://127.0.0.1:${port}`
  const lanUrls = opts.lan ? lanAddresses().map((a) => `${scheme}://${a}:${port}/#t=${token}`) : []
  return {
    url: opts.lan && lanAddresses()[0] ? `${scheme}://${lanAddresses()[0]}:${port}` : local,
    openUrl: lanUrls[0] ?? `${local}/#t=${token}`,
    lanUrls,
    port,
    lan: !!opts.lan,
    tls: !!certificate,
    fingerprint: certificate?.fingerprint,
    stop: () => server.stop(true),
  }
}

/** Newline-delimited JSON views, pushed when the run changes (at most ~4 per second). */
function stream(rt: Runtime, signal: AbortSignal, who?: string): Response {
  const viewerId = `web_${Math.random().toString(36).slice(2)}`
  if (who) rt.joinViewer(viewerId, who, "web")
  signal.addEventListener("abort", () => rt.leaveViewer(viewerId), { once: true })
  const enc = new TextEncoder()
  let timer: ReturnType<typeof setTimeout> | undefined
  let off: (() => void) | undefined
  let ping: ReturnType<typeof setInterval> | undefined
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = () => {
        timer = undefined
        try {
          ctrl.enqueue(enc.encode(`${JSON.stringify(remoteView(rt))}\n`))
        } catch {}
      }
      send()
      off = rt.store.subscribe(() => {
        if (!timer) timer = setTimeout(send, 250)
      })
      // keep proxies / phones from closing an idle connection
      ping = setInterval(() => {
        try {
          ctrl.enqueue(enc.encode("\n"))
        } catch {}
      }, 15_000)
      signal.addEventListener("abort", () => {
        off?.()
        if (timer) clearTimeout(timer)
        clearInterval(ping)
        try {
          ctrl.close()
        } catch {}
      })
    },
    cancel() {
      rt.leaveViewer(viewerId)
      off?.()
      if (timer) clearTimeout(timer)
      clearInterval(ping)
    },
  })
  return new Response(body, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } })
}

// ───────────────────────────── lifecycle ─────────────────────────────

const running = new WeakMap<Runtime, RemoteServer>()

export function remoteServer(rt: Runtime): RemoteServer | undefined {
  return running.get(rt)
}

/** Start the web view (or return the running one; a different `lan` setting restarts it). */
export function ensureRemote(rt: Runtime, opts: { lan?: boolean; port?: number; rotate?: boolean; tls?: boolean; tailscale?: boolean } = {}): RemoteServer {
  const lan = opts.lan ?? rt.config.remote.lan
  const port = opts.port ?? rt.config.remote.port
  const tls = opts.tls ?? rt.config.remote.tls === "self-signed"
  const tailscale = opts.tailscale ?? rt.config.remote.tailscale
  const cur = running.get(rt)
  if (cur && !opts.rotate && cur.lan === lan && cur.tls === tls && !!cur.publicUrl === tailscale && (!port || cur.port === port)) return cur
  cur?.stop()
  if (cur?.publicUrl) tailscaleUnserve()
  if (opts.rotate) remoteSecrets(rt.projectRoot, true)
  // tailscale terminates TLS itself and proxies to the local (plain) server
  const s = startRemoteServer(rt, { lan, port: port || cur?.port || 0, tls: tls && !tailscale })
  if (tailscale) {
    try {
      s.publicUrl = tailscaleServe(s.port)
      s.openUrl = `${s.publicUrl}/#t=${remoteSecrets(rt.projectRoot).token}`
      s.url = s.publicUrl
    } catch (e) {
      s.stop()
      throw e
    }
  }
  running.set(rt, s)
  rt.emit({ type: "log", data: { level: "info", message: `web view at ${s.url}${lan ? " (reachable on your network)" : ""}` } })
  return s
}

export function stopRemote(rt: Runtime): void {
  if (running.get(rt)?.publicUrl) tailscaleUnserve()
  running.get(rt)?.stop()
  running.delete(rt)
}

/** Signed one-tap approve / deny links for a pending request, if phones can reach the web view. */
export function approvalLinks(rt: Runtime, agentId: string, requestId: string): { allow: string; deny: string } | undefined {
  const s = running.get(rt)
  const base = rt.config.remote.public_url?.replace(/\/$/, "") ?? s?.publicUrl ?? (s?.lan ? s.url : undefined)
  if (!base) return undefined
  const { secret } = remoteSecrets(rt.projectRoot)
  const link = (d: "allow" | "deny") => `${base}/act/${agentId}/${requestId}/${d}?sig=${signAction(secret, agentId, requestId, d)}`
  return { allow: link("allow"), deny: link("deny") }
}
