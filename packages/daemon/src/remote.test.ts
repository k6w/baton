import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Daemon, startDaemon } from "./daemon.ts"
import { approvalLinks, ensureRemote, qrLines, type RemoteServer, remoteSecrets, stopRemote } from "./remote.ts"

let d: Daemon
let web: RemoteServer
let token: string

beforeAll(async () => {
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-remote-"))
  d = await startDaemon({
    projectRoot: root,
    ephemeral: true,
    socketPath: join(root, "r.sock"),
    overrides: { orchestrator: { agent: "mock" }, bus: { heartbeat_s: 0 }, workspace: { isolation: "shared" } },
  })
  web = ensureRemote(d.runtime)
  token = remoteSecrets(d.runtime.projectRoot).token
})

afterAll(async () => {
  stopRemote(d.runtime)
  await d?.stop()
})

const base = () => `http://127.0.0.1:${web.port}`
const api = (path: string, body?: unknown, auth = true) =>
  fetch(`${base()}${path}`, {
    method: body ? "POST" : "GET",
    headers: { ...(auth ? { Authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })

describe("web view", () => {
  test("local only by default; the page loads without a token, the API needs one", async () => {
    expect(web.lan).toBe(false)
    expect(web.openUrl).toBe(`http://127.0.0.1:${web.port}/#t=${token}`)
    const page = await fetch(base())
    expect(page.headers.get("content-type")).toContain("text/html")
    expect(await page.text()).toContain("baton")
    expect((await api("/api/view", undefined, false)).status).toBe(401)
    expect((await fetch(`${base()}/api/view`, { headers: { Authorization: "Bearer nope" } })).status).toBe(401)
    const v = (await (await api("/api/view")).json()) as { project: string; autonomy: string }
    expect(v.autonomy).toBe("normal")
  })

  test("send a task, switch autonomy, answer an approval", async () => {
    const w = await d.runtime.spawn({ adapter: "mock", name: "w", options: { speed: 0 } })
    const r = (await (await api("/api/submit", { text: "@w hello" })).json()) as { routedTo: string[] }
    expect(r.routedTo).toEqual(["w"])
    expect(((await (await api("/api/autonomy", { mode: "auto" })).json()) as { mode: string }).mode).toBe("auto")
    expect(d.runtime.state.autonomy).toBe("auto")
    await api("/api/autonomy", { mode: "normal" })
    d.runtime.emit(
      {
        type: "permission.requested",
        data: {
          requestId: "rq1",
          title: "Bash(rm -rf build)",
          kind: "execute",
          options: [
            { optionId: "y", name: "Allow", kind: "allow_once" },
            { optionId: "n", name: "Deny", kind: "reject_once" },
          ],
        },
      },
      w.agentId,
    )
    const v = (await (await api("/api/view")).json()) as { attention: { kind: string; requestId?: string; options?: unknown[] }[] }
    const item = v.attention.find((a) => a.requestId === "rq1")
    expect(item?.kind).toBe("approval")
    expect(item?.options?.length).toBe(2)
    expect(((await (await api("/api/respond", { agentId: w.agentId, requestId: "rq1", decision: "deny" })).json()) as { ok: boolean }).ok).toBe(true)
    expect(d.runtime.state.approvals.has("rq1")).toBe(false)
  })

  test("one-tap links are signed per request; GET only confirms, POST answers", async () => {
    // links exist only when a phone can reach the web view
    expect(approvalLinks(d.runtime, "a", "b")).toBeUndefined()
    d.runtime.config.remote.public_url = "https://baton.example.ts.net/"
    const w = [...d.runtime.agents.values()].find((a) => a.info.name === "w")!
    d.runtime.emit(
      {
        type: "permission.requested",
        data: { requestId: "rq2", title: "Bash(make deploy)", kind: "execute", options: [{ optionId: "y", name: "Allow", kind: "allow_once" }] },
      },
      w.info.agentId,
    )
    const links = approvalLinks(d.runtime, w.info.agentId, "rq2")!
    expect(links.allow.startsWith("https://baton.example.ts.net/act/")).toBe(true)
    expect(links.allow).not.toContain(token)
    const local = (u: string) => u.replace("https://baton.example.ts.net", base())
    // tampering with the decision breaks the signature
    expect((await fetch(local(links.allow).replace("/allow?", "/deny?"), { method: "POST" })).status).toBe(403)
    // a link preview (GET) must not approve
    const get = await fetch(local(links.allow))
    expect(await get.text()).toContain("make deploy")
    expect(d.runtime.state.approvals.has("rq2")).toBe(true)
    const post = await fetch(local(links.allow), { method: "POST" })
    expect(await post.text()).toContain("Allowed")
    expect(d.runtime.state.approvals.has("rq2")).toBe(false)
    d.runtime.config.remote.public_url = undefined
  })

  test("the stream pushes a view right away", async () => {
    const ac = new AbortController()
    const res = await fetch(`${base()}/api/stream`, { headers: { Authorization: `Bearer ${token}` }, signal: ac.signal })
    const reader = res.body!.getReader()
    const { value } = await reader.read()
    const first = JSON.parse(new TextDecoder().decode(value).split("\n")[0]!) as { agents: { name: string }[] }
    expect(first.agents.some((a) => a.name === "w")).toBe(true)
    ac.abort()
  })

  test("QR codes have a quiet zone and square rows", () => {
    const q = qrLines("http://127.0.0.1:4777/#t=abc")
    expect(q.length).toBeGreaterThan(10)
    expect(new Set(q.map((l) => l.length)).size).toBe(1)
    expect(q[0]).toMatch(/^█+$/)
  })

  test("https: Baton's own certificate, its fingerprint, and the page served over TLS", async () => {
    const s = ensureRemote(d.runtime, { tls: true })
    expect(s.tls).toBe(true)
    expect(s.openUrl.startsWith("https://127.0.0.1:")).toBe(true)
    expect(s.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    const res = await fetch(`https://127.0.0.1:${s.port}/`, { tls: { rejectUnauthorized: false } } as RequestInit)
    expect(await res.text()).toContain("baton")
    // the certificate is reused across restarts (same fingerprint)
    stopRemote(d.runtime)
    expect(ensureRemote(d.runtime, { tls: true }).fingerprint).toBe(s.fingerprint)
    stopRemote(d.runtime)
    web = ensureRemote(d.runtime)
  })
})
