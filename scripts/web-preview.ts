/**
 * Look at the web view with a real run, no daemon needed:
 *   bun scripts/web-preview.ts <path/to/state.db> [run-id] [--port 4545]
 * Serves the page with that run's state (the newest run by default); actions only show what
 * they would have sent. Open http://127.0.0.1:4545/#/inbox (or #/lead, #/agents, #/activity…).
 * Use a copy of the log: opening it can upgrade it.
 */

import { REMOTE_PAGE } from "../packages/daemon/src/remote-page.ts"
import { buildView } from "../packages/daemon/src/web-view.ts"
import { EventStore, RunState } from "../packages/kernel/src/index.ts"

const args = process.argv.slice(2)
const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 4545
const [path, want] = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--port")
if (!path) throw new Error("usage: bun scripts/web-preview.ts <state.db> [run-id] [--port 4545]")
const store = new EventStore(path)
const runs = store.listRuns(50)
const run = want ? runs.find((r) => r.runId === want || r.runId.endsWith(want)) : runs.find((r) => r.lastSeq > 0)
if (!run) throw new Error(`no run ${want ?? ""} in ${path}`)
const st = new RunState()
for (const e of store.query({ runId: run.runId })) st.apply(e)
const view = () => buildView(st)
console.log(`${run.runId}: ${st.agents.size} agents — http://127.0.0.1:${port}/#/inbox`)

// the preview has no login: a token and a name are set before the page starts
const page = (host: string) =>
  REMOTE_PAGE.replace(
    "<script>(",
    `<script>localStorage.setItem(${JSON.stringify(`baton-token:${host}`)}, "preview"); localStorage.setItem("baton:name", '"preview"')</script><script>(`,
  )

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/") return new Response(page(url.host), { headers: { "content-type": "text/html; charset=utf-8" } })
    if (url.pathname === "/api/view") return Response.json(view())
    if (url.pathname === "/api/stream")
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(`${JSON.stringify(view())}\n`))
          },
        }),
        { headers: { "content-type": "application/x-ndjson" } },
      )
    if (req.method === "POST") {
      const body = await req.json().catch(() => ({}))
      return Response.json({ ok: true, status: "preview", output: `preview — would send ${url.pathname} ${JSON.stringify(body)}` })
    }
    return new Response("not found", { status: 404 })
  },
})
