import { describe, expect, test } from "bun:test"
import { EventStore, RunState } from "@batonsh/kernel"
import { buildView, describeTool, parseRelay, shortenPaths, stripAnsi, webItem } from "./web-view.ts"

// shapes taken from a real project's event log
const WT = "C:\\Users\\me\\.local\\state\\baton\\worktrees\\trading-bot-b285159c\\codex-6"

describe("tool calls in words", () => {
  const d = (name: string, title: string, input?: unknown) => describeTool({ name, title, input }, "C:\\Users\\me\\Desktop\\trading-bot")

  test("Claude's tools", () => {
    expect(d("Bash", "Bash(cd /c/x; uv run pytest -q)")).toEqual({ verb: "Run", target: "cd /c/x; uv run pytest -q" })
    expect(d("Read", "Read(C:/Users/me/Desktop/trading-bot/src/tradebot/data/events.py)")).toEqual({ verb: "Read", target: "src/tradebot/data/events.py" })
    expect(d("Write", "Write(tests/unit/engine/test_demo_mode.py)")).toEqual({ verb: "Write", target: "tests/unit/engine/test_demo_mode.py" })
    expect(d("Edit", "Update(docs/research/SMART_MONEY.md)")).toEqual({ verb: "Edit", target: "docs/research/SMART_MONEY.md" })
    expect(d("WebSearch", "WebSearch(ccxt python async websocket)")).toEqual({ verb: "Search the web", target: "ccxt python async websocket" })
    expect(d("WebFetch", "Fetch(https://arxiv.org/abs/1904.09950)")).toEqual({ verb: "Fetch", target: "https://arxiv.org/abs/1904.09950" })
    expect(d("Grep", "Grep(OrderUpdate\\( in src/tradebot)")).toEqual({ verb: "Search", target: "OrderUpdate\\( in src/tradebot" })
  })

  test("Codex: worktree paths, wrapped PowerShell, file counts", () => {
    expect(d("apply_patch", `Edit ${WT}\\scripts\\fetch_sources.py`)).toEqual({ verb: "Edit", target: "scripts\\fetch_sources.py" })
    expect(d("shell_edit", "Edit 2 files")).toEqual({ verb: "Edit", target: "2 files" })
    expect(d("shell", `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-ChildItem src'`)).toEqual({
      verb: "Run",
      target: "Get-ChildItem src",
    })
    expect(d("PowerShell", "PowerShell", { command: "git status --short" })).toEqual({ verb: "Run", target: "git status --short" })
  })

  test("Baton's own calls are coordination; other MCP tools say their server", () => {
    expect(d("mcp__baton__wait_for_results", "baton - wait_for_results (MCP)")).toEqual({ verb: "Wait for results", coord: true })
    expect(d("mcp__baton__submit_review", "baton.submit_review")).toEqual({ verb: "Review", coord: true })
    expect(d("mcp__github__create_issue", "github - create_issue (MCP)")).toEqual({ verb: "create issue", target: "github" })
    expect(d("acceptance", "Acceptance: uv run pytest -q")).toEqual({ verb: "Check", target: "uv run pytest -q" })
  })
})

describe("messages relayed between agents", () => {
  test("a result: outcome, lines changed, acceptance, unmerged work — without the instructions for the agent", () => {
    const r = parseRelay(
      '[message from claude-4]\n[baton] Result from claude-4:\nresult ok (+12 −5)\nNow the tests.\nacceptance ✓ `uv run pytest -q` passed\n[changes are in claude-4\'s own worktree — call merge("claude-4") to bring them into the project]\n\n(Reply with the baton send_message tool, to: "claude-4" — only if there\'s something to say: don\'t answer thanks or acknowledgments.)',
    )
    expect(r.handoffs).toEqual([
      {
        from: "claude-4",
        kind: "result",
        outcome: "ok",
        diff: { added: 12, removed: 5 },
        text: "Now the tests.",
        checks: [{ command: "uv run pytest -q", ok: true }],
        unmerged: true,
      },
    ])
  })

  test("several messages at once, and a failed check with its output", () => {
    const r = parseRelay(
      "[baton] 2 messages:\n\n— from claude-39 (chat):\nheads-up: adding AuthConfig\n\n— from codex-2 (result):\nresult failed\ntests broke\nacceptance ✗ `npm test` still failing (exit 1):\nFAIL a.test.ts\n\n(Reply with the baton send_message tool where needed — don't answer thanks or acknowledgments.)",
    )
    expect(r.handoffs?.map((h) => [h.from, h.kind, h.outcome ?? "", h.text])).toEqual([
      ["claude-39", "chat", "", "heads-up: adding AuthConfig"],
      ["codex-2", "result", "failed", "tests broke"],
    ])
    expect(r.handoffs?.[1]?.checks).toEqual([{ command: "npm test", ok: false, detail: "still failing (exit 1)\nFAIL a.test.ts" }])
  })

  test("a prompt from you stays text", () => {
    expect(parseRelay("add tests for the parser")).toEqual({ from: undefined, text: "add tests for the parser" })
  })
})

test("paths and escape codes", () => {
  expect(shortenPaths(`kept in ${WT} (branch x)`, undefined)).toBe("kept in  (branch x)")
  // only Baton's own worktrees, and only the whole project root
  expect(shortenPaths("see src/worktrees/foo/bar/baz.ts", undefined)).toBe("see src/worktrees/foo/bar/baz.ts")
  expect(shortenPaths("https://github.com/acme/worktrees/blob/main/README.md", undefined)).toBe("https://github.com/acme/worktrees/blob/main/README.md")
  expect(shortenPaths("/home/me/app/src/a.ts /home/me/app-old/b.ts", "/home/me/app")).toBe("src/a.ts /home/me/app-old/b.ts")
  const t = Date.now()
  shortenPaths(`${"/a".repeat(20000)} ${WT}\\x`, "/home/me/app")
  expect(Date.now() - t).toBeLessThan(300)
  expect(shortenPaths("C:\\Users\\me\\proj\\src\\a.ts and C:/Users/me/proj/b.ts", "C:\\Users\\me\\proj")).toBe("src\\a.ts and b.ts")
  expect(stripAnsi("\u001b[32m✓ ok\u001b[0m\rprogress")).toBe("✓ ok\nprogress")
})

describe("the view", () => {
  function run() {
    const store = new EventStore()
    const st = new RunState()
    store.subscribe((e) => st.apply(e))
    const id = store.createRun("/p")
    store.append(id, { type: "run.started", data: { cwd: "/p", mode: "orchestrator" } })
    store.append(
      id,
      { type: "agent.spawned", data: { agentId: "o", name: "orchestrator", adapter: "claude", cwd: "/p", isOrchestrator: true } },
      { agentId: "o" },
    )
    store.append(id, { type: "agent.spawned", data: { agentId: "w", name: "codex-1", adapter: "codex", cwd: "/p" } }, { agentId: "w" })
    return { store, st, id }
  }

  test("feeds go out once per change, per connection", () => {
    const { store, st, id } = run()
    store.append(id, { type: "turn.started", data: { turnId: "t", prompt: "build it" } }, { agentId: "o" })
    const sent = new Map<string, number>()
    const push = () => {
      const versions = new Map<string, number>()
      const v = buildView(st, { sent, versions })
      for (const [k, n] of versions) sent.set(k, n)
      return v
    }
    const first = push()
    expect(Object.keys(first.feeds).sort()).toEqual(["o", "w"])
    expect(first.feeds.o?.[0]).toMatchObject({ k: "prompt", text: "build it" })
    expect(Object.keys(push().feeds)).toEqual([])
    store.append(id, { type: "message.completed", data: { messageId: "m", role: "assistant", text: "on it" } }, { agentId: "w" })
    expect(Object.keys(push().feeds)).toEqual(["w"])
    // a view that was built but never delivered doesn't count
    store.append(id, { type: "message.completed", data: { messageId: "m2", role: "assistant", text: "again" } }, { agentId: "w" })
    buildView(st, { sent, versions: new Map() })
    expect(Object.keys(push().feeds)).toEqual(["w"])
    // another connection gets everything
    expect(Object.keys(buildView(st, { sent: new Map() }).feeds).sort()).toEqual(["o", "w"])
  })

  test("agents, the lead and heartbeat-free bus", () => {
    const { store, st, id } = run()
    store.append(id, { type: "bus.message", data: { messageId: "b1", from: "o", to: "w", kind: "heartbeat", body: "♥", delivery: "queue" } })
    store.append(id, { type: "bus.message", data: { messageId: "b2", from: "w", to: "o", kind: "result", body: "result ok (+1 −0)\ndone", delivery: "queue" } })
    const v = buildView(st)
    expect(v.lead?.name).toBe("orchestrator")
    expect(v.agents.map((a) => a.name)).toEqual(["codex-1"])
    expect(v.bus.map((m) => [m.from, m.to, m.h.outcome])).toEqual([["codex-1", "lead", "ok"]])
  })

  test("a feed item for each kind", () => {
    const ctx = { name: (x: string) => x }
    expect(webItem({ kind: "user", id: "u", text: '[baton] Team "x" is ready', ts: 1 }, ctx)[0]).toMatchObject({ k: "handoff", h: { kind: "system" } })
    expect(
      webItem(
        { kind: "tool", id: "t", toolKind: "execute", name: "Bash", title: "Bash(ls)", status: "completed", diffs: [], output: "\u001b[1ma\u001b[0m", ts: 1 },
        ctx,
      )[0],
    ).toMatchObject({ k: "tool", verb: "Run", target: "ls", output: "a" })
  })
})
