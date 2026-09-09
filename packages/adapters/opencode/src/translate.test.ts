import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { AgentEvent } from "@batonsh/protocol"
import { parseEventData } from "@batonsh/protocol"
import { buildConfig, permissionFor, splitModel } from "./config.ts"
import { parseAuthList } from "./index.ts"
import { type OcEvent, OpencodeTranslator, replyFor, stopReasonFor } from "./translate.ts"

const CWD = "/tmp/baton-ws"

async function fixture(name: string): Promise<OcEvent[]> {
  const text = await Bun.file(join(import.meta.dir, "fixtures", `${name}.jsonl`)).text()
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as OcEvent)
}

function sessionOf(events: OcEvent[]): string {
  const created = events.find((e) => e.type === "session.created")
  const info = created?.properties?.info as { id: string } | undefined
  if (!info) throw new Error("fixture has no session.created")
  return info.id
}

function replay(events: OcEvent[], setup?: (t: OpencodeTranslator) => void): { t: OpencodeTranslator; out: AgentEvent[] } {
  const t = new OpencodeTranslator({ cwd: CWD })
  t.setSession(sessionOf(events))
  const out: AgentEvent[] = [...t.beginTurn("go", "turn_1")]
  setup?.(t)
  for (const e of events) out.push(...t.handle(e))
  return { t, out }
}

const of = <T extends AgentEvent["type"]>(out: AgentEvent[], type: T) => out.filter((e) => e.type === type) as Extract<AgentEvent, { type: T }>[]

/** Every emitted event must validate against the BEP schema. */
function validate(out: AgentEvent[]): void {
  for (const e of out) parseEventData(e.type, e.data)
}

describe("translator: recorded edit/bash/todo session (deepinfra DeepSeek-V4-Flash)", async () => {
  const events = await fixture("edit-bash-todo")
  const { out } = replay(events)

  test("all events are valid BEP", () => validate(out))

  test("turn lifecycle", () => {
    expect(out[0]?.type).toBe("turn.started")
    const done = of(out, "turn.completed")
    expect(done).toHaveLength(1)
    expect(done[0]?.data).toEqual({ turnId: "turn_1", stopReason: "end_turn" })
    expect(out.at(-1)).toEqual({ type: "agent.status", data: { status: "ready" } })
  })

  test("tool calls: kinds and Claude-Code-like titles", () => {
    const calls = of(out, "tool.call").map((e) => [e.data.name, e.data.kind, e.data.title])
    expect(calls).toEqual([
      ["todowrite", "other", "Update Todos"],
      ["read", "read", "Read(notes.txt)"],
      ["edit", "edit", "Update(notes.txt)"],
      ["todowrite", "other", "Update Todos"],
      ["bash", "execute", "Bash(cat notes.txt)"],
      ["todowrite", "other", "Update Todos"],
    ])
    const read = of(out, "tool.call").find((e) => e.data.name === "read")
    expect(read?.data.locations).toEqual([{ path: "/tmp/baton-ws/notes.txt" }])
    // pending parts with empty input are not announced until the input is known
    expect(of(out, "tool.call").every((e) => e.data.rawInput && Object.keys(e.data.rawInput as object).length > 0)).toBe(true)
  })

  test("every tool reaches completed exactly once", () => {
    const completed = of(out, "tool.update").filter((e) => e.data.status === "completed")
    expect(completed.map((e) => e.data.toolCallId).sort()).toEqual(of(out, "tool.call").map((e) => e.data.toolCallId).sort())
  })

  test("edit → diff content from metadata", () => {
    const edit = of(out, "tool.call").find((e) => e.data.kind === "edit")
    const upd = of(out, "tool.update").find((e) => e.data.toolCallId === edit?.data.toolCallId && e.data.status === "completed")
    expect(upd?.data.summary).toBe("+1 −1")
    const diff = upd?.data.content?.[0]
    expect(diff?.type).toBe("diff")
    if (diff?.type !== "diff") throw new Error("no diff")
    expect(diff.path).toBe("/tmp/baton-ws/notes.txt")
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    expect(diff.lines).toEqual([
      { kind: "del", text: "teh quick brown fox", oldLine: 1 },
      { kind: "add", text: "the quick brown fox", newLine: 1 },
    ])
  })

  test("read → line summary without dumping content", () => {
    const read = of(out, "tool.call").find((e) => e.data.name === "read")
    const upd = of(out, "tool.update").find((e) => e.data.toolCallId === read?.data.toolCallId && e.data.status === "completed")
    expect(upd?.data.summary).toBe("Read 1 line")
    expect(upd?.data.content).toBeUndefined()
  })

  test("bash → streamed terminal content + exit code", () => {
    const bash = of(out, "tool.call").find((e) => e.data.kind === "execute")
    const ups = of(out, "tool.update").filter((e) => e.data.toolCallId === bash?.data.toolCallId)
    const last = ups.at(-1)
    expect(last?.data.status).toBe("completed")
    expect(last?.data.content).toEqual([
      { type: "terminal", terminalId: bash?.data.toolCallId, command: "cat notes.txt", output: "the quick brown fox\n", exitCode: 0 },
    ])
    // the live (running) output was streamed before completion
    expect(ups.some((e) => e.data.status === undefined && e.data.content?.[0]?.type === "terminal")).toBe(true)
  })

  test("todowrite / todo.updated → deduplicated plan.updated", () => {
    const plans = of(out, "plan.updated")
    expect(plans).toHaveLength(3)
    expect(plans[0]?.data.entries).toEqual([
      { content: "Read notes.txt and fix typo", status: "in_progress", priority: "high" },
      { content: "Run cat notes.txt to verify", status: "pending", priority: "high" },
    ])
    expect(plans.at(-1)?.data.entries.every((e) => e.status === "completed")).toBe(true)
  })

  test("permissions → permission.requested with ACP option kinds; awaiting_approval status", () => {
    const reqs = of(out, "permission.requested")
    expect(reqs.map((r) => [r.data.kind, r.data.title])).toEqual([
      ["edit", "Update(notes.txt)"],
      ["execute", "Bash(cat notes.txt)"],
    ])
    expect(reqs[0]?.data.options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"])
    expect(reqs[1]?.data.options[1]?.name).toBe("Always allow cat *")
    expect(reqs[0]?.data.toolCallId).toBe(of(out, "tool.call").find((e) => e.data.kind === "edit")?.data.toolCallId)
    expect(reqs[0]?.data.detail).toContain("+the quick brown fox")
    // replied by someone other than baton → policy
    expect(of(out, "permission.resolved").map((e) => [e.data.by, e.data.kind])).toEqual([
      ["policy", "allow_once"],
      ["policy", "allow_once"],
    ])
    const statuses = of(out, "agent.status").map((e) => e.data.status)
    expect(statuses).toContain("awaiting_approval")
    expect(statuses.lastIndexOf("busy")).toBeGreaterThan(statuses.lastIndexOf("awaiting_approval"))
  })

  test("permission answered through baton → by user", () => {
    const { out } = replay(events, (t) => {
      t.noteReply("per_129c74e800011XtmFder17hKk0", "once")
    })
    expect(of(out, "permission.resolved")[0]?.data).toEqual({ requestId: "per_129c74e800011XtmFder17hKk0", optionId: "once", kind: "allow_once", by: "user" })
  })

  test("assistant text streamed (delta field) and completed; user prompt not echoed", () => {
    const deltas = of(out, "message.delta")
    expect(deltas.map((d) => d.data.text).join("")).toBe("DONE")
    expect(deltas.every((d) => d.data.role === "assistant")).toBe(true)
    expect(of(out, "message.completed").map((e) => e.data.text)).toEqual(["DONE"])
  })

  test("usage: one delta per step-finish with reported cost", () => {
    const usage = of(out, "usage.updated")
    expect(usage).toHaveLength(7)
    expect(usage.every((u) => u.data.mode === "delta" && u.data.source === "reported")).toBe(true)
    const cost = usage.reduce((s, u) => s + (u.data.costUsd ?? 0), 0)
    expect(cost).toBeCloseTo(0.00093384 + 0.00021222 + 0.00023607 + 0.000224298 + 0.00098631 + 0.000226476 + 0.000206784, 9)
    expect(usage[1]?.data).toMatchObject({ input: 116, cachedInput: 10240, output: 97 })
  })

  test("replaying the stream twice does not double count (dedupe by part id)", () => {
    const t = new OpencodeTranslator({ cwd: CWD })
    t.setSession(sessionOf(events))
    t.beginTurn("go")
    const first = events.flatMap((e) => t.handle(e))
    const second = events.flatMap((e) => t.handle(e))
    expect(of(first, "usage.updated")).toHaveLength(7)
    expect(of(second, "usage.updated")).toHaveLength(0)
    expect(of(second, "tool.call")).toHaveLength(0)
  })

  test("includeRaw attaches the native event", () => {
    const t = new OpencodeTranslator({ cwd: CWD, includeRaw: true })
    t.setSession(sessionOf(events))
    t.beginTurn("go")
    const out = events.flatMap((e) => t.handle(e))
    const call = of(out, "tool.call")[0]
    expect((call?.raw as OcEvent | undefined)?.type).toBe("message.part.updated")
  })
})

describe("translator: provider error (recorded auth failure)", async () => {
  const events = await fixture("auth-error")

  test("session.error → error event and stopReason error", () => {
    const { out } = replay(events)
    validate(out)
    expect(of(out, "error")[0]?.data).toEqual({ message: "Authentication Failed", detail: "APIError", fatal: false })
    expect(of(out, "turn.completed")[0]?.data.stopReason).toBe("error")
  })

  test("duplicate session.idle does not end the next (not yet acknowledged) turn", () => {
    const t = new OpencodeTranslator({ cwd: CWD })
    t.setSession(sessionOf(events))
    const out: AgentEvent[] = [...t.beginTurn("first", "turn_1")]
    let startedSecond = false
    for (const e of events) {
      const evs = t.handle(e)
      out.push(...evs)
      // start the queued turn right after the first turn completes (as the session does)
      if (!startedSecond && evs.some((x) => x.type === "turn.completed")) {
        startedSecond = true
        out.push(...t.beginTurn("second", "turn_2"))
      }
    }
    const done = of(out, "turn.completed").map((e) => e.data.turnId)
    // turn_2 is only completed by the idle that follows its own busy/user message
    expect(done).toEqual(["turn_1", "turn_2"])
    const idx2 = out.findIndex((e) => e.type === "turn.started" && e.data.turnId === "turn_2")
    const between = out.slice(idx2).filter((e) => e.type === "error")
    expect(between).toHaveLength(1)
  })
})

describe("translator: retry + abort (recorded)", async () => {
  const events = await fixture("retry-queue-abort")

  test("retry status surfaces as busy with detail", () => {
    const { out } = replay(events)
    validate(out)
    const details = of(out, "agent.status").map((e) => e.data.detail).filter(Boolean)
    expect(details[0]).toBe("retrying (attempt 1): Model busy, retry later")
  })

  test("idle after interrupt → turn.interrupted", () => {
    const { out } = replay(events, (t) => t.markInterrupting())
    expect(of(out, "turn.interrupted")).toEqual([{ type: "turn.interrupted", data: { turnId: "turn_1" } }])
    expect(of(out, "turn.completed")).toHaveLength(0)
  })

  test("queued user message mid-turn is not echoed as assistant text", () => {
    const { out } = replay(events)
    expect(of(out, "message.delta")).toHaveLength(0)
  })
})

describe("translator: synthetic edge cases", () => {
  const SID = "ses_main"
  const mk = () => {
    const t = new OpencodeTranslator({ cwd: CWD })
    t.setSession(SID)
    t.beginTurn("go", "turn_x")
    return t
  }
  const partEv = (part: Record<string, unknown>, extra: Record<string, unknown> = {}): OcEvent => ({
    type: "message.part.updated",
    properties: { sessionID: part.sessionID ?? SID, part: { sessionID: SID, messageID: "msg_a", ...part }, ...extra },
  })
  const assistant: OcEvent = { type: "message.updated", properties: { sessionID: SID, info: { id: "msg_a", role: "assistant", sessionID: SID } } }

  test("reasoning via full-text updates only (no delta events) → thought deltas", () => {
    const t = mk()
    const out = [
      assistant,
      partEv({ id: "prt_r", type: "reasoning", text: "", time: { start: 1 } }),
      partEv({ id: "prt_r", type: "reasoning", text: "Let me", time: { start: 1 } }),
      partEv({ id: "prt_r", type: "reasoning", text: "Let me think", time: { start: 1 } }),
      partEv({ id: "prt_r", type: "reasoning", text: "Let me think.", time: { start: 1, end: 2 } }),
      partEv({ id: "prt_t", type: "text", text: "Hi" }, { delta: "Hi" }),
      { type: "message.part.delta", properties: { sessionID: SID, messageID: "msg_a", partID: "prt_t", field: "text", delta: " there" } },
      partEv({ id: "prt_t", type: "text", text: "Hi there", time: { start: 1, end: 3 } }),
    ].flatMap((e) => t.handle(e))
    validate(out)
    const thought = of(out, "message.delta").filter((e) => e.data.role === "thought")
    expect(thought.map((e) => e.data.text)).toEqual(["Let me", " think", "."])
    expect(of(out, "message.completed").map((e) => [e.data.role, e.data.text])).toEqual([
      ["thought", "Let me think."],
      ["assistant", "Hi there"],
    ])
    const text = of(out, "message.delta").filter((e) => e.data.role === "assistant")
    expect(text.map((e) => e.data.text).join("")).toBe("Hi there")
  })

  test("write of a new file → diff from empty; tool error → failed", () => {
    const t = mk()
    const out = [
      partEv({
        id: "prt_w",
        type: "tool",
        tool: "write",
        callID: "call_w",
        state: { status: "completed", input: { filePath: `${CWD}/a.txt`, content: "x\ny\n" }, output: "ok", title: "a.txt", metadata: { exists: false }, time: { start: 1, end: 2 } },
      }),
      partEv({
        id: "prt_b",
        type: "tool",
        tool: "bash",
        callID: "call_b",
        state: { status: "error", input: { command: "false" }, error: "exit 1", time: { start: 1, end: 2 } },
      }),
    ].flatMap((e) => t.handle(e))
    validate(out)
    expect(of(out, "tool.call").map((e) => e.data.title)).toEqual(["Write(a.txt)", "Bash(false)"])
    const w = of(out, "tool.update").find((e) => e.data.toolCallId === "call_w")
    expect(w?.data.content?.[0]).toMatchObject({ type: "diff", path: `${CWD}/a.txt`, added: 2, removed: 0, oldText: null, newText: "x\ny\n" })
    const b = of(out, "tool.update").find((e) => e.data.toolCallId === "call_b")
    expect(b?.data).toMatchObject({ status: "failed", summary: "exit 1" })
  })

  test("apply_patch with metadata.files before/after", () => {
    const t = mk()
    const patchText = "*** Begin Patch\n*** Update File: src/x.ts\n@@\n-a\n+b\n*** End Patch"
    const out = t.handle(
      partEv({
        id: "prt_p",
        type: "tool",
        tool: "apply_patch",
        callID: "call_p",
        state: {
          status: "completed",
          input: { patchText },
          output: "Success",
          title: "patch",
          metadata: { files: [{ filePath: `${CWD}/src/x.ts`, before: "a\n", after: "b\n" }] },
          time: { start: 1, end: 2 },
        },
      }),
    )
    validate(out)
    expect(of(out, "tool.call")[0]?.data).toMatchObject({ kind: "edit", title: "Update(src/x.ts)", locations: [{ path: `${CWD}/src/x.ts` }] })
    expect(of(out, "tool.update")[0]?.data.content?.[0]).toMatchObject({ type: "diff", added: 1, removed: 1 })
  })

  test("subagent (task) tool calls nest under the task call", () => {
    const t = mk()
    const out = [
      partEv({
        id: "prt_task",
        type: "tool",
        tool: "task",
        callID: "call_task",
        state: { status: "running", input: { description: "explore repo", prompt: "…", subagent_type: "explore" }, metadata: { sessionId: "ses_child" }, time: { start: 1 } },
      }),
      { type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: SID } } },
      {
        type: "message.part.updated",
        properties: {
          sessionID: "ses_child",
          part: { id: "prt_c", sessionID: "ses_child", messageID: "msg_c", type: "tool", tool: "grep", callID: "call_c", state: { status: "running", input: { pattern: "TODO" }, time: { start: 1 } } },
        },
      },
      {
        type: "message.part.updated",
        properties: { sessionID: "ses_child", part: { id: "prt_ct", sessionID: "ses_child", messageID: "msg_c", type: "text", text: "child chatter", time: { start: 1, end: 2 } } },
      },
      { type: "permission.asked", properties: { id: "per_c", sessionID: "ses_child", permission: "bash", patterns: ["ls"], metadata: { command: "ls" }, always: ["ls *"] } },
      { type: "message.part.updated", properties: { sessionID: "ses_other", part: { id: "prt_o", sessionID: "ses_other", messageID: "m", type: "tool", tool: "bash", callID: "call_o", state: { status: "running", input: { command: "x" }, time: { start: 1 } } } } },
    ].flatMap((e) => t.handle(e))
    validate(out)
    const calls = of(out, "tool.call")
    expect(calls.map((c) => [c.data.toolCallId, c.data.kind, c.data.parentToolCallId])).toEqual([
      ["call_task", "delegate", undefined],
      ["call_c", "search", "call_task"],
    ])
    expect(calls[0]?.data.title).toBe("Task(explore repo)")
    expect(of(out, "message.delta")).toHaveLength(0)
    expect(of(out, "permission.requested")[0]?.data.title).toBe("Bash(ls)")
  })

  test("pending permissions are cancelled when the turn ends", () => {
    const t = mk()
    const out = [
      { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } },
      { type: "permission.asked", properties: { id: "per_1", sessionID: SID, permission: "edit", patterns: ["a.txt"], metadata: {}, always: ["*"] } },
      { type: "session.idle", properties: { sessionID: SID } },
    ].flatMap((e) => t.handle(e))
    validate(out)
    expect(of(out, "permission.resolved")[0]?.data).toEqual({ requestId: "per_1", optionId: null, kind: null, by: "cancelled" })
    expect(of(out, "turn.completed")).toHaveLength(1)
  })

  test("busy without a local turn (e.g. prompt from another client) opens an implicit turn", () => {
    const t = new OpencodeTranslator()
    t.setSession(SID)
    const out = [
      { type: "session.status", properties: { sessionID: SID, status: { type: "busy" } } },
      { type: "session.idle", properties: { sessionID: SID } },
    ].flatMap((e) => t.handle(e))
    expect(out.map((e) => e.type)).toEqual(["turn.started", "agent.status", "turn.completed", "agent.status"])
  })

  test("aborted assistant message → turn.interrupted even without local interrupt", () => {
    const t = mk()
    const out = [
      assistant,
      { type: "message.updated", properties: { sessionID: SID, info: { id: "msg_a", role: "assistant", error: { name: "MessageAbortedError", data: { message: "aborted" } } } } },
      { type: "session.error", properties: { sessionID: SID, error: { name: "MessageAbortedError", data: { message: "aborted" } } } },
      { type: "session.idle", properties: { sessionID: SID } },
    ].flatMap((e) => t.handle(e))
    expect(of(out, "turn.interrupted")).toHaveLength(1)
    expect(of(out, "error")).toHaveLength(0)
  })
})

describe("mapping helpers", () => {
  test("permission replies", () => {
    expect(replyFor("once")).toBe("once")
    expect(replyFor("allow_once")).toBe("once")
    expect(replyFor("always")).toBe("always")
    expect(replyFor("allow_always")).toBe("always")
    expect(replyFor("reject")).toBe("reject")
    expect(replyFor("reject_always")).toBe("reject")
    expect(replyFor(null)).toBe("reject")
  })

  test("stop reasons", () => {
    expect(stopReasonFor("stop")).toBe("end_turn")
    expect(stopReasonFor(undefined)).toBe("end_turn")
    expect(stopReasonFor("length")).toBe("max_tokens")
    expect(stopReasonFor("tool-calls")).toBe("max_turn_requests")
    expect(stopReasonFor("content-filter")).toBe("refusal")
  })

  test("approval → permission config", () => {
    expect(permissionFor("ask")).toMatchObject({ edit: "ask", bash: "ask", webfetch: "ask" })
    expect(permissionFor("auto-edit")).toMatchObject({ edit: "allow", bash: "ask", webfetch: "ask" })
    expect(permissionFor("auto")).toMatchObject({ edit: "allow", bash: "allow", webfetch: "ask" })
    expect(permissionFor("yolo")).toMatchObject({ edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" })
  })

  test("models", () => {
    expect(splitModel("deepinfra/deepseek-ai/DeepSeek-V4-Flash")).toEqual({ providerID: "deepinfra", modelID: "deepseek-ai/DeepSeek-V4-Flash" })
    expect(splitModel("gpt-x", "myprov")).toEqual({ providerID: "myprov", modelID: "gpt-x" })
    expect(splitModel("gpt-x")).toBeUndefined()
  })

  test("config: mcp servers, openai-compatible provider, model", () => {
    const c = buildConfig({
      agentId: "a",
      name: "n",
      cwd: "/tmp",
      approval: "auto",
      model: "llama3",
      provider: { id: "local", kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", apiKey: "k" },
      mcpServers: [{ name: "baton", url: "http://127.0.0.1:7777/mcp", headers: { authorization: "Bearer t" } }],
    })
    expect(c.mcp?.baton).toEqual({ type: "remote", url: "http://127.0.0.1:7777/mcp", enabled: true, headers: { authorization: "Bearer t" }, oauth: false })
    expect(c.provider?.local).toEqual({
      npm: "@ai-sdk/openai-compatible",
      name: "local",
      options: { baseURL: "http://127.0.0.1:1234/v1", apiKey: "k" },
      models: { llama3: { name: "llama3" } },
    })
    expect(c.model).toBe("local/llama3")
    expect(c.permission).toMatchObject({ edit: "allow", bash: "allow" })
  })

  test("auth list parsing", () => {
    const sample = "\u001b[0m\n┌  Credentials \u001b[90m~/.local/share/opencode/auth.json\n│\n●  Deep Infra \u001b[90mapi\n│\n●  Z.AI \u001b[90mapi\n│\n└  2 credentials\n"
    expect(parseAuthList(sample)).toBe(2)
    expect(parseAuthList("┌  Credentials\n│\n└  0 credentials\n")).toBe(0)
    expect(parseAuthList("garbage")).toBeUndefined()
  })
})
