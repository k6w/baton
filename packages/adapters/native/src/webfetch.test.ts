import "./testing/env.ts"
import { afterAll, describe, expect, test } from "bun:test"
import { decodeEntities, htmlToText, isPrivateAddress, webFetch } from "./webfetch.ts"

const servers: { stop(): void }[] = []
afterAll(() => {
  for (const s of servers) s.stop()
})

function serve(handler: (req: Request, url: URL) => Response | Promise<Response>): string {
  const s = Bun.serve({ port: 0, idleTimeout: 0, fetch: (req) => handler(req, new URL(req.url)) })
  servers.push({ stop: () => s.stop(true) })
  return `http://127.0.0.1:${s.port}`
}

describe("html → text", () => {
  test("drops scripts/styles/nav, keeps headings, links, lists and code", () => {
    const html = `<!doctype html><html><head><title>Docs &amp; Things</title><style>body{color:red}</style><script>alert(1)</script></head>
<body><nav><a href="/home">Home</a> | <a href="/about">About</a></nav>
<main><h1>Getting  started</h1><p>Install with <code>bun add x</code> and read the <a href="/guide?a=1&amp;b=2">guide</a>.</p>
<ul><li>One</li><li>Two &lt;b&gt;</li></ul>
<pre><code class="language-ts">const a = 1 &lt; 2
if (a) {
  run()
}</code></pre>
<h2>API</h2><p>See <a href="#x">below</a> and <a href="javascript:void(0)">nothing</a>.</p>
<script type="module">evil()</script><noscript>enable js</noscript></main></body></html>`
    const r = htmlToText(html, "https://example.com/docs/")
    expect(r.title).toBe("Docs & Things")
    expect(r.text).toContain("# Getting started")
    expect(r.text).toContain("## API")
    expect(r.text).toContain("Install with `bun add x` and read the [guide](https://example.com/guide?a=1&b=2).")
    expect(r.text).toContain("- One\n- Two <b>")
    expect(r.text).toContain("```\nconst a = 1 < 2\nif (a) {\n  run()\n}\n```")
    expect(r.text).toContain("See below and nothing.")
    for (const gone of ["alert", "color:red", "Home", "About", "evil", "enable js"]) expect(r.text).not.toContain(gone)
    expect(decodeEntities("&#x41;&#66;&nbsp;&unknown;")).toBe("AB &unknown;")
  })
})

describe("web fetch", () => {
  test("SSRF guard: private/loopback addresses and non-http schemes are refused", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ])
      expect(isPrivateAddress(ip)).toBe(true)
    for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false)
    const base = serve(() => new Response("secret"))
    await expect(webFetch(`${base}/`)).rejects.toThrow(/private or loopback/)
    await expect(webFetch(base.replace("127.0.0.1", "localhost"))).rejects.toThrow(/local address/)
    await expect(webFetch("file:///etc/passwd")).rejects.toThrow(/only http/)
    await expect(webFetch("ftp://example.com/x")).rejects.toThrow(/only http/)
    expect((await webFetch(`${base}/`, { allowPrivate: true })).text).toBe("secret")
  })

  test("redirect hops are re-checked against the guard", async () => {
    const inner = serve(() => new Response("internal"))
    const requested: string[] = []
    // a public IP literal (no DNS) that redirects to a loopback address
    const redirecting = (async (u: URL | string) => {
      requested.push(String(u))
      return new Response(null, { status: 302, headers: { location: `${inner}/` } })
    }) as unknown as typeof fetch
    await expect(webFetch("https://93.184.215.14/", { fetch: redirecting })).rejects.toThrow(/private or loopback/)
    expect(requested).toEqual(["https://93.184.215.14/"])
  })

  test("follows up to 5 redirects, caps the body at 2 MB, converts HTML", async () => {
    const base = serve((_req, url) => {
      const m = /^\/r(\d+)$/.exec(url.pathname)
      if (m) {
        const n = Number(m[1])
        return new Response(null, { status: 302, headers: { location: n > 0 ? `/r${n - 1}` : "/page" } })
      }
      if (url.pathname === "/page") return new Response("<html><body><h1>Hi</h1><p>there</p></body></html>", { headers: { "content-type": "text/html" } })
      if (url.pathname === "/big") return new Response("x".repeat(3 * 1024 * 1024), { headers: { "content-type": "text/plain" } })
      if (url.pathname === "/bin") return new Response(new Uint8Array([0, 1, 2]), { headers: { "content-type": "application/octet-stream" } })
      return new Response("nope", { status: 404 })
    })
    const ok = await webFetch(`${base}/r4`, { allowPrivate: true })
    expect(ok.url).toBe(`${base}/page`)
    expect(ok.text).toBe("# Hi\n\nthere")
    await expect(webFetch(`${base}/r5`, { allowPrivate: true })).rejects.toThrow(/too many redirects/)
    const big = await webFetch(`${base}/big`, { allowPrivate: true })
    expect(big.truncated).toBe(true)
    expect(big.bytes).toBe(2 * 1024 * 1024)
    expect((await webFetch(`${base}/bin`, { allowPrivate: true })).text).toContain("binary content")
    expect((await webFetch(`${base}/missing`, { allowPrivate: true })).status).toBe(404)
  })

  test("times out", async () => {
    const base = serve(async () => {
      await Bun.sleep(2000)
      return new Response("late")
    })
    await expect(webFetch(`${base}/`, { allowPrivate: true, timeoutMs: 200 })).rejects.toThrow()
  })
})
