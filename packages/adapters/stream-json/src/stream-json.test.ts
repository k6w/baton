import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"
import type { AgentAdapter, SessionConfig } from "../../../protocol/src/index.ts"
import { type Harness, startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import { ampPreset, claudeCliPreset, createStreamJsonAdapter, qwenStreamPreset, type StreamJsonPreset } from "./index.ts"

const FAKE = join(import.meta.dir, "fixtures", "fake-cli.ts")

function fakeAdapter(base: StreamJsonPreset): AgentAdapter {
  return createStreamJsonAdapter({ ...base, id: `${base.id}-fake`, binaries: [process.execPath], prefixArgs: [FAKE] }, { timings: { interruptGraceMs: 3_000 } })
}

type Logged = { argv?: string[]; stdin?: Record<string, any>; signal?: string; child?: number }

interface Run {
  h: Harness
  cwd: string
  logged(): Logged[]
  stdin(): Record<string, any>[]
}

const open: Harness[] = []
afterEach(async () => {
  for (const h of open.splice(0)) await h.close()
})

async function run(base: StreamJsonPreset, dialect: string, cfg: Partial<SessionConfig> = {}): Promise<Run> {
  const cwd = tempWorkspace({ "notes.txt": "teh quick brown fox\njumps\n" })
  const log = join(cwd, ".fake-log.jsonl")
  const h = await startHarness(fakeAdapter(base), { cwd, ...cfg, env: { FAKE_DIALECT: dialect, FAKE_LOG: log, ...(cfg.env ?? {}) } })
  open.push(h)
  const logged = (): Logged[] => {
    try {
      return readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return { h, cwd, logged, stdin: () => logged().flatMap((l) => (l.stdin ? [l.stdin] : [])) }
}

const assistantText = (h: Harness, kind: "message.delta" | "message.completed") =>
  h
    .ofType(kind)
    .filter((e) => e.data.role === "assistant")
    .map((e) => e.data.text)
    .join("")

const statuses = (h: Harness) => h.ofType("agent.status").map((e) => e.data.status)

describe("stream-json: claude dialect (fake CLI)", () => {
  test("full BEP mapping: session, turn, deltas, edit tool with diff, usage, cost", async () => {
    const r = await run(claudeCliPreset, "claude", {
      approval: "auto-edit",
      model: "sonnet",
      systemPrompt: "You are a baton worker.",
      mcpServers: [{ name: "baton", url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer x" } }],
    })
    const { h } = r
    await h.session.prompt({ text: "fix the typo" })
    await h.waitTurn(10_000)

    expect(h.ofType("agent.session")[0]?.data.sessionId).toBeTruthy()
    expect(h.session.resumeId()).toBe(h.ofType("agent.session")[0]?.data.sessionId)
    expect(h.ofType("agent.updated")[0]?.data).toMatchObject({ model: "fake-sonnet", version: "9.8.7" })
    expect(statuses(h).slice(0, 3)).toEqual(["starting", "ready", "busy"])
    expect(statuses(h).at(-1)).toBe("ready")

    const started = h.ofType("turn.started")
    expect(started).toHaveLength(1)
    expect(started[0]?.data.prompt).toBe("fix the typo")
    expect(h.ofType("message.completed").find((e) => e.data.role === "user")?.data.text).toBe("fix the typo")

    const deltas = h.ofType("message.delta").filter((e) => e.data.messageId === "msg_1:t0")
    expect(deltas.length).toBe(2)
    expect(deltas.map((e) => e.data.text).join("")).toBe("Fixing the typo.")
    expect(assistantText(h, "message.completed")).toBe("Fixing the typo.Done.")
    expect(h.ofType("message.completed").find((e) => e.data.text === "Fixing the typo.")?.data.messageId).toBe("msg_1:t0")

    const call = h.ofType("tool.call")[0]
    expect(call?.data).toMatchObject({ toolCallId: "toolu_1", kind: "edit", name: "Edit", title: "Update(notes.txt)", status: "pending" })
    expect(call?.data.locations?.[0]?.path).toBe(join(realpathSync(r.cwd), "notes.txt"))
    const upd = h.ofType("tool.update").find((e) => e.data.toolCallId === "toolu_1")
    expect(upd?.data.status).toBe("completed")
    expect(upd?.data.summary).toBe("Updated 1 line")
    const diff = upd?.data.content?.find((c) => c.type === "diff")
    expect(diff).toMatchObject({ type: "diff", added: 1, removed: 1, oldText: "teh quick brown fox\njumps\n" })
    if (diff?.type !== "diff") throw new Error("no diff")
    expect(diff.lines).toEqual([
      { kind: "del", text: "teh quick brown fox", oldLine: 1 },
      { kind: "add", text: "the quick brown fox", newLine: 1 },
    ])

    const usage = h.ofType("usage.updated").at(-1)?.data
    expect(usage).toMatchObject({ input: 150, cachedInput: 50, output: 20, costUsd: 0.0123, mode: "cumulative", source: "reported" })
    expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("end_turn")
    expect(readFileSync(join(r.cwd, "notes.txt"), "utf8")).toBe("the quick brown fox\njumps\n")

    // Command line and stdin protocol.
    const argv = r.logged().find((l) => l.argv)?.argv ?? []
    for (const a of ["-p", "--verbose", "--include-partial-messages", "--append-system-prompt"]) expect(argv).toContain(a)
    expect(argv.join(" ")).toContain("--output-format stream-json --input-format stream-json")
    expect(argv.join(" ")).toContain("--permission-mode acceptEdits")
    expect(argv.join(" ")).toContain("--permission-prompt-tool stdio")
    expect(argv.join(" ")).toContain("--model sonnet")
    // the token travels in a private file, never on the command line
    expect(argv.join(" ")).not.toContain("Bearer")
    const mcpFile = argv[argv.indexOf("--mcp-config") + 1] ?? ""
    // POSIX permissions (Windows protects the profile folder with ACLs instead)
    if (process.platform !== "win32") expect(statSync(mcpFile).mode & 0o777).toBe(0o600)
    const mcp = JSON.parse(readFileSync(mcpFile, "utf8"))
    expect(mcp).toEqual({ mcpServers: { baton: { type: "http", url: "http://127.0.0.1:9/mcp", headers: { authorization: "Bearer x" } } } })
    const stdin = r.stdin()
    expect(stdin[0]).toMatchObject({ type: "control_request", request: { subtype: "initialize" } })
    expect(stdin[1]).toMatchObject({ type: "user", message: { role: "user", content: "fix the typo" }, parent_tool_use_id: null })
    expect(typeof stdin[1]?.uuid).toBe("string")
  })

  test("permission request round-trip via can_use_tool (allow)", async () => {
    const r = await run(claudeCliPreset, "claude", { approval: "ask" })
    await r.h.session.prompt({ text: "fix it" })
    await r.h.waitTurn(10_000)
    const req = r.h.ofType("permission.requested")[0]
    expect(req?.data).toMatchObject({ toolCallId: "toolu_1", title: "Update(notes.txt)", kind: "edit" })
    expect(r.h.ofType("permission.resolved")[0]?.data).toMatchObject({ optionId: "allow_once", kind: "allow_once", by: "user" })
    expect(statuses(r.h)).toContain("awaiting_approval")
    const resp = r.stdin().find((m) => m.type === "control_response")
    expect(resp?.response).toMatchObject({ subtype: "success", request_id: "cli_req_1", response: { behavior: "allow", toolUseID: "toolu_1" } })
    expect(r.h.ofType("tool.update").map((e) => e.data.status)).toEqual(["in_progress", "completed"])
    expect(readFileSync(join(r.cwd, "notes.txt"), "utf8")).toStartWith("the quick")
  })

  test("permission denied → failed tool, file untouched", async () => {
    const r = await run(claudeCliPreset, "claude", { approval: "ask" })
    r.h.autoApprove = "reject_once"
    await r.h.session.prompt({ text: "fix it" })
    await r.h.waitTurn(10_000)
    expect(r.h.ofType("permission.resolved")[0]?.data.kind).toBe("reject_once")
    const resp = r.stdin().find((m) => m.type === "control_response")
    expect(resp?.response.response).toMatchObject({ behavior: "deny" })
    expect(r.h.ofType("tool.update").find((e) => e.data.toolCallId === "toolu_1")?.data).toMatchObject({ status: "failed", summary: "Permission denied" })
    expect(readFileSync(join(r.cwd, "notes.txt"), "utf8")).toStartWith("teh quick")
  })

  test("steer folds into the running turn", async () => {
    const { h, stdin } = await run(claudeCliPreset, "claude", { approval: "auto-edit" })
    await h.session.prompt({ text: "slow fix" })
    await h.waitFor("tool.update", (e) => e.data.status === "completed", 10_000)
    await h.session.steer?.({ text: "also check README", from: "lead" })
    await h.waitTurn(10_000)
    expect(assistantText(h, "message.completed")).toContain("Steered: [message from lead]\nalso check README")
    expect(h.ofType("turn.started")).toHaveLength(1)
    expect(h.ofType("turn.completed")).toHaveLength(1)
    expect(stdin().filter((m) => m.type === "user")).toHaveLength(2)
    expect(statuses(h).at(-1)).toBe("ready")
  })

  test("interrupt uses control_request and the session stays usable", async () => {
    const { h, stdin } = await run(claudeCliPreset, "claude", { approval: "auto-edit" })
    await h.session.prompt({ text: "slow fix" })
    await h.waitFor("tool.update", (e) => e.data.status === "completed", 10_000)
    await h.session.interrupt()
    await h.waitFor("turn.interrupted", undefined, 10_000)
    expect(h.ofType("turn.completed")).toHaveLength(0)
    expect(stdin().some((m) => m.type === "control_request" && m.request?.subtype === "interrupt")).toBe(true)
    await h.session.prompt({ text: "ping" })
    await h.waitTurn(10_000)
    expect(assistantText(h, "message.completed")).toContain("PONG")
    expect(h.ofType("agent.exited")).toHaveLength(0)
  })

  test("setModel sends set_model", async () => {
    const { h, stdin } = await run(claudeCliPreset, "claude")
    await h.session.setModel?.("opus")
    expect(stdin().some((m) => m.request?.subtype === "set_model" && m.request.model === "opus")).toBe(true)
    expect(h.ofType("agent.updated").at(-1)?.data.model).toBe("opus")
  })

  test("close ends stdin and reports a clean exit", async () => {
    const { h } = await run(claudeCliPreset, "claude")
    await h.session.prompt({ text: "ping" })
    await h.waitTurn(10_000)
    await h.close()
    expect(h.ofType("agent.exited")[0]?.data).toEqual({ code: 0, reason: "closed" })
    expect(h.ofType("error")).toHaveLength(0)
    expect(statuses(h).at(-1)).toBe("exited")
    expect(h.session.prompt({ text: "again" })).rejects.toThrow("session closed")
  })

  test("crash mid-turn → fatal error + agent.exited", async () => {
    const { h } = await run(claudeCliPreset, "claude")
    await h.session.prompt({ text: "crash now" })
    const exited = await h.waitFor("agent.exited", undefined, 10_000)
    expect(exited.data.code).toBe(3)
    const err = h.ofType("error")[0]
    expect(err?.data.fatal).toBe(true)
    expect(err?.data.detail).toContain("fatal: boom")
    // An unexpected exit fails the turn (the host reports an error result) before agent.exited.
    expect(h.ofType("turn.interrupted")).toHaveLength(0)
    const types = h.events.map((e) => e.type)
    expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("error")
    expect(types.indexOf("turn.completed")).toBeLessThan(types.indexOf("agent.exited"))
    expect(h.ofType("agent.exited")).toHaveLength(1)
    expect(statuses(h).slice(-2)).toEqual(["error", "exited"])
    // A dead CLI rejects new prompts instead of starting a turn that can never finish.
    const started = h.ofType("turn.started").length
    await expect(h.session.prompt({ text: "again" })).rejects.toThrow("not running")
    expect(h.ofType("turn.started")).toHaveLength(started)
    expect(statuses(h).at(-1)).toBe("exited")
  })

  test("CLI dying during startup fails start() without exit events", async () => {
    const events: { type: string }[] = []
    const cwd = tempWorkspace()
    const t = Date.now()
    await expect(
      fakeAdapter(claudeCliPreset).start(
        { agentId: "a", name: "a", cwd, mcpServers: [], approval: "ask", env: { FAKE_DIALECT: "claude", FAKE_EXIT_ON_START: "4" } } as SessionConfig,
        {
          emit: (e) => events.push(e),
          log: () => {},
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toThrow("failed to start")
    expect(Date.now() - t).toBeLessThan(10_000)
    expect(events.filter((e) => e.type === "agent.exited" || e.type === "turn.started")).toHaveLength(0)
  })

  test("close kills the CLI's process group (no orphaned children)", async () => {
    const { h, logged } = await run(claudeCliPreset, "claude")
    await h.session.prompt({ text: "grandchild" })
    await h.waitTurn()
    const child = logged().find((l) => l.child)?.child
    expect(child).toBeGreaterThan(0)
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive(child as number)).toBe(true)
    await h.close()
    for (let i = 0; i < 20 && alive(child as number); i++) await Bun.sleep(100)
    expect(alive(child as number)).toBe(false)
  })
})

describe("stream-json: amp dialect (fake CLI)", () => {
  test("argv, tool-name mapping, snapshot diff, system prompt in first message", async () => {
    const r = await run(ampPreset, "amp", {
      approval: "yolo",
      systemPrompt: "Coordinate via baton.",
      mcpServers: [{ name: "baton", url: "http://127.0.0.1:9/mcp" }],
    })
    const { h } = r
    await h.session.prompt({ text: "fix the typo" })
    await h.waitTurn(10_000)
    const argv = r.logged().find((l) => l.argv)?.argv ?? []
    expect(argv.slice(0, 4)).toEqual(["--execute", "--stream-json", "--stream-json-input", "--dangerously-allow-all"])
    expect(JSON.parse(readFileSync(argv[argv.indexOf("--mcp-config") + 1] ?? "", "utf8"))).toEqual({ baton: { url: "http://127.0.0.1:9/mcp" } })
    const user = r.stdin().find((m) => m.type === "user")
    expect(user?.message.content[0].text).toBe("<system-instructions>\nCoordinate via baton.\n</system-instructions>\n\nfix the typo")
    expect(user?.steer).toBeUndefined()

    expect(h.ofType("agent.session")[0]?.data.sessionId).toStartWith("T-")
    const call = h.ofType("tool.call")[0]?.data
    expect(call).toMatchObject({ name: "edit_file", kind: "edit", title: "Update(notes.txt)" })
    expect(call?.rawInput).toMatchObject({ old_str: "teh", new_str: "the" })
    const diff = h.ofType("tool.update")[0]?.data.content?.find((c) => c.type === "diff")
    expect(diff).toMatchObject({ added: 1, removed: 1, oldText: "teh quick brown fox\njumps\n" })
    expect(h.ofType("message.delta")).toHaveLength(0)
    expect(assistantText(h, "message.completed")).toBe("Fixing the typo.Done.")
    expect(h.ofType("usage.updated").at(-1)?.data).toMatchObject({ input: 150, output: 20 })
    expect(h.ofType("turn.completed")).toHaveLength(1)
  })

  test("steer sends steer:true and stays in the same turn", async () => {
    const r = await run(ampPreset, "amp")
    await r.h.session.prompt({ text: "slow fix" })
    await r.h.waitFor("tool.update", (e) => e.data.status === "completed", 10_000)
    await r.h.session.steer?.({ text: "and README" })
    await r.h.waitTurn(10_000)
    expect(r.stdin().find((m) => m.steer === true)?.message.content[0].text).toBe("and README")
    expect(assistantText(r.h, "message.completed")).toContain("Steered: and README")
    expect(r.h.ofType("turn.started")).toHaveLength(1)
  })

  test("prompts sent while busy are held by baton and run as the next turn", async () => {
    const r = await run(ampPreset, "amp")
    await r.h.session.prompt({ text: "first fix" })
    await r.h.session.prompt({ text: "ping" })
    await r.h.waitFor("tool.call", undefined, 10_000)
    expect(r.stdin().filter((m) => m.type === "user")).toHaveLength(1)
    await r.h.waitFor("turn.completed", undefined, 10_000)
    await r.h.waitFor("message.completed", (e) => e.data.text === "PONG", 10_000)
    await Bun.sleep(50)
    expect(r.h.ofType("turn.started").map((e) => e.data.prompt)).toEqual(["first fix", "ping"])
    expect(r.h.ofType("turn.completed")).toHaveLength(2)
  })

  // skipped on Windows: POSIX signals
  test.skipIf(process.platform === "win32")("interrupt = SIGINT; exited CLI is resumed with `threads continue`", async () => {
    const r = await run(ampPreset, "amp")
    await r.h.session.prompt({ text: "slow fix" })
    await r.h.waitFor("tool.update", (e) => e.data.status === "completed", 10_000)
    const sid = r.h.session.resumeId()
    await r.h.session.interrupt()
    await r.h.waitFor("turn.interrupted", undefined, 10_000)
    expect(r.logged().some((l) => l.signal === "SIGINT")).toBe(true)
    await r.h.session.prompt({ text: "ping" })
    await r.h.waitFor("message.completed", (e) => e.data.text === "PONG", 10_000)
    await r.h.waitFor("turn.completed", undefined, 10_000)
    const launches = r.logged().filter((l) => l.argv)
    expect(launches).toHaveLength(2)
    expect(launches[1]?.argv?.slice(0, 3)).toEqual(["threads", "continue", sid ?? ""])
    expect(r.h.ofType("agent.exited")).toHaveLength(0)
    expect(r.h.session.resumeId()).toBe(sid)
  })
})

describe("stream-json: qwen dialect (fake CLI)", () => {
  test("session_start, initialize with MCP, permissions, native tool names", async () => {
    const r = await run(qwenStreamPreset, "qwen", {
      approval: "ask",
      model: "qwen3-coder-plus",
      mcpServers: [{ name: "baton", url: "http://127.0.0.1:9/mcp" }],
    })
    const { h } = r
    await h.session.prompt({ text: "fix the typo" })
    await h.waitTurn(10_000)
    const argv = r.logged().find((l) => l.argv)?.argv ?? []
    expect(argv.join(" ")).toContain("--output-format stream-json --input-format stream-json --include-partial-messages --approval-mode default")
    expect(argv.join(" ")).toContain("--model qwen3-coder-plus")
    const init = r.stdin()[0]
    expect(init?.request).toMatchObject({ subtype: "initialize", mcpServers: { baton: { httpUrl: "http://127.0.0.1:9/mcp" } } })
    expect(h.ofType("agent.updated")[0]?.data).toMatchObject({ model: "qwen3-coder-plus", version: "0.9.1" })
    expect(h.ofType("agent.session")).toHaveLength(1)
    expect(h.ofType("permission.requested")[0]?.data).toMatchObject({ title: "Update(notes.txt)", kind: "edit" })
    expect(h.ofType("tool.call")[0]?.data).toMatchObject({ name: "edit", kind: "edit" })
    expect(
      h
        .ofType("tool.update")
        .at(-1)
        ?.data.content?.some((c) => c.type === "diff"),
    ).toBe(true)
    expect(assistantText(h, "message.delta")).toBe("Fixing the typo.Done.")
    expect(readFileSync(join(r.cwd, "notes.txt"), "utf8")).toStartWith("the quick")
  })

  test("failing result surfaces the error and ends the turn", async () => {
    const { h } = await run(qwenStreamPreset, "qwen", { approval: "yolo" })
    await h.session.prompt({ text: "fail please" })
    await h.waitTurn(10_000)
    expect(h.ofType("error")[0]?.data.message).toBe("model exploded")
    expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("error")
  })

  test("interrupt via control_request", async () => {
    const r = await run(qwenStreamPreset, "qwen", { approval: "yolo" })
    expect(r.h.session.steer).toBeUndefined()
    await r.h.session.prompt({ text: "slow fix" })
    await r.h.waitFor("tool.update", (e) => e.data.status === "completed", 10_000)
    await r.h.session.interrupt()
    await r.h.waitFor("turn.interrupted", undefined, 10_000)
    expect(r.stdin().some((m) => m.request?.subtype === "interrupt")).toBe(true)
  })
})

describe("stream-json: detect", () => {
  test("version from the binary; missing binary", async () => {
    const d = await fakeAdapter(ampPreset).detect()
    expect(d).toMatchObject({ installed: true, version: "9.8.7", path: process.execPath, protocols: ["stream-json"] })
    const missing = await createStreamJsonAdapter({ ...ampPreset, binaries: ["baton-definitely-not-installed"] }).detect()
    expect(missing).toMatchObject({ installed: false, auth: "unknown" })
  })

  test("start fails clearly when the binary is missing", async () => {
    const a = createStreamJsonAdapter({ ...qwenStreamPreset, binaries: ["baton-definitely-not-installed"] })
    expect(startHarness(a, { cwd: tempWorkspace() })).rejects.toThrow("not found on PATH")
  })
})
