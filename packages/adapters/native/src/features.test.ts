import "./testing/env.ts"
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent, SessionConfig } from "@batonsh/protocol"
import type { ModelMessage } from "ai"
import { type Harness, startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import { renderForSummary, splitForCompaction } from "./context.ts"
import { nativeAdapter } from "./index.ts"
import { loadSession, pruneSessions, saveSession, sessionsDir } from "./sessions.ts"
import { TEST_STATE_DIR } from "./testing/env.ts"
import { type FakeAnthropic, fakeAnthropic } from "./testing/fake-anthropic.ts"
import { contentText, type FakeLLM, type FakeRequest, type FakeScript, fakeLLM } from "./testing/fake-llm.ts"
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

function anthropic(script: Parameters<typeof fakeAnthropic>[0]): FakeAnthropic {
  const s = fakeAnthropic(script)
  servers.push(s)
  return s
}

async function start(fake: FakeLLM, cfg: Partial<SessionConfig> & { cwd: string }): Promise<Harness> {
  return startHarness(nativeAdapter, {
    model: "gpt-4o-mini",
    provider: { id: "fake", kind: "openai-compatible", baseUrl: fake.baseUrl, apiKey: "sk-test-SECRET" },
    ...cfg,
  })
}

/** Start with a log collector (the testkit harness drops logs). */
async function startLogged(cfg: Partial<SessionConfig> & { cwd: string; provider: SessionConfig["provider"] }) {
  const events: AgentEvent[] = []
  const logs: string[] = []
  const session = await nativeAdapter.start(
    { agentId: "a", name: "w", mcpServers: [], approval: "yolo", model: "m", ...cfg },
    { emit: (e) => events.push(e), log: (l, m) => logs.push(`${l}: ${m}`), signal: new AbortController().signal },
  )
  const waitTurns = async (n: number, ms = 10_000) => {
    const end = Date.now() + ms
    while (Date.now() < end && events.filter((e) => e.type === "turn.completed").length < n) await Bun.sleep(20)
    expect(events.filter((e) => e.type === "turn.completed").length).toBeGreaterThanOrEqual(n)
  }
  return { session, events, logs, waitTurns }
}

const texts = (req: FakeRequest | undefined) => (req?.body.messages ?? []).map((m) => contentText(m.content))
const isCompaction = (r: FakeRequest) => contentText(r.body.messages[0]?.content).includes("You are compacting the conversation history")

// ───────────────────────────── sessions ─────────────────────────────

describe("persistent sessions", () => {
  test("saved to <stateDir>/native-sessions/<id>.json (0600, no secrets) and resumable from disk", async () => {
    const fake = llm([{ text: "remembered" }, { text: "still here" }])
    const cwd = tempWorkspace()
    const h1 = await start(fake, { cwd, approval: "yolo" })
    await h1.session.prompt({ text: "my name is Ada" })
    await h1.waitTurn(10_000)
    const id = h1.session.resumeId() as string
    await h1.close()

    const file = join(TEST_STATE_DIR, "native-sessions", `${id}.json`)
    expect(sessionsDir()).toBe(join(TEST_STATE_DIR, "native-sessions"))
    expect(existsSync(file)).toBe(true)
    // POSIX permissions (Windows protects the profile folder with ACLs instead)
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
    const raw = readFileSync(file, "utf8")
    expect(raw).not.toContain("sk-test-SECRET")
    expect(raw).not.toContain(fake.baseUrl)
    const stored = JSON.parse(raw)
    expect(stored).toMatchObject({ version: 1, id, providerId: "fake", model: "gpt-4o-mini" })
    expect(stored.messages.map((m: ModelMessage) => m.role)).toEqual(["user", "assistant"])

    // a session written by an earlier daemon (not in this process's memory) resumes from disk
    const diskId = `baton_disk_${Date.now()}`
    saveSession({ ...stored, id: diskId, messages: [...stored.messages, { role: "user", content: "and I like tea" }, { role: "assistant", content: "noted" }] })
    const h2 = await start(fake, { cwd, approval: "yolo", resumeId: diskId })
    try {
      expect(h2.session.resumeId()).toBe(diskId)
      await h2.session.prompt({ text: "what is my name?" })
      await h2.waitTurn(10_000)
      const t = texts(fake.requests[1])
      expect(t).toContain("my name is Ada")
      expect(t).toContain("and I like tea")
    } finally {
      await h2.close()
    }
    expect(loadSession(diskId)?.messages.length).toBe(6)
  })

  test("fork copies the conversation into a new session; the original is untouched", async () => {
    const fake = llm([{ text: "one" }, { text: "forked answer" }])
    const cwd = tempWorkspace()
    const h1 = await start(fake, { cwd, approval: "yolo" })
    await h1.session.prompt({ text: "base question" })
    await h1.waitTurn(10_000)
    const baseId = h1.session.resumeId() as string
    await h1.close()

    const h2 = await start(fake, { cwd, approval: "yolo", resumeId: baseId, options: { fork: true } })
    try {
      const forkId = h2.session.resumeId() as string
      expect(forkId).not.toBe(baseId)
      expect(h2.ofType("agent.session")[0]?.data.sessionId).toBe(forkId)
      expect(loadSession(forkId)?.forkedFrom).toBe(baseId) // saved right away
      await h2.session.prompt({ text: "fork question" })
      await h2.waitTurn(10_000)
      expect(texts(fake.requests[1])).toContain("base question")
      expect(loadSession(forkId)?.messages.length).toBe(4)
      expect(loadSession(baseId)?.messages.length).toBe(2)
    } finally {
      await h2.close()
    }
    expect(nativeAdapter.capabilities().fork).toBe(true)
  })

  test("pruning removes sessions older than 30 days; bad ids are rejected", () => {
    const dir = join(TEST_STATE_DIR, "prune-test")
    mkdirSync(dir, { recursive: true })
    const base = { version: 1 as const, createdAt: "", updatedAt: "", messages: [] }
    saveSession({ ...base, id: "old" }, dir)
    saveSession({ ...base, id: "new" }, dir)
    const old = (Date.now() - 31 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(join(dir, "old.json"), old, old)
    expect(pruneSessions(dir)).toBe(1)
    expect(existsSync(join(dir, "old.json"))).toBe(false)
    expect(existsSync(join(dir, "new.json"))).toBe(true)
    expect(loadSession("../../etc/passwd", dir)).toBeUndefined()
    expect(() => saveSession({ ...base, id: "../escape" }, dir)).toThrow(/invalid session id/)
    writeFileSync(join(dir, "corrupt.json"), "{not json")
    expect(loadSession("corrupt", dir)).toBeUndefined()
  })
})

// ───────────────────────────── compaction ─────────────────────────────

describe("context compaction", () => {
  test("split keeps the task and the recent messages; summary input drops tool results", () => {
    const msgs: ModelMessage[] = [
      { role: "user", content: "TASK" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "read_file", input: { path: "a" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", toolName: "read_file", output: { type: "text", value: "SECRET OUTPUT" } }] },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
      { role: "user", content: "next" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "2", toolName: "grep", input: { pattern: "x" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "2", toolName: "grep", output: { type: "text", value: "hit" } }] },
    ]
    const s = splitForCompaction(msgs, 1)
    expect(s?.head).toEqual([msgs[0] as ModelMessage])
    expect(s?.tail[0]?.role).toBe("assistant") // never starts with an orphaned tool result
    expect(s?.tail).toHaveLength(2)
    const rendered = renderForSummary(s?.middle ?? [])
    expect(rendered).toContain('→ read_file({"path":"a"})')
    expect(rendered).toContain("noted")
    expect(rendered).not.toContain("SECRET OUTPUT")
    expect(splitForCompaction(msgs.slice(0, 3), 2)).toBeUndefined()
  })

  test("reported input tokens over 75% trigger a model-written summary", async () => {
    const fake = llm((r) => {
      if (isCompaction(r)) return { text: "SUMMARY: read alpha.txt, it holds the alpha content.", usage: { prompt: 300, completion: 40 } }
      const main = fake.requests.filter((x) => !isCompaction(x)).length
      if (main === 1) return { toolCalls: [{ name: "read_file", args: { path: "alpha.txt" } }], usage: { prompt: 400, completion: 10 } }
      if (main === 2) return { toolCalls: [{ name: "read_file", args: { path: "beta.txt" } }], usage: { prompt: 1600, completion: 10 } }
      return { text: "done" }
    })
    const cwd = tempWorkspace({ "alpha.txt": "ALPHA-CONTENT\n", "beta.txt": "BETA-CONTENT\n" })
    const s = await startLogged({
      cwd,
      provider: { id: "fake", kind: "openai-compatible", baseUrl: fake.baseUrl },
      options: { contextTokens: 2000, compactKeepMessages: 2 },
    })
    try {
      await s.session.prompt({ text: "THE ORIGINAL TASK" })
      await s.waitTurns(1)
      const compactions = fake.requests.filter(isCompaction)
      expect(compactions).toHaveLength(1)
      const excerpt = contentText(compactions[0]?.body.messages.at(-1)?.content)
      expect(excerpt).toContain("read_file")
      expect(excerpt).not.toContain("ALPHA-CONTENT") // tool results are dropped
      // the request after compaction: task + summary + recent messages verbatim
      const after = fake.requests.at(-1) as FakeRequest
      const t = texts(after)
      expect(t[1]).toBe("THE ORIGINAL TASK")
      expect(t[2]).toContain("SUMMARY: read alpha.txt")
      expect(t.join("\n")).toContain("BETA-CONTENT")
      expect(t.join("\n")).not.toContain("ALPHA-CONTENT")
      expect(s.logs.some((l) => l.includes("orch.note: context compacted"))).toBe(true)
      const thoughts = s.events.filter((e) => e.type === "message.completed" && e.data.role === "thought")
      expect(thoughts.map((e) => (e.type === "message.completed" ? e.data.text : ""))).toContain("(context compacted)")
      // the summary call's tokens are counted
      const usage = s.events.filter((e) => e.type === "usage.updated").at(-1)
      expect(usage?.type === "usage.updated" ? usage.data.input : 0).toBe(400 + 1600 + 300 + 100)
    } finally {
      await s.session.close()
    }
  })

  test("a failed summary call falls back to trimming and the turn continues", async () => {
    const fake = llm((r) => {
      if (isCompaction(r)) return { error: { status: 400, message: "summary refused" } }
      const main = fake.requests.filter((x) => !isCompaction(x)).length
      if (main <= 2) return { toolCalls: [{ name: "read_file", args: { path: "a.txt" } }], usage: { prompt: main === 1 ? 1700 : 1900, completion: 10 } }
      return { text: "finished anyway" }
    })
    const s = await startLogged({
      cwd: tempWorkspace({ "a.txt": "x\n" }),
      provider: { id: "fake", kind: "openai-compatible", baseUrl: fake.baseUrl },
      options: { contextTokens: 2000, compactKeepMessages: 2 },
    })
    try {
      await s.session.prompt({ text: "task" })
      await s.waitTurns(1)
      expect(s.logs.some((l) => l.startsWith("warn: context compaction failed"))).toBe(true)
      expect(s.events.some((e) => e.type === "message.completed" && e.data.text === "finished anyway")).toBe(true)
      // no retry storm: one attempt until the context grows by 10%
      expect(fake.requests.filter(isCompaction)).toHaveLength(1)
    } finally {
      await s.session.close()
    }
  })
})

// ───────────────────────────── Anthropic prompt caching ─────────────────────────────

describe("anthropic prompt caching", () => {
  const lastBlock = (m: { content: unknown } | undefined) => (Array.isArray(m?.content) ? (m?.content.at(-1) as { cache_control?: unknown }) : undefined)

  test("cache_control on the system prompt and the last user/tool message; cache tokens priced", async () => {
    const fake = anthropic([
      { toolCalls: [{ name: "list_dir", args: {} }], usage: { input: 100, output: 50, cacheRead: 2000, cacheWrite: 1000 } },
      { text: "done", usage: { input: 10, output: 5, cacheRead: 3100 } },
    ])
    const h = await startHarness(nativeAdapter, {
      cwd: tempWorkspace(),
      approval: "yolo",
      model: "claude-sonnet-4-5",
      provider: { id: "anthropic", kind: "anthropic", baseUrl: fake.baseUrl, apiKey: "sk-ant-test" },
    })
    try {
      await h.session.prompt({ text: "list files" })
      await h.waitTurn(10_000)
      const [r0, r1] = fake.requests
      const sys = r0?.body.system as { cache_control?: unknown }[]
      expect(Array.isArray(sys)).toBe(true)
      expect(sys.at(-1)?.cache_control).toEqual({ type: "ephemeral" })
      expect(lastBlock(r0?.body.messages.at(-1))?.cache_control).toEqual({ type: "ephemeral" })
      // step 2: the breakpoint moved to the tool result; the task message has none any more
      expect(r1?.body.messages.at(-1)?.role).toBe("user")
      expect((lastBlock(r1?.body.messages.at(-1)) as { type?: string })?.type).toBe("tool_result")
      expect(lastBlock(r1?.body.messages.at(-1))?.cache_control).toEqual({ type: "ephemeral" })
      expect(lastBlock(r1?.body.messages[0])?.cache_control).toBeUndefined()

      const usage = h.ofType("usage.updated").map((e) => e.data)
      expect(usage[0]).toMatchObject({ input: 3100, cachedInput: 2000, output: 50 })
      // sonnet 4.5: $3 in, $0.30 cache read, $3.75 cache write, $15 out (per 1M)
      expect(usage[0]?.costUsd).toBeCloseTo((100 * 3 + 2000 * 0.3 + 1000 * 3.75 + 50 * 15) / 1e6, 10)
      expect(usage[1]).toMatchObject({ input: 3100 + 3110, cachedInput: 5100, output: 55 })
    } finally {
      await h.close()
    }
  })

  test("promptCaching = false sends no cache_control", async () => {
    const fake = anthropic([{ text: "ok" }])
    const h = await startHarness(nativeAdapter, {
      cwd: tempWorkspace(),
      approval: "yolo",
      model: "claude-sonnet-4-5",
      provider: { id: "anthropic", kind: "anthropic", baseUrl: fake.baseUrl, apiKey: "k" },
      options: { promptCaching: false },
    })
    try {
      await h.session.prompt({ text: "hi" })
      await h.waitTurn(10_000)
      expect(JSON.stringify(fake.requests[0]?.body)).not.toContain("cache_control")
    } finally {
      await h.close()
    }
  })
})

// ───────────────────────────── parallel tools ─────────────────────────────

describe("parallel read-only tools", () => {
  test("read-only calls of one step run concurrently; writes stay sequential and in order", async () => {
    const cwd = tempWorkspace()
    const log: { path: string; start: number; end: number; marker: boolean }[] = []
    const web = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname
        const entry = { path, start: Date.now(), end: 0, marker: existsSync(join(cwd, "marker.txt")) }
        log.push(entry)
        await Bun.sleep(300)
        entry.end = Date.now()
        return new Response(`page ${path}`)
      },
    })
    servers.push({ stop: () => web.stop(true) })
    const url = (p: string) => `http://127.0.0.1:${web.port}${p}`
    const fake = llm([
      {
        toolCalls: [
          { name: "web_fetch", args: { url: url("/a") } },
          { name: "web_fetch", args: { url: url("/b") } },
          { name: "write_file", args: { path: "marker.txt", content: "m" } },
          { name: "web_fetch", args: { url: url("/c") } },
          { name: "read_file", args: { path: "marker.txt" } },
        ],
      },
      { text: "ok" },
    ])
    const h = await start(fake, { cwd, approval: "yolo", options: { allowPrivateFetch: true } })
    try {
      const t0 = Date.now()
      await h.session.prompt({ text: "go" })
      await h.waitTurn(10_000)
      const byPath = Object.fromEntries(log.map((l) => [l.path, l]))
      // /a and /b overlap
      expect(byPath["/b"]?.start ?? 0).toBeLessThan(byPath["/a"]?.end ?? 0)
      // the write ran after them and before /c
      expect(byPath["/a"]?.marker).toBe(false)
      expect(byPath["/b"]?.marker).toBe(false)
      expect(byPath["/c"]?.marker).toBe(true)
      expect(Date.now() - t0).toBeLessThan(1500)
      // events and results in request order
      expect(h.ofType("tool.call").map((e) => e.data.name)).toEqual(["web_fetch", "web_fetch", "write_file", "web_fetch", "read_file"])
      const results = (fake.requests[1]?.body.messages ?? []).filter((m) => m.role === "tool").map((m) => contentText(m.content))
      expect(results[0]).toContain("page /a")
      expect(results[1]).toContain("page /b")
      expect(results[3]).toContain("page /c")
      expect(results[4]).toContain("1\tm")
    } finally {
      await h.close()
    }
  })

  test("MCP tools marked readOnlyHint run concurrently", async () => {
    const mcp = fakeMcp()
    servers.push(mcp)
    const fake = llm([
      {
        toolCalls: [
          { name: "lookup", args: { key: "x" } },
          { name: "lookup", args: { key: "y" } },
          { name: "add", args: { a: 1, b: 2 } },
        ],
      },
      { text: "ok" },
    ])
    const h = await start(fake, { cwd: tempWorkspace(), approval: "yolo", mcpServers: [{ name: "fake", url: mcp.url }] })
    try {
      await h.session.prompt({ text: "look up" })
      await h.waitTurn(10_000)
      const [x, y, add] = mcp.calls
      expect(x?.tool).toBe("lookup")
      expect(y?.start ?? 0).toBeLessThan(x?.end ?? 0)
      expect(add?.tool).toBe("add")
      const results = (fake.requests[1]?.body.messages ?? []).filter((m) => m.role === "tool").map((m) => contentText(m.content))
      expect(results).toEqual(["value of x", "value of y", "3"])
    } finally {
      await h.close()
    }
  })
})

// ───────────────────────────── web_fetch tool ─────────────────────────────

describe("web_fetch tool", () => {
  test("asks under `ask` (kind fetch), refuses private addresses by default, truncates long pages", async () => {
    const web = Bun.serve({
      port: 0,
      fetch: () => new Response(`<html><body><h1>Title</h1><p>${"word ".repeat(10_000)}</p></body></html>`, { headers: { "content-type": "text/html" } }),
    })
    servers.push({ stop: () => web.stop(true) })
    const fake = llm([{ toolCalls: [{ name: "web_fetch", args: { url: `http://127.0.0.1:${web.port}/` } }] }, { text: "ok" }])
    const h = await start(fake, { cwd: tempWorkspace(), approval: "ask" })
    try {
      await h.session.prompt({ text: "fetch" })
      await h.waitTurn(10_000)
      const req = h.ofType("permission.requested")
      expect(req).toHaveLength(1)
      expect(req[0]?.data).toMatchObject({ kind: "fetch", detail: `http://127.0.0.1:${web.port}/` })
      const result = contentText(fake.requests[1]?.body.messages.at(-1)?.content)
      expect(result).toContain("Refused")
      expect(result).toContain("private or loopback")
    } finally {
      await h.close()
    }

    const fake2 = llm([{ toolCalls: [{ name: "web_fetch", args: { url: `http://127.0.0.1:${web.port}/` } }] }, { text: "ok" }])
    const h2 = await start(fake2, { cwd: tempWorkspace(), approval: "auto", options: { allowPrivateFetch: true } })
    try {
      await h2.session.prompt({ text: "fetch" })
      await h2.waitTurn(10_000)
      expect(h2.ofType("permission.requested")).toHaveLength(0)
      const result = contentText(fake2.requests[1]?.body.messages.at(-1)?.content)
      expect(result).toContain("# Title")
      expect(result).toContain("[truncated: showing 20000 of")
      expect(result.length).toBeLessThan(20_500)
    } finally {
      await h2.close()
    }
  })
})

// ───────────────────────────── images ─────────────────────────────

/** A valid 1×1 PNG. */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")

describe("images via read_file", () => {
  test("OpenAI-compatible with vision: the image follows as a user message part", async () => {
    const cwd = tempWorkspace()
    writeFileSync(join(cwd, "shot.png"), PNG)
    const fake = llm([{ toolCalls: [{ name: "read_file", args: { path: "shot.png" } }] }, { text: "a pixel" }])
    const h = await start(fake, { cwd, approval: "yolo", options: { vision: true } })
    try {
      await h.session.prompt({ text: "what is in shot.png?" })
      await h.waitTurn(10_000)
      const msgs = fake.requests[1]?.body.messages ?? []
      expect(contentText(msgs.at(-2)?.content)).toContain("Image shot.png (image/png")
      const parts = msgs.at(-1)?.content as { type: string; image_url?: { url: string } }[]
      expect(msgs.at(-1)?.role).toBe("user")
      expect(parts.find((p) => p.type === "image_url")?.image_url?.url).toBe(`data:image/png;base64,${PNG.toString("base64")}`)
    } finally {
      await h.close()
    }
  })

  test("without vision: a text note instead of the image", async () => {
    const cwd = tempWorkspace()
    writeFileSync(join(cwd, "shot.png"), PNG)
    const fake = llm([{ toolCalls: [{ name: "read_file", args: { path: "shot.png" } }] }, { text: "ok" }])
    const h = await start(fake, { cwd, approval: "yolo", model: "my-local-model" })
    try {
      await h.session.prompt({ text: "look" })
      await h.waitTurn(10_000)
      const msgs = fake.requests[1]?.body.messages ?? []
      expect(contentText(msgs.at(-1)?.content)).toContain("This model cannot view images")
      expect(JSON.stringify(msgs)).not.toContain("image_url")
    } finally {
      await h.close()
    }
  })

  test("Anthropic: the image is part of the tool result; oversized images are refused", async () => {
    const cwd = tempWorkspace()
    writeFileSync(join(cwd, "shot.png"), PNG)
    writeFileSync(join(cwd, "huge.png"), Buffer.concat([PNG, Buffer.alloc(6 * 1024 * 1024)]))
    const fake = anthropic([
      {
        toolCalls: [
          { name: "read_file", args: { path: "shot.png" } },
          { name: "read_file", args: { path: "huge.png" } },
        ],
      },
      { text: "a pixel" },
    ])
    const h = await startHarness(nativeAdapter, {
      cwd,
      approval: "yolo",
      model: "claude-sonnet-4-5",
      provider: { id: "anthropic", kind: "anthropic", baseUrl: fake.baseUrl, apiKey: "k" },
    })
    try {
      await h.session.prompt({ text: "look" })
      await h.waitTurn(10_000)
      const last = fake.requests[1]?.body.messages.at(-1)?.content as { type: string; content?: { type: string; source?: { media_type?: string } }[] }[]
      const [img, huge] = last.filter((b) => b.type === "tool_result")
      expect(img?.content?.find((c) => c.type === "image")?.source?.media_type).toBe("image/png")
      expect(JSON.stringify(huge)).toContain("too large to show")
    } finally {
      await h.close()
    }
  })
})
