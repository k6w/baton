import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent } from "@batonsh/protocol"
import { startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import { acpAdapter, acpAdapters, ACP_PRESETS, createAcpAdapter, fetchAcpRegistry, registryAgentToPreset, TerminalManager, WorkspaceFs } from "./index.ts"
import type { AcpPreset } from "./index.ts"

const MOCK = join(import.meta.dir, "fixtures", "mock-agent.ts")

function mockPreset(over: Partial<AcpPreset> = {}): AcpPreset {
  return {
    id: "mock-acp",
    displayName: "Mock ACP",
    binaries: [process.execPath],
    args: [MOCK],
    authHint: "run `mock login` first",
    ...over,
  }
}

const adapter = createAcpAdapter(mockPreset())

type Of<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>
const ofType = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) => events.filter((e) => e.type === type) as Of<T>[]
const assistantText = (events: AgentEvent[]) =>
  ofType(events, "message.completed")
    .filter((e) => e.data.role === "assistant")
    .map((e) => e.data.text)

describe("acp adapter — mock agent mapping", () => {
  test("full turn maps to BEP deterministically", async () => {
    const cwd = tempWorkspace({ "notes.txt": "teh quick brown fox\n" })
    const h = await startHarness(adapter, { cwd, systemPrompt: "You are a careful test agent." })
    try {
      expect(h.ofType("agent.session").length).toBe(1)
      const sid = h.ofType("agent.session")[0]?.data.sessionId
      expect(h.session.resumeId()).toBe(sid)
      expect(h.ofType("agent.updated").some((e) => e.data.version === "9.9.9" && e.data.model === "mock/fast")).toBe(true)

      await h.session.prompt({ text: "full" })
      await h.waitTurn(20_000)
      const ev = h.events
      const types = ev.map((e) => e.type)

      // turn lifecycle
      const started = h.ofType("turn.started")
      const completed = h.ofType("turn.completed")
      expect(started.length).toBe(1)
      expect(completed[0]?.data).toEqual({ turnId: started[0]?.data.turnId as string, stopReason: "end_turn" })
      expect(types.indexOf("turn.started")).toBeLessThan(types.indexOf("message.delta"))
      expect(types.lastIndexOf("message.completed")).toBeLessThan(types.indexOf("turn.completed"))

      // thoughts + messages
      const thoughtDeltas = h.ofType("message.delta").filter((e) => e.data.role === "thought")
      expect(thoughtDeltas.map((e) => e.data.text)).toEqual(["Let me ", "think."])
      const done = h.ofType("message.completed")
      expect(done.filter((e) => e.data.role === "thought").map((e) => e.data.text)).toEqual(["Let me think."])
      expect(assistantText(ev)).toEqual(["Hello world", "Done."])
      const ids = new Set(done.map((e) => e.data.messageId))
      expect(ids.size).toBe(3)

      // plan
      expect(h.ofType("plan.updated")[0]?.data.entries).toEqual([
        { content: "Read notes", status: "completed", priority: "high" },
        { content: "Fix typo", status: "in_progress", priority: "medium" },
        { content: "Run check", status: "pending", priority: "low" },
      ])

      // read tool
      const calls = h.ofType("tool.call")
      const read = calls.find((c) => c.data.toolCallId === "read-1")
      expect(read?.data).toMatchObject({ kind: "read", name: "Read", title: "Read(notes.txt)", status: "in_progress" })
      const readUpd = h.ofType("tool.update").filter((u) => u.data.toolCallId === "read-1")
      expect(readUpd.at(-1)?.data.status).toBe("completed")
      expect(readUpd.flatMap((u) => u.data.content ?? [])).toEqual([{ type: "text", text: "teh quick brown fox\n" }])

      // edit tool + permission + diff
      const edit = calls.find((c) => c.data.toolCallId === "edit-1")
      expect(edit?.data).toMatchObject({ kind: "edit", name: "Edit", title: "Edit(notes.txt)", status: "pending" })
      const perm = h.ofType("permission.requested")[0]
      expect(perm?.data).toMatchObject({ toolCallId: "edit-1", kind: "edit", title: "Edit(notes.txt)" })
      expect(perm?.data.options).toEqual([
        { optionId: "allow-1", name: "Allow", kind: "allow_once" },
        { optionId: "always-1", name: "Always", kind: "allow_always" },
        { optionId: "reject-1", name: "Reject", kind: "reject_once" },
      ])
      expect(h.ofType("permission.resolved")[0]?.data).toEqual({ requestId: perm?.data.requestId as string, optionId: "allow-1", kind: "allow_once", by: "user" })
      expect(types).toContain("agent.status")
      expect(h.ofType("agent.status").some((e) => e.data.status === "awaiting_approval")).toBe(true)
      const editUpd = h.ofType("tool.update").filter((u) => u.data.toolCallId === "edit-1")
      const diffs = editUpd.flatMap((u) => u.data.content ?? []).filter((c) => c.type === "diff")
      expect(diffs.length).toBe(1) // fs write diff + identical agent-reported diff are deduped
      const diff = diffs[0] as Extract<(typeof diffs)[number], { type: "diff" }>
      expect(diff.path).toBe(join(cwd, "notes.txt"))
      expect(diff.oldText).toBe("teh quick brown fox\n")
      expect(diff.newText).toBe("the quick brown fox\n")
      expect([diff.added, diff.removed]).toEqual([1, 1])
      expect(diff.lines).toEqual([
        { kind: "del", text: "teh quick brown fox", oldLine: 1 },
        { kind: "add", text: "the quick brown fox", newLine: 1 },
      ])
      expect(editUpd.at(-1)?.data.status).toBe("completed")
      expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("the quick brown fox\n")

      // terminal tool
      const exec = calls.find((c) => c.data.toolCallId === "exec-1")
      expect(exec?.data).toMatchObject({ kind: "execute", name: "Bash", title: "Bash(echo hi-from-term)" })
      const execUpd = h.ofType("tool.update").filter((u) => u.data.toolCallId === "exec-1")
      const terms = execUpd.flatMap((u) => u.data.content ?? []).filter((c) => c.type === "terminal")
      const last = terms.at(-1) as Extract<(typeof terms)[number], { type: "terminal" }>
      expect(last.output).toContain("hi-from-term")
      expect(last.output).toContain("err-line")
      expect(last.exitCode).toBe(0)
      expect(last.command).toBe("echo hi-from-term && echo err-line 1>&2")
      expect(execUpd.at(-1)?.data.status).toBe("completed")

      // usage (cumulative, PromptResponse.usage + usage_update cost)
      expect(h.ofType("usage.updated").at(-1)?.data).toEqual({
        input: 100,
        cachedInput: 10,
        output: 20,
        reasoning: 5,
        costUsd: 0.01,
        source: "reported",
        mode: "cumulative",
      })

      // what the agent saw: capabilities, client info, system prompt only on the first prompt
      await h.session.prompt({ text: "info" })
      await h.waitTurn(10_000)
      const info = JSON.parse(assistantText(h.events).at(-1) as string)
      expect(info.init.clientCapabilities).toMatchObject({ fs: { readTextFile: true, writeTextFile: true }, terminal: true })
      expect(info.init.clientInfo.name).toBe("baton")
      expect(info.prompts[0]).toBe("<baton-context>\nYou are a careful test agent.\n</baton-context>\n\nfull")
      expect(info.prompts[1]).toBe("info")
    } finally {
      await h.close()
    }
  }, 30_000)

  test("rejected permission → failed tool, file untouched", async () => {
    const cwd = tempWorkspace({ "notes.txt": "teh quick brown fox\n" })
    const h = await startHarness(adapter, { cwd })
    h.autoApprove = "reject_once"
    try {
      await h.session.prompt({ text: "full" })
      await h.waitTurn(20_000)
      expect(h.ofType("permission.resolved")[0]?.data).toMatchObject({ optionId: "reject-1", kind: "reject_once", by: "user" })
      const editUpd = h.ofType("tool.update").filter((u) => u.data.toolCallId === "edit-1")
      expect(editUpd.at(-1)?.data.status).toBe("failed")
      expect(editUpd.flatMap((u) => u.data.content ?? []).length).toBe(0)
      expect(readFileSync(join(cwd, "notes.txt"), "utf8")).toBe("teh quick brown fox\n")
    } finally {
      await h.close()
    }
  }, 30_000)

  test("interrupt cancels a streaming turn", async () => {
    const h = await startHarness(adapter, { cwd: tempWorkspace() })
    try {
      await h.session.prompt({ text: "slow" })
      await h.waitFor("message.delta", undefined, 10_000)
      const turn = h.waitTurn(10_000)
      await h.session.interrupt()
      await turn
      expect(h.ofType("turn.interrupted").length).toBe(1)
      expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("cancelled")
      expect(assistantText(h.events)[0]?.startsWith("tick0 ")).toBe(true)
    } finally {
      await h.close()
    }
  }, 20_000)

  test("interrupt answers pending permission requests with cancelled", async () => {
    const h = await startHarness(adapter, { cwd: tempWorkspace() })
    h.autoApprove = "off"
    try {
      await h.session.prompt({ text: "perm-wait" })
      const req = await h.waitFor("permission.requested", undefined, 10_000)
      expect(req.data).toMatchObject({ toolCallId: "wait-1", kind: "execute", title: "Bash(rm -rf build)", detail: "rm -rf build" })
      const turn = h.waitTurn(10_000)
      await h.session.interrupt()
      await turn
      expect(h.ofType("permission.resolved")[0]?.data).toEqual({ requestId: req.data.requestId, optionId: null, kind: null, by: "cancelled" })
      expect(assistantText(h.events)).toEqual(["outcome=cancelled"])
      expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("cancelled")
    } finally {
      await h.close()
    }
  }, 20_000)

  test("respondPermission(null) cancels just that request", async () => {
    const h = await startHarness(adapter, { cwd: tempWorkspace() })
    h.autoApprove = "off"
    try {
      await h.session.prompt({ text: "perm-wait" })
      const req = await h.waitFor("permission.requested", undefined, 10_000)
      await h.session.respondPermission(req.data.requestId, null)
      await h.waitFor("turn.completed", undefined, 10_000)
      expect(h.ofType("permission.resolved")[0]?.data.by).toBe("user")
      expect(assistantText(h.events)).toEqual(["outcome=cancelled"])
    } finally {
      await h.close()
    }
  }, 20_000)

  test("prompts sent during a turn are queued", async () => {
    const h = await startHarness(adapter, { cwd: tempWorkspace() })
    try {
      await h.session.prompt({ text: "one" })
      await h.session.prompt({ text: "two" })
      await h.waitFor("turn.completed", undefined, 10_000)
      if (h.ofType("turn.completed").length < 2) await h.waitTurn(10_000)
      const seq = h.events.filter((e) => e.type === "turn.started" || e.type === "turn.completed").map((e) => e.type)
      expect(seq).toEqual(["turn.started", "turn.completed", "turn.started", "turn.completed"])
      expect(assistantText(h.events)).toEqual(["echo: one", "echo: two"])
    } finally {
      await h.close()
    }
  }, 20_000)

  test("MCP servers are injected as HTTP entries and model is set via config option", async () => {
    const h = await startHarness(adapter, {
      cwd: tempWorkspace(),
      model: "smart",
      mcpServers: [{ name: "baton", url: "http://127.0.0.1:4999/mcp", headers: { Authorization: "Bearer t" } }],
    })
    try {
      expect(h.ofType("agent.updated").some((e) => e.data.model === "mock/smart")).toBe(true)
      await h.session.prompt({ text: "info" })
      await h.waitTurn(10_000)
      const info = JSON.parse(assistantText(h.events).at(-1) as string)
      expect(info.mcpServers).toEqual([{ type: "http", name: "baton", url: "http://127.0.0.1:4999/mcp", headers: [{ name: "Authorization", value: "Bearer t" }] }])
      expect(info.model).toBe("mock/smart")
      await h.session.setModel?.("Mock Fast")
      await h.session.prompt({ text: "info" })
      await h.waitTurn(10_000)
      expect(JSON.parse(assistantText(h.events).at(-1) as string).model).toBe("mock/fast")
    } finally {
      await h.close()
    }
  }, 20_000)

  test("resumeId → session/load without surfacing replayed history", async () => {
    const h = await startHarness(adapter, { cwd: tempWorkspace(), resumeId: "mock-old", systemPrompt: "ignored on resume" })
    try {
      expect(h.session.resumeId()).toBe("mock-old")
      expect(h.ofType("message.delta").length).toBe(0)
      await h.session.prompt({ text: "info" })
      await h.waitTurn(10_000)
      const info = JSON.parse(assistantText(h.events).at(-1) as string)
      expect(info.loadedFrom).toBe("mock-old")
      expect(info.prompts).toEqual(["info"])
      expect(h.events.some((e) => e.type === "message.delta" && e.data.text.includes("REPLAYED"))).toBe(false)
    } finally {
      await h.close()
    }
  }, 20_000)

  test("auth_required → non-interactive method is used when available", async () => {
    const a = createAcpAdapter(mockPreset({ env: { MOCK_REQUIRE_AUTH: "1", MOCK_API_KEY: "k" } }))
    const h = await startHarness(a, { cwd: tempWorkspace() })
    try {
      await h.session.prompt({ text: "hi" })
      await h.waitTurn(10_000)
      expect(assistantText(h.events)).toEqual(["echo: hi"])
    } finally {
      await h.close()
    }
  }, 20_000)

  test("auth_required without usable method → error event with hint, start rejects", async () => {
    const a = createAcpAdapter(mockPreset({ env: { MOCK_REQUIRE_AUTH: "1" } }))
    const events: AgentEvent[] = []
    const err = await a
      .start(
        { agentId: "a1", name: "m", cwd: tempWorkspace(), mcpServers: [], approval: "ask" },
        { emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal },
      )
      .then(() => undefined)
      .catch((e: Error) => e)
    expect(err?.message).toContain("run `mock login` first")
    const e = ofType(events, "error")[0]
    expect(e?.data.message).toContain("requires authentication — run `mock login` first")
    expect(e?.data.detail).toContain("Login with browser")
    expect(e?.data.fatal).toBe(true)
  }, 20_000)

  test("writes outside the workspace are rejected", async () => {
    const h = await startHarness(adapter, { cwd: tempWorkspace() })
    try {
      await h.session.prompt({ text: "outside" })
      await h.waitTurn(10_000)
      expect(assistantText(h.events)[0]).toStartWith("write-rejected")
      expect(existsSync("/tmp/baton-acp-mock-outside.txt")).toBe(false)
    } finally {
      await h.close()
    }
  }, 20_000)

  test("agent crash → error + agent.exited, turn ends with error", async () => {
    const h = await startHarness(adapter, { cwd: tempWorkspace() })
    try {
      await h.session.prompt({ text: "crash" })
      const exited = await h.waitFor("agent.exited", undefined, 10_000)
      expect(exited.data).toEqual({ code: 3, reason: "crashed" })
      await h.waitFor("turn.completed", undefined, 10_000)
      expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("error")
      expect(h.ofType("error").some((e) => e.data.fatal && e.data.message.includes("exited unexpectedly"))).toBe(true)
    } finally {
      await h.close()
    }
  }, 20_000)

  test("close() emits agent.exited(closed)", async () => {
    const h = await startHarness(adapter, { cwd: tempWorkspace() })
    await h.close()
    expect(h.ofType("agent.exited")[0]?.data.reason).toBe("closed")
    expect(h.ofType("error").length).toBe(0)
  }, 20_000)
})

describe("acp adapter — detect / presets / registry", () => {
  test("detect() finds the binary and version", async () => {
    const d = await createAcpAdapter(mockPreset()).detect()
    expect(d).toMatchObject({ installed: true, path: process.execPath, protocols: ["acp"], auth: "unknown" })
    expect(d.version).toBe(Bun.version)
  })

  test("generic adapter needs a command", async () => {
    expect((await acpAdapter.detect()).installed).toBe(false)
    expect((await acpAdapter.detect({ command: process.execPath })).installed).toBe(true)
    const h = await startHarness(acpAdapter, { cwd: tempWorkspace(), command: process.execPath, args: [MOCK] })
    try {
      await h.session.prompt({ text: "ping" })
      await h.waitTurn(10_000)
      expect(assistantText(h.events)).toEqual(["echo: ping"])
    } finally {
      await h.close()
    }
  }, 20_000)

  test("presets cover the expected agents with unique ids", () => {
    const ids = ACP_PRESETS.map((p) => p.id)
    for (const id of ["gemini", "cursor", "copilot", "kiro", "goose", "qwen", "droid", "opencode-acp", "claude-acp", "codex-acp", "cline"]) expect(ids).toContain(id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(acpAdapters.map((a) => a.id)).toContain("acp")
    for (const a of acpAdapters) {
      expect(a.family).toBe("acp")
      expect(a.capabilities()).toMatchObject({ steer: false, interrupt: true, permissions: true, diff: true, mcp: true })
    }
  })

  test("registry entries convert to presets", async () => {
    const bin = registryAgentToPreset(
      {
        id: "goose",
        name: "Goose",
        version: "1.0.0",
        distribution: { binary: { "darwin-aarch64": { cmd: "./goose", args: ["acp"] }, "linux-x86_64": { cmd: "./goose", args: ["acp"] } } },
      },
      "darwin-aarch64",
    )
    expect(bin).toMatchObject({ id: "goose", displayName: "Goose", binaries: ["goose"], args: ["acp"] })
    const npx = registryAgentToPreset({ id: "gemini", name: "Gemini CLI", distribution: { npx: { package: "@google/gemini-cli@0.63.0", args: ["--acp"] } } })
    expect(npx).toMatchObject({ binaries: ["gemini-cli", "gemini"], args: ["--acp"] })
    expect(registryAgentToPreset({ id: "x", distribution: {} })).toBeUndefined()
    const failing = (async () => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await fetchAcpRegistry({ fetch: failing })).toEqual([])
    const ok = (async () =>
      new Response(JSON.stringify({ version: "1.0.0", agents: [{ id: "kimi", name: "Kimi", distribution: { npx: { package: "kimi-cli@1.0.0", args: ["acp"] } } }] }))) as unknown as typeof fetch
    expect(await fetchAcpRegistry({ fetch: ok })).toMatchObject([{ id: "kimi", binaries: ["kimi-cli", "kimi"], args: ["acp"] }])
  })
})

describe("acp client-side services", () => {
  test("terminal output is truncated from the start at the byte limit", async () => {
    const tm = new TerminalManager({ cwd: tempWorkspace(), env: {} })
    const id = tm.create({ command: "printf 'é%.0s' $(seq 1 50); printf END", outputByteLimit: 11 })
    const exit = await tm.waitForExit(id)
    expect(exit).toEqual({ exitCode: 0, signal: null })
    const out = tm.output(id)
    expect(out.truncated).toBe(true)
    expect(out.output.endsWith("END")).toBe(true)
    expect(Buffer.byteLength(out.output)).toBeLessThanOrEqual(11)
    expect(out.output).not.toContain("�")
    tm.release(id)
    expect(tm.has(id)).toBe(false)
  })

  test("terminal kill reports a signal", async () => {
    const tm = new TerminalManager({ cwd: tempWorkspace(), env: {} })
    const id = tm.create({ command: "sleep", args: ["30"] })
    tm.kill(id)
    const exit = await tm.waitForExit(id)
    expect(exit.exitCode).toBeNull()
    expect(exit.signal).toBe("SIGTERM")
  })

  test("workspace fs confines paths", () => {
    const cwd = tempWorkspace({ "a.txt": "1\n2\n3\n" })
    const fs = new WorkspaceFs(cwd)
    expect(fs.read(join(cwd, "a.txt"), 2, 1)).toBe("2")
    expect(() => fs.read(join(cwd, "..", "x.txt"))).toThrow(/outside the workspace/)
    expect(() => fs.write("/etc/hosts", "x")).toThrow(/outside the workspace/)
    expect(fs.write("sub/dir/b.txt", "hi").oldText).toBeNull()
    expect(fs.display(join(cwd, "sub/dir/b.txt"))).toBe("sub/dir/b.txt")
  })
})
