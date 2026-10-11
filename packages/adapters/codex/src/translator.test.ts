import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@batonsh/protocol"
import { replay } from "./fixtures/replay.ts"
import { CodexTranslator, changeContent, isReadOnlyCommand, unwrapShell } from "./translator.ts"

type Of<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>
const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) => events.filter((e) => e.type === type) as Of<T>[]

function make(opts: { keepRaw?: boolean } = {}) {
  const events: AgentEvent[] = []
  const t = new CodexTranslator((e) => events.push(e), opts)
  t.setThread("thr_1")
  return { t, events }
}

const turn = (id: string, status: "inProgress" | "completed" | "interrupted" | "failed", error: unknown = null) => ({
  threadId: "thr_1",
  turn: { id, rootTurnId: id, items: [], itemsView: "notLoaded", status, error, startedAt: null, completedAt: null, durationMs: null },
})

describe("fixture: edit-with-approval (shell commands behind approvals)", () => {
  const { events, answers } = replay("edit-with-approval")

  test("session, turn lifecycle and status transitions", () => {
    expect(ofType(events, "agent.session").map((e) => e.data.sessionId)).toEqual(["01a129ca-c714-7d82-874b-6482189da67e"])
    const started = ofType(events, "turn.started")
    expect(started).toHaveLength(1)
    expect(started[0]?.data.prompt).toStartWith("Run `wc -l notes.txt` once")
    expect(ofType(events, "turn.completed").map((e) => e.data.stopReason)).toEqual(["end_turn"])
    expect(ofType(events, "agent.status").map((e) => e.data.status)).toEqual([
      "ready",
      "busy",
      "awaiting_approval",
      "busy",
      "awaiting_approval",
      "busy",
      "ready",
    ])
  })

  test("commands become execute tool calls with unwrapped titles and terminal output", () => {
    const calls = ofType(events, "tool.call")
    expect(calls.map((c) => [c.data.kind, c.data.name, c.data.title])).toEqual([
      ["execute", "Bash", "wc -l notes.txt"],
      ["execute", "Bash", "sed -i '' 's/teh/the/g' notes.txt"],
    ])
    const done = ofType(events, "tool.update").filter((u) => u.data.status === "completed")
    expect(done).toHaveLength(2)
    const term = done[0]?.data.content?.[0]
    expect(term?.type).toBe("terminal")
    if (term?.type === "terminal") {
      expect(term.output).toContain("notes.txt")
      expect(term.exitCode).toBe(0)
      expect(term.command).toBe("wc -l notes.txt")
    }
    expect(done[0]?.data.summary).toContain("notes.txt")
    expect(done[1]?.data.summary).toBe("No output")
  })

  test("approvals surface as ACP-shaped permissions and answers round-trip", () => {
    const reqs = ofType(events, "permission.requested")
    expect(reqs.map((r) => r.data.title)).toEqual(["Run wc -l notes.txt", "Run sed -i '' 's/teh/the/g' notes.txt"])
    expect(reqs[0]?.data.kind).toBe("execute")
    expect(reqs[0]?.data.toolCallId).toBe(ofType(events, "tool.call")[0]?.data.toolCallId)
    expect(reqs[0]?.data.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"])
    expect(ofType(events, "permission.resolved").map((r) => [r.data.kind, r.data.by])).toEqual([
      ["allow_once", "user"],
      ["allow_once", "user"],
    ])
    expect(answers).toHaveLength(2)
    for (const a of answers) expect(a.computed).toEqual(a.recorded)
  })

  test("assistant messages stream and complete", () => {
    const completed = ofType(events, "message.completed")
    expect(completed.map((m) => m.data.role)).toEqual(["assistant", "assistant"])
    const last = completed[1]
    const deltas = ofType(events, "message.delta").filter((d) => d.data.messageId === last?.data.messageId)
    expect(deltas.map((d) => d.data.text).join("")).toBe(last?.data.text ?? "")
    expect(last?.data.text).toContain("the")
  })

  test("usage is cumulative with cached input split out", () => {
    const u = ofType(events, "usage.updated")
    expect(u).toHaveLength(3)
    expect(u[2]?.data).toEqual({ input: 40971 - 37120, cachedInput: 37120, output: 194, reasoning: 0, source: "reported", mode: "cumulative" })
    expect(u[2]?.data.costUsd).toBeUndefined()
  })
})

describe("fixture: apply-patch (fileChange items)", () => {
  const { events, answers } = replay("apply-patch")

  test("fileChange becomes an edit tool call with per-file diffs", () => {
    const edit = ofType(events, "tool.call").find((c) => c.data.kind === "edit")
    expect(edit?.data.name).toBe("apply_patch")
    expect(edit?.data.title).toBe("Edit 2 files")
    expect(edit?.data.locations?.map((l) => l.path)).toEqual(["/workspace/hello.txt", "/workspace/notes.txt"])

    const final = ofType(events, "tool.update").find((u) => u.data.toolCallId === edit?.data.toolCallId && u.data.status === "completed")
    expect(final?.data.summary).toBe("2 files +2 -1")
    const [add, upd] = final?.data.content ?? []
    expect(add).toMatchObject({ type: "diff", path: "/workspace/hello.txt", oldText: null, newText: "hi\n", added: 1, removed: 0 })
    expect(upd).toMatchObject({ type: "diff", path: "/workspace/notes.txt", added: 1, removed: 1 })
    if (upd?.type === "diff") {
      expect(upd.lines).toEqual([
        { kind: "del", text: "teh quick brown fox", oldLine: 1 },
        { kind: "add", text: "the quick brown fox", newLine: 1 },
        { kind: "ctx", text: "jumps", oldLine: 2, newLine: 2 },
      ])
    }
    // Diff is available before approval (on item/started) too.
    const early = ofType(events, "tool.update").find((u) => u.data.toolCallId === edit?.data.toolCallId)
    expect(early?.data.status).toBeUndefined()
    expect(early?.data.content).toHaveLength(2)
  })

  test("file change approval is an edit permission linked to the tool call", () => {
    const req = ofType(events, "permission.requested").find((r) => r.data.kind === "edit")
    expect(req?.data.title).toBe("Edit 2 files")
    expect(answers.map((a) => a.method)).toEqual(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"])
    for (const a of answers) expect(a.computed).toEqual(a.recorded)
  })

  test("cat is a read with a location", () => {
    const cat = ofType(events, "tool.call")[0]
    expect(cat?.data.title).toBe("cat notes.txt")
    expect(cat?.data.locations).toEqual([{ path: "/workspace/notes.txt" }])
  })

  test("reasoning tokens are reported", () => {
    const u = ofType(events, "usage.updated").at(-1)
    expect(u?.data.reasoning).toBe(15)
  })
})

describe("fixture: interrupt", () => {
  const { events } = replay("interrupt")

  test("interrupted turn closes open content and ends with turn.interrupted alone", () => {
    const types = events.map((e) => e.type).filter((t) => t.startsWith("turn.") || t === "message.completed")
    expect(types).toEqual(["turn.started", "message.completed", "turn.interrupted"])
    expect(ofType(events, "turn.completed")).toEqual([])
    expect(ofType(events, "agent.status").at(-1)?.data.status).toBe("ready")
  })
})

describe("raw passthrough", () => {
  test("raw is attached only when keepRaw is set", () => {
    expect(replay("interrupt").events.some((e) => e.raw !== undefined)).toBe(false)
    const withRaw = replay("interrupt", { keepRaw: true }).events
    expect(withRaw.find((e) => e.type === "turn.started")?.raw).toMatchObject({ method: "turn/started" })
  })
})

describe("permission mapping", () => {
  const cmdParams = {
    kind: "command",
    threadId: "thr_1",
    turnId: "t1",
    itemId: "c1",
    startedAtMs: 0,
    environmentId: null,
    command: "/bin/zsh -lc 'rm -rf build'",
    cwd: "/w",
  }

  test.each([
    ["allow_once", "accept"],
    ["allow_always", "acceptForSession"],
    ["reject_once", "decline"],
    ["reject_always", "decline"],
    [null, "cancel"],
  ] as const)("command approval %s → %s", (option, decision) => {
    const { t, events } = make()
    const r = t.serverRequest(7, "item/commandExecution/requestApproval", cmdParams)
    expect(r).toBeDefined()
    const ans = t.resolvePermission(r?.requestId ?? "", option)
    expect(ans).toEqual({ rpcId: 7, result: { decision } })
    const resolved = ofType(events, "permission.resolved")[0]
    expect(resolved?.data.by).toBe(option === null ? "cancelled" : "user")
    expect(t.resolvePermission(r?.requestId ?? "", option)).toBeUndefined()
  })

  test("request ids are unique across Codex processes (two workers' requests never replace each other)", () => {
    const one = make().t.serverRequest(1, "item/commandExecution/requestApproval", cmdParams)
    const two = make().t.serverRequest(1, "item/commandExecution/requestApproval", cmdParams)
    expect(one?.requestId).toBeDefined()
    expect(one?.requestId).not.toBe(two?.requestId)
  })

  test("file change approval uses the same decisions", () => {
    const { t } = make()
    const r = t.serverRequest(1, "item/fileChange/requestApproval", { threadId: "thr_1", turnId: "t", itemId: "f1", startedAtMs: 0 })
    expect(t.resolvePermission(r?.requestId ?? "", "allow_always")?.result).toEqual({ decision: "acceptForSession" })
  })

  test("permissions request grants the requested profile for turn or session", () => {
    const params = {
      threadId: "thr_1",
      turnId: "t",
      itemId: "p1",
      environmentId: null,
      startedAtMs: 0,
      cwd: "/w",
      reason: "needs network",
      permissions: { network: { enabled: true }, fileSystem: null },
    }
    const { t, events } = make()
    const a = t.serverRequest(1, "item/permissions/requestApproval", params)
    expect(ofType(events, "permission.requested")[0]?.data.title).toBe("Grant network access")
    expect(t.resolvePermission(a?.requestId ?? "", "allow_always")?.result).toEqual({ permissions: { network: { enabled: true } }, scope: "session" })
    const b = t.serverRequest(2, "item/permissions/requestApproval", params)
    expect(t.resolvePermission(b?.requestId ?? "", "reject_once")?.result).toEqual({ permissions: {}, scope: "turn" })
  })

  test("MCP elicitation → accept/decline/cancel", () => {
    const { t } = make()
    const params = { threadId: "thr_1", turnId: null, serverName: "baton", mode: "form", _meta: null, message: "Confirm?", requestedSchema: {} }
    const a = t.serverRequest(1, "mcpServer/elicitation/request", params)
    expect(t.resolvePermission(a?.requestId ?? "", "allow_once")?.result).toEqual({ action: "accept", content: {}, _meta: null })
    const b = t.serverRequest(2, "mcpServer/elicitation/request", params)
    expect(t.resolvePermission(b?.requestId ?? "", null)?.result).toEqual({ action: "cancel", content: null, _meta: null })
  })

  test("user-input questions map choices to options", () => {
    const { t, events } = make()
    const params = {
      threadId: "thr_1",
      turnId: "t",
      itemId: "q",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "q1",
          header: "Mode",
          question: "Which?",
          isOther: false,
          isSecret: false,
          options: [
            { label: "A", description: "" },
            { label: "B", description: "" },
          ],
        },
      ],
    }
    const r = t.serverRequest(1, "item/tool/requestUserInput", params)
    const req = ofType(events, "permission.requested")[0]
    expect(req?.data.options.map((o) => o.name)).toEqual(["A", "B", "Skip"])
    expect(t.resolvePermission(r?.requestId ?? "", "choice:1")?.result).toEqual({ answers: { q1: { answers: ["B"] } } })
  })

  test("legacy v1 approvals map to ReviewDecision", () => {
    const { t } = make()
    const r = t.serverRequest(1, "execCommandApproval", {
      conversationId: "c",
      callId: "x",
      approvalId: null,
      command: ["ls"],
      cwd: "/",
      reason: null,
      parsedCmd: [],
    })
    expect(t.resolvePermission(r?.requestId ?? "", "allow_always")?.result).toEqual({ decision: "approved_for_session" })
  })

  test("unsupported requests are not turned into permissions", () => {
    const { t, events } = make()
    expect(t.serverRequest(1, "account/chatgptAuthTokens/refresh", {})).toBeUndefined()
    expect(ofType(events, "permission.requested")).toHaveLength(0)
  })

  test("serverRequest/resolved and turn end drop pending permissions", () => {
    const { t, events } = make()
    t.notification("turn/started", turn("t1", "inProgress"))
    const a = t.serverRequest(5, "item/commandExecution/requestApproval", cmdParams)
    t.serverRequest(6, "item/commandExecution/requestApproval", { ...cmdParams, itemId: "c2" })
    expect(t.pendingPermissionCount).toBe(2)
    t.notification("serverRequest/resolved", { threadId: "thr_1", requestId: 5 })
    expect(t.pendingPermissionCount).toBe(1)
    expect(t.resolvePermission(a?.requestId ?? "", "allow_once")).toBeUndefined()
    t.notification("turn/completed", turn("t1", "interrupted"))
    expect(t.pendingPermissionCount).toBe(0)
    expect(ofType(events, "permission.resolved").map((e) => e.data.by)).toEqual(["cancelled", "cancelled"])
  })

  test("cancelAll answers every pending request with cancel", () => {
    const { t } = make()
    t.serverRequest(1, "item/commandExecution/requestApproval", cmdParams)
    t.serverRequest(2, "item/fileChange/requestApproval", { threadId: "thr_1", turnId: "t", itemId: "f", startedAtMs: 0 })
    expect(t.cancelAll()).toEqual([
      { rpcId: 1, result: { decision: "cancel" } },
      { rpcId: 2, result: { decision: "cancel" } },
    ])
  })
})

describe("notification mapping", () => {
  test("reasoning summaries stream as thoughts", () => {
    const { t, events } = make()
    const base = { threadId: "thr_1", turnId: "t1", itemId: "r1" }
    t.notification("item/started", { ...base, item: { type: "reasoning", id: "r1", summary: [], content: [] }, startedAtMs: 0 })
    t.notification("item/reasoning/summaryTextDelta", { ...base, delta: "Looking", summaryIndex: 0 })
    t.notification("item/reasoning/summaryPartAdded", { ...base, summaryIndex: 1 })
    t.notification("item/reasoning/summaryTextDelta", { ...base, delta: "Done", summaryIndex: 1 })
    t.notification("item/completed", { ...base, item: { type: "reasoning", id: "r1", summary: ["Looking", "Done"], content: [] }, completedAtMs: 0 })
    expect(ofType(events, "message.delta").map((d) => [d.data.role, d.data.text])).toEqual([
      ["thought", "Looking"],
      ["thought", "\n\n"],
      ["thought", "Done"],
    ])
    expect(ofType(events, "message.completed")).toEqual([{ type: "message.completed", data: { messageId: "r1", role: "thought", text: "Looking\n\nDone" } }])
  })

  test("plan updates map statuses", () => {
    const { t, events } = make()
    t.notification("turn/plan/updated", {
      threadId: "thr_1",
      turnId: "t",
      explanation: null,
      plan: [
        { step: "a", status: "completed" },
        { step: "b", status: "inProgress" },
        { step: "c", status: "pending" },
      ],
    })
    expect(ofType(events, "plan.updated")[0]?.data.entries).toEqual([
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress" },
      { content: "c", status: "pending" },
    ])
  })

  test("command output deltas accumulate into terminal content; failures summarize the exit code", () => {
    const { t, events } = make()
    const item = {
      type: "commandExecution",
      id: "c1",
      pluginId: null,
      scriptPath: null,
      command: "/bin/bash -lc 'make test'",
      cwd: "/w",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [{ type: "unknown", command: "make test" }],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    }
    t.notification("item/started", { threadId: "thr_1", turnId: "t", item, startedAtMs: 0 })
    t.notification("item/commandExecution/outputDelta", { threadId: "thr_1", turnId: "t", itemId: "c1", delta: "a\n" })
    t.notification("item/commandExecution/outputDelta", { threadId: "thr_1", turnId: "t", itemId: "c1", delta: "b\n" })
    t.notification("item/completed", {
      threadId: "thr_1",
      turnId: "t",
      item: { ...item, status: "failed", aggregatedOutput: "a\nb\n", exitCode: 2 },
      completedAtMs: 0,
    })
    const ups = ofType(events, "tool.update")
    expect(ups[1]?.data.content?.[0]).toMatchObject({ type: "terminal", output: "a\nb\n" })
    expect(ups[2]?.data).toMatchObject({ status: "failed", summary: "exit 2" })
  })

  test("MCP tool calls carry server/tool names and text results", () => {
    const { t, events } = make()
    const item = {
      type: "mcpToolCall",
      id: "m1",
      server: "baton",
      tool: "send",
      status: "inProgress",
      arguments: { to: "*" },
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: null,
      result: null,
      error: null,
      durationMs: null,
    }
    t.notification("item/started", { threadId: "thr_1", turnId: "t", item, startedAtMs: 0 })
    t.notification("item/completed", {
      threadId: "thr_1",
      turnId: "t",
      item: { ...item, status: "completed", result: { content: [{ type: "text", text: "sent" }], structuredContent: null, _meta: null } },
      completedAtMs: 0,
    })
    expect(ofType(events, "tool.call")[0]?.data).toMatchObject({ name: "mcp__baton__send", title: "baton.send", kind: "other", rawInput: { to: "*" } })
    expect(ofType(events, "tool.update")[0]?.data).toMatchObject({ status: "completed", content: [{ type: "text", text: "sent" }] })
  })

  test("web search is a fetch", () => {
    const { t, events } = make()
    t.notification("item/completed", {
      threadId: "thr_1",
      turnId: "t",
      item: { type: "webSearch", id: "w1", query: "bun", action: { type: "search", query: "bun docs", queries: null }, results: null },
      completedAtMs: 0,
    })
    expect(ofType(events, "tool.call")[0]?.data).toMatchObject({ kind: "fetch", title: 'Search "bun docs"' })
    expect(ofType(events, "tool.update")[0]?.data.status).toBe("completed")
  })

  test("errors: retries are logged, terminal errors emitted, failed turns stop with error", () => {
    const logs: string[] = []
    const events: AgentEvent[] = []
    const t = new CodexTranslator((e) => events.push(e), { log: (_l, m) => logs.push(m) })
    const err = { message: "boom", codexErrorInfo: null, additionalDetails: "details", misalignment: null }
    t.notification("error", { error: err, willRetry: true, threadId: "thr_1", turnId: "t" })
    expect(ofType(events, "error")).toHaveLength(0)
    expect(logs.some((l) => l.includes("retry"))).toBe(true)
    t.notification("turn/started", turn("t2", "inProgress"))
    t.notification("turn/completed", turn("t2", "failed", err))
    expect(ofType(events, "error")[0]?.data).toEqual({ message: "boom", detail: "details" })
    expect(ofType(events, "turn.completed")[0]?.data.stopReason).toBe("error")
  })

  test("unknown notifications are ignored", () => {
    const { t, events } = make()
    const n = events.length
    t.notification("something/new", { x: 1 })
    expect(events.length).toBe(n)
  })

  test("shell edits become a nested edit tool call", () => {
    const { t, events } = make()
    t.shellEdits("c1", [
      {
        path: "/w/a.txt",
        lines: [
          { kind: "del", text: "teh", oldLine: 1 },
          { kind: "add", text: "the", newLine: 1 },
        ],
        added: 1,
        removed: 1,
        created: false,
        deleted: false,
      },
    ])
    expect(ofType(events, "tool.call")[0]?.data).toMatchObject({ toolCallId: "c1:edit", parentToolCallId: "c1", kind: "edit", title: "Edit /w/a.txt" })
    expect(ofType(events, "tool.update")[0]?.data).toMatchObject({ status: "completed", summary: "Updated 2 lines (+1 -1)" })
  })
})

describe("helpers", () => {
  test("unwrapShell", () => {
    expect(unwrapShell("/bin/zsh -lc 'git diff --stat'")).toBe("git diff --stat")
    expect(unwrapShell(`/bin/zsh -lc "sed -i '' 's/a/b/' x"`)).toBe("sed -i '' 's/a/b/' x")
    expect(unwrapShell("bash -c 'echo '\\''hi'\\'''")).toBe("echo 'hi'")
    expect(unwrapShell("ls -la")).toBe("ls -la")
  })

  test("changeContent handles delete and move", () => {
    expect(changeContent({ path: "/w/x", kind: { type: "delete" }, diff: "a\nb\n" })).toMatchObject({ path: "/w/x", newText: "", added: 0, removed: 2 })
    expect(changeContent({ path: "/w/x", kind: { type: "update", move_path: "/w/y" }, diff: "@@ -1 +1 @@\n-a\n+b\n" })).toMatchObject({
      path: "/w/y",
      added: 1,
      removed: 1,
    })
  })

  test("isReadOnlyCommand", () => {
    const base = {
      type: "commandExecution",
      id: "c",
      pluginId: null,
      scriptPath: null,
      command: "",
      cwd: "/",
      processId: null,
      source: "agent",
      status: "completed",
      aggregatedOutput: null,
      exitCode: 0,
      durationMs: null,
    } as const
    expect(isReadOnlyCommand({ ...base, commandActions: [{ type: "read", command: "cat a", name: "a", path: "/a" }] })).toBe(true)
    expect(isReadOnlyCommand({ ...base, commandActions: [{ type: "unknown", command: "sed -i" }] })).toBe(false)
    expect(isReadOnlyCommand({ ...base, commandActions: [] })).toBe(false)
  })
})
