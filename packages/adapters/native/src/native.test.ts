import "./testing/env.ts"
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentEvent, SessionConfig } from "@batonsh/protocol"
import type { ModelMessage } from "ai"
import { contractSuite, type Harness, startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import { isDestructiveCommand, nativeAdapter, needsApproval, priceFor, resolveModel, trimTranscript } from "./index.ts"
import { contentText, type FakeLLM, type FakeScript, fakeLLM, lastMessage } from "./testing/fake-llm.ts"
import { fakeMcp } from "./testing/fake-mcp.ts"

const servers: { stop(): void }[] = []
afterAll(() => {
  for (const s of servers) s.stop()
})

function llm(script: FakeScript): FakeLLM {
  const s = fakeLLM(script)
  servers.push(s)
  return s
}

async function start(fake: FakeLLM, cfg: Partial<SessionConfig> & { cwd: string }): Promise<Harness> {
  return startHarness(nativeAdapter, {
    model: "gpt-4o-mini",
    provider: { id: "fake", kind: "openai-compatible", baseUrl: fake.baseUrl, apiKey: "test-key" },
    ...cfg,
  })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(cond: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await Bun.sleep(20)
  }
  return cond()
}

const assistantText = (h: Harness) =>
  h
    .ofType("message.completed")
    .filter((e) => e.data.role === "assistant")
    .map((e) => e.data.text)
    .join("\n")

/** Tool messages (role "tool") the model received in a request, as text. */
const toolResults = (fake: FakeLLM, i: number) =>
  (fake.requests[i]?.body.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => contentText(m.content))
    .join("\n")

describe("contract", () => {
  contractSuite(nativeAdapter, { test, expect })

  test("fake provider: answers a prompt (turn lifecycle + assistant text)", async () => {
    const fake = llm([{ text: "PONG" }])
    const h = await start(fake, { cwd: tempWorkspace({ "README.md": "# hello\n" }) })
    try {
      await h.session.prompt({ text: "Reply with exactly the word PONG and nothing else. Do not use tools." })
      await h.waitTurn(10_000)
      expect(h.ofType("turn.started")).toHaveLength(1)
      expect(assistantText(h)).toBe("PONG")
      expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("end_turn")
      expect(h.ofType("agent.session")[0]?.data.sessionId).toBe(h.session.resumeId() as string)
      // system prompt + tools were sent
      const req = fake.requests[0]
      expect(req?.body.messages[0]?.role).toBe("system")
      expect(req?.body.tools?.map((t) => t.function.name)).toEqual(
        expect.arrayContaining(["read_file", "list_dir", "glob", "grep", "write_file", "edit_file", "run_command"]),
      )
      expect(req?.headers.get("authorization")).toBe("Bearer test-key")
    } finally {
      await h.close()
    }
  })

  test("fake provider: edits a file (tool.call edit + diff content)", async () => {
    const fake = llm([{ toolCalls: [{ name: "edit_file", args: { path: "notes.txt", old_string: "teh", new_string: "the" } }] }, { text: "Fixed the typo." }])
    const cwd = tempWorkspace({ "notes.txt": "teh quick brown fox\n" })
    const h = await start(fake, { cwd, approval: "auto-edit" })
    try {
      await h.session.prompt({ text: "Fix the typo in notes.txt (teh -> the)." })
      await h.waitTurn(10_000)
      expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toContain("the quick brown fox")
      expect(h.ofType("tool.call").filter((e) => e.data.kind === "edit").length).toBeGreaterThan(0)
      const diffs = h
        .ofType("tool.update")
        .flatMap((e) => e.data.content ?? [])
        .filter((c) => c.type === "diff")
      expect(diffs.length).toBeGreaterThan(0)
      expect(h.ofType("permission.requested")).toHaveLength(0) // auto-edit: edits don't ask
    } finally {
      await h.close()
    }
  })
})

describe("agent loop", () => {
  test("read → edit (diff) → run command → answer, with reasoning, usage and cost", async () => {
    const fake = llm([
      {
        reasoning: "Let me look at the file first. ",
        toolCalls: [{ name: "read_file", args: { path: "notes.txt" } }],
        usage: { prompt: 1000, completion: 50 },
      },
      { toolCalls: [{ name: "edit_file", args: { path: "notes.txt", old_string: "teh quick", new_string: "the quick" } }] },
      { toolCalls: [{ name: "run_command", args: { command: "cat notes.txt && echo ok" } }] },
      { text: "Fixed the typo and verified it." },
    ])
    const cwd = tempWorkspace({ "notes.txt": "line one\nteh quick brown fox\nline three\n" })
    const h = await start(fake, { cwd, approval: "yolo" })
    try {
      await h.session.prompt({ text: "fix the typo" })
      await h.waitTurn(15_000)
      expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("line one\nthe quick brown fox\nline three\n")

      const calls = h.ofType("tool.call").map((e) => e.data)
      expect(calls.map((c) => c.kind)).toEqual(["read", "edit", "execute"])
      expect(calls.map((c) => c.title)).toEqual(["Read(notes.txt)", "Update(notes.txt)", "Bash(cat notes.txt && echo ok)"])

      const updates = h.ofType("tool.update").map((e) => e.data)
      const diff = updates.flatMap((u) => u.content ?? []).find((c) => c.type === "diff")
      expect(diff).toMatchObject({ type: "diff", path: "notes.txt", added: 1, removed: 1 })
      const term = updates.flatMap((u) => u.content ?? []).find((c) => c.type === "terminal" && c.exitCode === 0)
      expect(term && term.type === "terminal" ? term.output : "").toContain("the quick brown fox\nline three\nok")
      expect(updates.filter((u) => u.status === "completed")).toHaveLength(3)

      // the model saw the numbered file and the command output
      expect(toolResults(fake, 1)).toContain("2\tteh quick brown fox")
      expect(toolResults(fake, 3)).toContain("[exit code 0]")

      const thoughts = h.ofType("message.completed").filter((e) => e.data.role === "thought")
      expect(thoughts[0]?.data.text).toBe("Let me look at the file first. ")
      expect(assistantText(h)).toBe("Fixed the typo and verified it.")

      const usage = h.ofType("usage.updated").at(-1)?.data
      expect(usage?.input).toBe(1300)
      expect(usage?.output).toBe(110)
      expect(usage?.costUsd ?? 0).toBeGreaterThan(0)
      expect(h.ofType("turn.completed").at(-1)?.data.stopReason).toBe("end_turn")
      expect(h.ofType("agent.status").at(-1)?.data.status).toBe("ready")
    } finally {
      await h.close()
    }
  })

  test("approval ask: edits ask; deny leaves the file alone and tells the model", async () => {
    const fake = llm([{ toolCalls: [{ name: "edit_file", args: { path: "a.txt", old_string: "x", new_string: "y" } }] }, { text: "Okay, I won't change it." }])
    const cwd = tempWorkspace({ "a.txt": "x\n" })
    const h = await start(fake, { cwd, approval: "ask" })
    h.autoApprove = "reject_once"
    try {
      await h.session.prompt({ text: "change x to y" })
      await h.waitTurn(10_000)
      const req = h.ofType("permission.requested")
      expect(req).toHaveLength(1)
      expect(req[0]?.data).toMatchObject({ title: "Update(a.txt)", kind: "edit" })
      expect(req[0]?.data.options.map((o) => o.optionId)).toEqual(["allow_once", "allow_always", "reject_once", "reject_always"])
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("x\n")
      expect(h.ofType("tool.update").at(-1)?.data).toMatchObject({ status: "failed", summary: "Denied" })
      expect(toolResults(fake, 1)).toContain("denied")
      expect(h.ofType("agent.status").map((e) => e.data.status)).toContain("awaiting_approval")
    } finally {
      await h.close()
    }
  })

  test("allow_always is remembered per tool+command; setApproval switches live", async () => {
    const fake = llm([
      { toolCalls: [{ name: "run_command", args: { command: "echo one" } }] },
      { toolCalls: [{ name: "run_command", args: { command: "echo one" } }] },
      { toolCalls: [{ name: "run_command", args: { command: "echo two" } }] },
      { text: "done" },
      { toolCalls: [{ name: "run_command", args: { command: "echo three" } }] },
      { text: "done again" },
    ])
    const h = await start(fake, { cwd: tempWorkspace(), approval: "auto-edit" })
    h.autoApprove = "off"
    try {
      await h.session.prompt({ text: "go" })
      const first = await h.waitFor("permission.requested", undefined, 5000)
      await h.session.respondPermission(first.data.requestId, "allow_always")
      const second = await h.waitFor("permission.requested", (e) => e.data.title === "Bash(echo two)", 5000)
      expect(h.ofType("permission.requested")).toHaveLength(2) // "echo one" twice → asked once
      await h.session.respondPermission(second.data.requestId, "allow_once")
      await h.waitTurn(10_000)
      expect(h.ofType("tool.update").filter((u) => u.data.status === "completed")).toHaveLength(3)

      await h.session.setApproval?.("yolo")
      await h.session.prompt({ text: "again" })
      await h.waitTurn(10_000)
      expect(h.ofType("permission.requested")).toHaveLength(2)
      expect(toolResults(fake, 5)).toContain("three")
    } finally {
      await h.close()
    }
  })

  // skipped on Windows: POSIX process groups
  test.skipIf(process.platform === "win32")("interrupt during a long command kills its process group and ends the turn", async () => {
    const fake = llm([{ toolCalls: [{ name: "run_command", args: { command: "sleep 30 & echo $! > child.pid; wait" } }] }, { text: "after" }])
    const cwd = tempWorkspace()
    const h = await start(fake, { cwd, approval: "yolo" })
    try {
      await h.session.prompt({ text: "run the long thing" })
      await h.waitFor("tool.update", (e) => e.data.status === "in_progress", 5000)
      expect(await until(() => existsSync(join(cwd, "child.pid")) && readFileSync(join(cwd, "child.pid"), "utf8").trim() !== "")).toBe(true)
      const pid = Number(readFileSync(join(cwd, "child.pid"), "utf8").trim())
      expect(alive(pid)).toBe(true)
      const t0 = Date.now()
      await h.session.interrupt()
      await h.waitFor("turn.interrupted", undefined, 5000)
      expect(Date.now() - t0).toBeLessThan(4000)
      expect(h.ofType("turn.completed")).toHaveLength(0)
      expect(await until(() => !alive(pid), 3000)).toBe(true)
      expect(h.ofType("tool.update").at(-1)?.data).toMatchObject({ status: "failed", summary: "Interrupted" })

      // the session keeps working and the transcript stays valid (tool result recorded)
      await h.session.prompt({ text: "next" })
      await h.waitFor("turn.completed", undefined, 5000)
      expect(toolResults(fake, 1)).toContain("interrupted")
      expect(lastMessage(fake.requests[1] as never, "user")).toBe("next")
    } finally {
      await h.close()
    }
  })

  test("steer is injected as a user message before the next model step", async () => {
    const fake = llm((r) => {
      if (r.index === 0) return { toolCalls: [{ name: "run_command", args: { command: "sleep 0.5" } }] }
      return { text: lastMessage(r, "user").includes("use tabs") ? "Switching to tabs." : "No steer seen." }
    })
    const h = await start(fake, { cwd: tempWorkspace(), approval: "yolo" })
    try {
      await h.session.prompt({ text: "format the code" })
      await h.waitFor("tool.update", (e) => e.data.status === "in_progress", 5000)
      await h.session.steer?.({ text: "actually, use tabs", from: "orchestrator" })
      await h.waitTurn(10_000)
      expect(h.ofType("turn.started")).toHaveLength(1)
      expect(assistantText(h)).toBe("Switching to tabs.")
      const msgs = fake.requests[1]?.body.messages ?? []
      expect(msgs.at(-1)?.role).toBe("user")
      expect(msgs.at(-2)?.role).toBe("tool")
      expect(contentText(msgs.at(-1)?.content)).toBe("[message from orchestrator]\nactually, use tabs")
    } finally {
      await h.close()
    }
  })

  test("prompt while busy is queued and runs as its own turn", async () => {
    const fake = llm([{ text: "first", chunkDelayMs: 30 }, { text: "second" }])
    const h = await start(fake, { cwd: tempWorkspace(), approval: "yolo" })
    try {
      await h.session.prompt({ text: "one" })
      await h.session.prompt({ text: "two" })
      await until(() => h.ofType("turn.completed").length === 2, 10_000)
      expect(h.ofType("turn.started").map((e) => e.data.prompt)).toEqual(["one", "two"])
      expect(assistantText(h)).toBe("first\nsecond")
      // the second request carries the whole conversation
      expect(fake.requests[1]?.body.messages.filter((m) => m.role === "user")).toHaveLength(2)
    } finally {
      await h.close()
    }
  })

  test("paths outside the workspace are refused (.., absolute, symlink)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "baton-outside-"))
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n")
    const cwd = tempWorkspace({ "ok.txt": "fine\n" })
    symlinkSync(outside, join(cwd, "link"))
    symlinkSync(join(outside, "new.txt"), join(cwd, "dangling"))
    const fake = llm([
      {
        toolCalls: [
          { name: "read_file", args: { path: "../secret.txt" } },
          { name: "read_file", args: { path: join(outside, "secret.txt") } },
          { name: "read_file", args: { path: "link/secret.txt" } },
          { name: "write_file", args: { path: "dangling", content: "pwned" } },
          { name: "list_dir", args: { path: ".." } },
          { name: "read_file", args: { path: "ok.txt" } },
        ],
      },
      { text: "ok" },
    ])
    const h = await start(fake, { cwd, approval: "yolo" })
    try {
      await h.session.prompt({ text: "read stuff" })
      await h.waitTurn(10_000)
      const updates = h.ofType("tool.update").filter((u) => u.data.status === "failed" || u.data.status === "completed")
      expect(updates.map((u) => u.data.status)).toEqual(["failed", "failed", "failed", "failed", "failed", "completed"])
      expect(updates.slice(0, 5).every((u) => u.data.summary?.startsWith("Refused"))).toBe(true)
      const results = toolResults(fake, 1)
      expect(results).not.toContain("TOP SECRET")
      expect(results).toContain("outside the workspace")
      expect(results).toContain("1\tfine")
      expect(existsSync(join(outside, "new.txt"))).toBe(false)
    } finally {
      await h.close()
    }
  })

  test("search tools: grep, glob, list_dir, read_file ranges, edit uniqueness", async () => {
    const cwd = tempWorkspace({ "a.ts": "const fox = 1\nconst dog = 2\n", "b.md": "the Fox jumps\n", "dup.txt": "x\nx\n" })
    const fake = llm([
      {
        toolCalls: [
          { name: "grep", args: { pattern: "fox", ignore_case: true } },
          { name: "grep", args: { pattern: "fox", glob: "*.ts" } },
          { name: "glob", args: { pattern: "**/*.md" } },
          { name: "list_dir", args: {} },
          { name: "read_file", args: { path: "a.ts", offset: 2, limit: 1 } },
          { name: "edit_file", args: { path: "dup.txt", old_string: "x", new_string: "y" } },
          { name: "edit_file", args: { path: "dup.txt", old_string: "x", new_string: "y", replace_all: true } },
        ],
      },
      { text: "ok" },
    ])
    const h = await start(fake, { cwd, approval: "yolo" })
    try {
      await h.session.prompt({ text: "search" })
      await h.waitTurn(10_000)
      const msgs = (fake.requests[1]?.body.messages ?? []).filter((m) => m.role === "tool").map((m) => contentText(m.content))
      expect(msgs[0]).toContain("a.ts:1:const fox = 1")
      expect(msgs[0]).toContain("b.md:1:the Fox jumps")
      expect(msgs[1]).toContain("a.ts:1:")
      expect(msgs[1]).not.toContain("b.md")
      expect(msgs[2]).toBe("b.md")
      expect(msgs[3]).toContain("a.ts")
      expect(msgs[3]).toContain(".git/")
      expect(msgs[4]).toContain("2\tconst dog = 2")
      expect(msgs[4]).not.toContain("const fox")
      expect(msgs[5]).toContain("occurs 2 times")
      expect(msgs[6]).toContain("2 replacements")
      expect(readFileSync(join(cwd, "dup.txt"), "utf8")).toBe("y\ny\n")
    } finally {
      await h.close()
    }
  })

  test("MCP tools from configured servers are exposed and callable", async () => {
    const mcp = fakeMcp({ token: "bus-token" })
    servers.push(mcp)
    const fake = llm([
      {
        toolCalls: [
          { name: "add", args: { a: 2, b: 3 } },
          { name: "send_message", args: { to: "reviewer", body: "please review" } },
        ],
      },
      { text: "2 + 3 = 5" },
    ])
    const h = await start(fake, {
      cwd: tempWorkspace(),
      approval: "ask",
      mcpServers: [{ name: "baton", url: mcp.url, headers: { Authorization: "Bearer bus-token" } }],
    })
    try {
      await h.session.prompt({ text: "add 2 and 3, then tell the reviewer" })
      await h.waitTurn(10_000)
      const names = fake.requests[0]?.body.tools?.map((t) => t.function.name) ?? []
      expect(names).toContain("add")
      expect(names).toContain("send_message")
      expect(mcp.calls.map((c) => c.tool)).toEqual(["add", "send_message"])
      expect(mcp.calls[0]?.auth).toBe("Bearer bus-token")
      const calls = h.ofType("tool.call").map((e) => e.data)
      expect(calls.map((c) => c.name)).toEqual(["mcp__baton__add", "mcp__baton__send_message"])
      expect(calls[1]?.kind).toBe("delegate")
      expect(h.ofType("permission.requested")).toHaveLength(0)
      const results = toolResults(fake, 1)
      expect(results).toContain("5")
      expect(results).toContain("sent to reviewer")
      // server instructions reach the system prompt
      expect(contentText(fake.requests[0]?.body.messages[0]?.content)).toContain("Fake coordination tools for tests.")
    } finally {
      await h.close()
    }
  })

  test("resume within the daemon lifetime continues the conversation", async () => {
    const fake = llm([{ text: "remembered" }, { text: "still here" }])
    const cwd = tempWorkspace()
    const h1 = await start(fake, { cwd, approval: "yolo" })
    await h1.session.prompt({ text: "my name is Ada" })
    await h1.waitTurn(10_000)
    const id = h1.session.resumeId() as string
    await h1.close()
    const h2 = await start(fake, { cwd, approval: "yolo", resumeId: id })
    try {
      expect(h2.session.resumeId()).toBe(id)
      await h2.session.prompt({ text: "what is my name?" })
      await h2.waitTurn(10_000)
      const texts = (fake.requests[1]?.body.messages ?? []).map((m) => contentText(m.content))
      expect(texts).toContain("my name is Ada")
      expect(texts).toContain("remembered")
    } finally {
      await h2.close()
    }
  })

  test("step limit ends the turn with stopReason max_steps", async () => {
    const fake = llm(() => ({ toolCalls: [{ name: "list_dir", args: {} }] }))
    const h = await start(fake, { cwd: tempWorkspace(), approval: "yolo", options: { maxSteps: 3 } })
    try {
      await h.session.prompt({ text: "loop forever" })
      await h.waitTurn(10_000)
      expect(fake.requests).toHaveLength(3)
      expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("max_steps")
    } finally {
      await h.close()
    }
  })

  test("provider errors end the turn with an error event", async () => {
    const fake = llm([{ error: { status: 400, message: "model not found: nope" } }])
    const h = await start(fake, { cwd: tempWorkspace(), approval: "yolo" })
    try {
      await h.session.prompt({ text: "hi" })
      await h.waitTurn(10_000)
      expect(h.ofType("error")[0]?.data.message).toContain("model not found")
      expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("error")
    } finally {
      await h.close()
    }
  })

  test("close: no events after agent.exited, exited exactly once", async () => {
    const fake = llm([{ text: "a b c d e f g h i j k l m n o p", chunkDelayMs: 50 }])
    const events: AgentEvent[] = []
    const ac = new AbortController()
    const s = await nativeAdapter.start(
      {
        agentId: "a",
        name: "w",
        cwd: tempWorkspace(),
        mcpServers: [],
        approval: "yolo",
        model: "m",
        provider: { id: "fake", kind: "openai-compatible", baseUrl: fake.baseUrl },
      },
      { emit: (e) => events.push(e), log: () => {}, signal: ac.signal },
    )
    await s.prompt({ text: "talk" })
    await s.prompt({ text: "queued" })
    await Bun.sleep(150)
    await s.close()
    ac.abort()
    await s.close()
    await expect(s.prompt({ text: "again" })).rejects.toThrow()
    const atClose = events.length
    await Bun.sleep(600)
    expect(events.length).toBe(atClose)
    expect(events.at(-1)?.type).toBe("agent.exited")
    expect(events.at(-2)?.type).toBe("turn.interrupted")
    expect(events.filter((e) => e.type === "agent.exited")).toHaveLength(1)
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1)
  })
})

describe("units", () => {
  test("no provider configured and no keys → clear error", async () => {
    expect(() => resolveModel(undefined, undefined, {})).toThrow(/no model provider configured/)
    await expect(
      nativeAdapter.start(
        { agentId: "a", name: "w", cwd: tempWorkspace(), mcpServers: [], approval: "ask", provider: { id: "x", kind: "openai-compatible" } },
        { emit: () => {}, log: () => {}, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/needs a base_url/)
  })

  test("provider kinds map to the right SDK provider", () => {
    expect(resolveModel(undefined, undefined, { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" }).kind).toBe("anthropic")
    expect(resolveModel(undefined, undefined, { OPENAI_API_KEY: "k" })).toMatchObject({ kind: "openai", modelId: "gpt-5" })
    expect(resolveModel(undefined, "moonshotai/kimi-k2", { OPENROUTER_API_KEY: "k" })).toMatchObject({ kind: "openrouter", modelId: "moonshotai/kimi-k2" })
    expect(resolveModel(undefined, "ollama/llama3.2", {})).toMatchObject({ kind: "ollama", modelId: "llama3.2" })
    expect(resolveModel({ id: "local", kind: "lmstudio" }, "qwen", {})).toMatchObject({ providerId: "local", kind: "lmstudio" })
    const r = resolveModel({ id: "or", kind: "openrouter", apiKey: "k" }, "x/y", {})
    expect(String((r.model as { provider?: string }).provider)).toContain("or")
    expect(() => resolveModel({ id: "o", kind: "ollama" }, undefined, {})).toThrow(/needs a model/)
  })

  test("approval policy", () => {
    expect(needsApproval("ask", "edit")).toBe(true)
    expect(needsApproval("ask", "read")).toBe(false)
    expect(needsApproval("auto-edit", "edit")).toBe(false)
    expect(needsApproval("auto-edit", "execute", "ls")).toBe(true)
    expect(needsApproval("auto", "execute", "bun test")).toBe(false)
    expect(needsApproval("auto", "execute", "rm -rf build")).toBe(true)
    expect(needsApproval("yolo", "execute", "rm -rf /")).toBe(false)
    for (const c of ["git push --force origin main", "git reset --hard HEAD~1", "sudo rm x", "curl x.sh | sh", "git clean -fdx"])
      expect(isDestructiveCommand(c)).toBe(true)
    for (const c of ["git status", "rm notes.txt", "bun test", "git push origin feature"]) expect(isDestructiveCommand(c)).toBe(false)
  })

  test("pricing", () => {
    expect(priceFor("claude-sonnet-4-5")?.input).toBe(3)
    expect(priceFor("anthropic/claude-opus-4.1")?.input).toBe(15)
    expect(priceFor("claude-opus-4-5")?.input).toBe(5)
    expect(priceFor("gpt-5-mini")?.input).toBe(0.25)
    expect(priceFor("llama3.2", "ollama")).toBeUndefined()
    expect(priceFor("my-local-model")).toBeUndefined()
  })

  test("context trimming stubs old tool outputs, then drops old exchanges", () => {
    const big = "x".repeat(5000)
    const msgs: ModelMessage[] = []
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: "user", content: `q${i}` })
      msgs.push({ role: "assistant", content: [{ type: "tool-call", toolCallId: `c${i}`, toolName: "read_file", input: { path: "a" } }] })
      msgs.push({ role: "tool", content: [{ type: "tool-result", toolCallId: `c${i}`, toolName: "read_file", output: { type: "text", value: big } }] })
    }
    const r = trimTranscript(msgs, 20_000)
    expect(r.trimmedOutputs).toBeGreaterThan(0)
    expect(r.droppedMessages).toBe(0)
    const last = r.messages.at(-1)
    expect(JSON.stringify(last)).toContain(big) // recent output intact
    const r2 = trimTranscript(msgs, 6_000)
    expect(r2.droppedMessages).toBeGreaterThan(0)
    expect(r2.messages[0]?.role).toBe("user")
  })
})
