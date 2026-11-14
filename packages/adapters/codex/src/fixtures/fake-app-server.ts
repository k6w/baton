/**
 * Minimal scripted stand-in for `codex app-server`, used by session.test.ts.
 * FAKE_MODE: "normal" | "crash-on-turn" | "crash-mid-turn" | "slow-start" | "hang-interrupt" | "child-thread"
 *   | "startup-elicitation" (an MCP server asks for approval right after thread/start, outside any turn)
 */
const mode = process.env.FAKE_MODE ?? "normal"
const out = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`)
const turn = (id: string, status: string) => ({ id, status, items: [], error: null })
let turnSeq = 0
let current = ""
const dec = new TextDecoder()
let buf = ""
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk)
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    const msg = JSON.parse(line)
    if (msg.method === "initialize") out({ id: msg.id, result: {} })
    else if (msg.method === "thread/start" || msg.method === "thread/resume") {
      out({ method: "thread/started", params: { thread: { id: "thr_main" } } })
      out({ id: msg.id, result: { thread: { id: "thr_main" }, model: "m", approvalPolicy: "never" } })
      if (mode === "startup-elicitation")
        out({
          id: 0,
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thr_main",
            turnId: null,
            serverName: "docs",
            mode: "form",
            message: 'Allow the docs MCP server to run tool "search"?',
            requestedSchema: { type: "object", properties: {} },
            _meta: { codex_approval_kind: "mcp_tool_call", tool_params: { q: "x" } },
          },
        })
    } else if (msg.method === undefined && msg.id === 0 && mode === "startup-elicitation") {
      // the client's answer: echo it back so the test can see it arrived, then resolve the request
      out({ method: "warning", params: { threadId: "thr_main", message: `reply:${JSON.stringify(msg.result)}` } })
      out({ method: "serverRequest/resolved", params: { threadId: "thr_main", requestId: 0 } })
    } else if (msg.method === "turn/start") {
      if (mode === "crash-on-turn") process.exit(3)
      if (mode === "slow-start") await Bun.sleep(300)
      current = `t${++turnSeq}`
      out({ method: "turn/started", params: { threadId: "thr_main", turn: turn(current, "inProgress") } })
      out({ id: msg.id, result: { turn: turn(current, "inProgress") } })
      if (mode === "crash-mid-turn") {
        out({ method: "item/agentMessage/delta", params: { threadId: "thr_main", turnId: current, itemId: "m1", delta: "partial" } })
        await Bun.sleep(50)
        process.exit(5)
      }
      if (mode === "child-thread") {
        out({ method: "thread/started", params: { thread: { id: "thr_child" } } })
        out({ method: "turn/started", params: { threadId: "thr_child", turn: turn("c1", "inProgress") } })
        out({ method: "turn/completed", params: { threadId: "thr_child", turn: turn("c1", "completed") } })
        out({ method: "turn/completed", params: { threadId: "thr_main", turn: turn(current, "completed") } })
      }
      if (mode === "normal") out({ method: "turn/completed", params: { threadId: "thr_main", turn: turn(current, "completed") } })
    } else if (msg.method === "turn/interrupt") {
      if (mode === "hang-interrupt") continue
      out({ id: msg.id, result: {} })
      out({ method: "turn/completed", params: { threadId: "thr_main", turn: turn(current, "interrupted") } })
    }
  }
}

export {}
