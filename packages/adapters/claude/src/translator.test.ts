import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent, EventType } from "@batonsh/protocol"
import { DEFAULT_PERMISSION_OPTIONS, parseEventData } from "@batonsh/protocol"
import { ClaudeTranslator } from "./translator.ts"

type Ev<T extends EventType> = Extract<AgentEvent, { type: T }>

/** Replay a fixture (raw SDK messages + baton markers) through a fresh translator. */
function replay(name: string) {
  let n = 0
  const tr = new ClaudeTranslator({ cwd: "/work", id: (p) => `${p}_${++n}` })
  const events: AgentEvent[] = []
  const lines = readFileSync(join(import.meta.dir, "fixtures", name), "utf8")
    .trim()
    .split("\n")
  for (const line of lines) {
    const m = JSON.parse(line) as Record<string, unknown> & { type: string }
    if (m._baton === "prompt") events.push(...tr.userPrompt(String(m.uuid), String(m.text)))
    else if (m._baton === "permission") {
      const id = String(m.toolUseID)
      events.push(...tr.permissionRequested(`perm_${id}`, String(m.toolName), m.input as Record<string, unknown>, id, DEFAULT_PERMISSION_OPTIONS))
      events.push(...tr.setStatus("busy"), ...tr.toolStarted(id))
    } else if (m._baton === "interrupt") tr.markInterrupting()
    else events.push(...tr.handle(m))
  }
  const of = <T extends EventType>(t: T) => events.filter((e) => e.type === t) as Ev<T>[]
  const update = (id: string) => of("tool.update").filter((e) => e.data.toolCallId === id)
  const call = (id: string) => of("tool.call").find((e) => e.data.toolCallId === id)
  return { tr, events, of, update, call }
}

describe("fixture: tools.synthetic.jsonl", () => {
  const r = replay("tools.synthetic.jsonl")

  test("every event validates against the BEP schema", () => {
    for (const e of r.events) expect(() => parseEventData(e.type, e.data)).not.toThrow()
  })

  test("init → agent.session + agent.updated", () => {
    expect(r.of("agent.session").map((e) => e.data.sessionId)).toEqual(["5b0f8f0e-9a35-4b6e-8f60-3c1c7d1a0001"])
    // second (per-turn) init with identical model/version is deduplicated
    expect(r.of("agent.updated").map((e) => e.data)).toEqual([{ model: "claude-haiku-5-5", version: "2.1.296" }])
    expect(r.tr.sessionId).toBe("5b0f8f0e-9a35-4b6e-8f60-3c1c7d1a0001")
  })

  test("turn lifecycle: started/completed then started/interrupted", () => {
    const seq = r.events.filter((e) => e.type.startsWith("turn.")).map((e) => e.type)
    expect(seq).toEqual(["turn.started", "turn.completed", "turn.started", "turn.interrupted"])
    const [t1, t2] = r.of("turn.started")
    expect(t1?.data.prompt).toBe("Do the steps.")
    expect(r.of("turn.completed")[0]?.data).toEqual({ turnId: t1?.data.turnId ?? "", stopReason: "end_turn" })
    expect(r.of("turn.interrupted")[0]?.data.turnId).toBe(t2?.data.turnId)
  })

  test("status transitions busy → awaiting_approval → busy → ready", () => {
    const st = r.of("agent.status").map((e) => e.data.status)
    expect(st[0]).toBe("busy")
    expect(st).toContain("awaiting_approval")
    expect(st[st.length - 1]).toBe("ready")
    // never two identical statuses in a row
    for (let i = 1; i < st.length; i++) expect(st[i]).not.toBe(st[i - 1])
  })

  test("streamed deltas share message ids with completed messages", () => {
    const deltas = r.of("message.delta")
    const thought = deltas.filter((d) => d.data.role === "thought")
    expect(thought.map((d) => d.data.text).join("")).toBe("Plan the steps.")
    const text = deltas.filter((d) => d.data.role === "assistant")
    expect(text.map((d) => d.data.text).join("")).toBe("I'll start.DONE")
    const completed = r.of("message.completed").filter((e) => e.data.role !== "user")
    expect(completed.map((c) => [c.data.role, c.data.text])).toEqual([
      ["thought", "Plan the steps."],
      ["assistant", "I'll start."],
      ["assistant", "DONE"],
    ])
    for (const c of completed) {
      const ds = deltas.filter((d) => d.data.messageId === c.data.messageId)
      expect(ds.map((d) => d.data.text).join("")).toBe(c.data.text)
    }
  })

  test("subagent text is not surfaced as main-thread messages", () => {
    const texts = r.of("message.completed").map((e) => e.data.text)
    expect(texts).not.toContain("Reading app.ts.")
    expect(texts).not.toContain("add")
  })

  test("tool calls: kinds, names and Claude-Code-style titles", () => {
    const calls = r.of("tool.call").map((e) => [e.data.name, e.data.kind, e.data.title])
    expect(calls).toEqual([
      ["TodoWrite", "think", "Update Todos"],
      ["Read", "read", "Read(notes.txt)"],
      ["Edit", "edit", "Update(notes.txt)"],
      ["Write", "edit", "Write(hello.ts)"],
      ["Bash", "execute", "Bash(wc -l notes.txt)"],
      ["Agent", "delegate", "Agent(Find function name)"],
      ["Read", "read", "Read(app.ts)"],
      ["Bash", "execute", "Bash(ls missing-dir)"],
      ["mcp__baton__send_message", "other", "baton - send_message (MCP)"],
      ["TodoWrite", "think", "Update Todos"],
      ["Bash", "execute", "Bash(sleep 30)"],
    ])
    expect(r.call("toolu_read1")?.data.locations).toEqual([{ path: "/work/notes.txt" }])
  })

  test("subagent tool calls nest under the Agent call", () => {
    expect(r.call("toolu_sub_read")?.data.parentToolCallId).toBe("toolu_task1")
    expect(r.call("toolu_task1")?.data.parentToolCallId).toBeUndefined()
    expect(r.update("toolu_sub_read")[0]?.data.summary).toBe("Read 3 lines")
  })

  test("summaries", () => {
    const s = (id: string) => r.update(id).find((u) => u.data.status === "completed" || u.data.status === "failed")?.data.summary
    expect(s("toolu_read1")).toBe("Read 5 lines")
    expect(s("toolu_edit1")).toBe("Updated 1 line")
    expect(s("toolu_write1")).toBe("Wrote 2 lines")
    expect(s("toolu_bash1")).toBe("5 notes.txt")
    expect(s("toolu_task1")).toBe("Done (1 tool use · 4s)")
    expect(s("toolu_bash2")).toBe("Exit code 1")
    expect(s("toolu_mcp1")).toBe("delivered to 2 agents")
    expect(s("toolu_todo1")).toBe("Updated todos")
  })

  test("permission-approved tools go in_progress before completing", () => {
    expect(r.update("toolu_edit1").map((u) => u.data.status)).toEqual(["in_progress", "completed"])
    expect(r.update("toolu_read1").map((u) => u.data.status)).toEqual(["completed"])
    const p = r.of("permission.requested").find((e) => e.data.toolCallId === "toolu_bash1")
    expect(p?.data).toMatchObject({ title: "Bash(wc -l notes.txt)", kind: "execute" })
    expect(p?.data.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"])
  })

  test("Edit diff uses structuredPatch with real line numbers", () => {
    const diff = r
      .update("toolu_edit1")
      .flatMap((u) => u.data.content ?? [])
      .find((c) => c.type === "diff")
    expect(diff).toMatchObject({ type: "diff", path: "/work/notes.txt", added: 1, removed: 1 })
    if (diff?.type !== "diff") throw new Error("no diff")
    expect(diff.lines?.filter((l) => l.kind !== "ctx")).toEqual([
      { kind: "del", text: "teh quick brown fox", oldLine: 3 },
      { kind: "add", text: "the quick brown fox", newLine: 3 },
    ])
    expect(diff.lines?.[0]).toEqual({ kind: "ctx", text: "line one", oldLine: 1, newLine: 1 })
  })

  test("Write of a new file diffs against empty", () => {
    const diff = r
      .update("toolu_write1")
      .flatMap((u) => u.data.content ?? [])
      .find((c) => c.type === "diff")
    if (diff?.type !== "diff") throw new Error("no diff")
    expect(diff.oldText).toBeNull()
    expect(diff.added).toBe(2)
    expect(diff.lines?.map((l) => [l.kind, l.newLine])).toEqual([
      ["add", 1],
      ["add", 2],
    ])
  })

  test("Bash results carry terminal content; failures are failed with exit code", () => {
    const ok = r.update("toolu_bash1").flatMap((u) => u.data.content ?? [])
    expect(ok).toEqual([{ type: "terminal", command: "wc -l notes.txt", output: "       5 notes.txt", exitCode: 0 }])
    const bad = r.update("toolu_bash2").at(-1)
    expect(bad?.data.status).toBe("failed")
    expect(bad?.data.content?.[0]).toMatchObject({ type: "terminal", exitCode: 1 })
  })

  test("TodoWrite → plan.updated", () => {
    const plans = r.of("plan.updated").map((e) => e.data.entries.map((x) => x.status))
    expect(plans).toEqual([
      ["in_progress", "pending", "pending"],
      ["completed", "completed", "completed"],
    ])
    expect(r.of("plan.updated")[0]?.data.entries[0]?.content).toBe("read notes")
  })

  test("usage: cumulative from modelUsage incl. cache reads and cost", () => {
    const u = r.of("usage.updated").map((e) => e.data)
    expect(u[0]).toEqual({ input: 27120, cachedInput: 24000, output: 450, reasoning: 30, costUsd: 0.0123, source: "reported", mode: "cumulative" })
    expect(u[1]).toMatchObject({ input: 30130, cachedInput: 27000, output: 470, costUsd: 0.0131 })
  })

  test("interrupted turn marks its running tool failed", () => {
    const last = r.update("toolu_bash3").map((u) => u.data.status)
    expect(last).toEqual(["in_progress", "failed"])
  })
})

describe("fixture: auth-error.jsonl (real recording, not-logged-in CLI)", () => {
  const r = replay("auth-error.jsonl")

  test("API error surfaces as error event and the turn still completes", () => {
    expect(r.of("error")[0]?.data).toMatchObject({ message: "Not logged in · Please run /login", detail: "authentication_failed" })
    expect(r.of("turn.completed")[0]?.data.stopReason).toBe("error")
    expect(r.of("agent.session")).toHaveLength(1)
    expect(r.tr.status).toBe("ready")
    expect(r.tr.busy).toBe(false)
  })
})

describe("turn queueing", () => {
  const S = "sess"
  const result = (uuids: string[], queued?: number) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    user_message_uuids: uuids,
    ...(queued !== undefined ? { queued_turn_count: queued } : {}),
    session_id: S,
  })

  test("a prompt sent mid-turn runs as the next turn", () => {
    const tr = new ClaudeTranslator({ cwd: "/w" })
    const ev: AgentEvent[] = []
    ev.push(...tr.userPrompt("a", "first"))
    ev.push(...tr.userPrompt("b", "second"))
    ev.push(...tr.handle(result(["a"], 1)))
    expect(tr.busy).toBe(true)
    ev.push(...tr.handle(result(["b"], 0)))
    expect(ev.filter((e) => e.type === "turn.started").map((e) => (e.data as { prompt?: string }).prompt)).toEqual(["first", "second"])
    expect(ev.filter((e) => e.type === "turn.completed")).toHaveLength(2)
    expect(tr.busy).toBe(false)
  })

  test("a steer folded into the running turn does not start another", () => {
    const tr = new ClaudeTranslator({ cwd: "/w" })
    const ev: AgentEvent[] = []
    ev.push(...tr.userPrompt("a", "first"))
    ev.push(...tr.userPrompt("b", "also do X"))
    // the CLI reports the fold on an assistant frame
    ev.push(
      ...tr.handle({
        type: "assistant",
        message: { id: "m1", content: [{ type: "text", text: "ok" }] },
        parent_tool_use_id: null,
        user_message_uuids: ["a", "b"],
      }),
    )
    ev.push(...tr.handle(result(["a", "b"])))
    expect(ev.filter((e) => e.type === "turn.started")).toHaveLength(1)
    expect(tr.busy).toBe(false)
  })

  test("queued_turn_count: 0 settles even without uuid echoes (older CLIs)", () => {
    const tr = new ClaudeTranslator({ cwd: "/w" })
    tr.userPrompt("a", "first")
    tr.userPrompt("b", "folded")
    tr.handle(result([], 0))
    expect(tr.busy).toBe(false)
  })

  test("forceInterrupted closes a turn when no result arrives", () => {
    const tr = new ClaudeTranslator({ cwd: "/w" })
    tr.userPrompt("a", "x")
    tr.markInterrupting()
    const ev = tr.forceInterrupted()
    expect(ev.map((e) => e.type)).toEqual(["turn.interrupted", "agent.status"])
    expect(tr.forceInterrupted()).toEqual([])
  })
})
