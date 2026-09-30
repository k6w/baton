import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent, SessionConfig } from "@batonsh/protocol"
import { tempWorkspace } from "../../testkit/src/index.ts"
import { CodexSession } from "./session.ts"
import { GitSnapshotter, parseHunks } from "./snapshot.ts"
import { CodexTranslator } from "./translator.ts"

const FAKE = join(import.meta.dir, "fixtures", "fake-app-server.ts")

function fakeBin(mode: string): string {
  const dir = tempWorkspace()
  const bin = join(dir, "fake-codex")
  writeFileSync(bin, `#!/bin/sh\nFAKE_MODE=${mode} exec "${process.execPath}" "${FAKE}"\n`)
  chmodSync(bin, 0o755)
  return bin
}

function make(mode: string) {
  const events: AgentEvent[] = []
  const ac = new AbortController()
  const ctx = { emit: (e: AgentEvent) => events.push(e), log: () => {}, signal: ac.signal }
  const cfg = { agentId: "a", name: "a", cwd: tempWorkspace(), mcpServers: [], approval: "auto", options: { shellDiffs: false } } as unknown as SessionConfig
  const s = new CodexSession(cfg, ctx as never, { bin: fakeBin(mode) })
  const types = () => events.map((e) => (e.type === "agent.status" ? `status:${e.data.status}` : e.type))
  return { s, events, types }
}

const until = async (cond: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await Bun.sleep(10)
}

describe("codex session lifecycle (fake app-server)", () => {
  test("crash mid-turn: turn.completed(error) precedes agent.exited, no ready after exit, prompt/steer/close fail fast", async () => {
    const { s, events, types } = make("crash-mid-turn")
    await s.start()
    await s.prompt({ text: "hi" })
    await until(() => types().includes("agent.exited"))
    const t = types()
    const completed = events.find((e) => e.type === "turn.completed")
    expect(completed?.data).toMatchObject({ stopReason: "error" })
    expect(t.indexOf("turn.completed")).toBeLessThan(t.indexOf("agent.exited"))
    expect(t.slice(t.indexOf("agent.exited"))).not.toContain("status:ready")
    expect(t.filter((x) => x === "agent.exited")).toHaveLength(1)

    let t0 = Date.now()
    await expect(s.prompt({ text: "again" })).rejects.toThrow(/exited/)
    await expect(s.steer({ text: "again" })).rejects.toThrow(/exited/)
    expect(Date.now() - t0).toBeLessThan(500)
    t0 = Date.now()
    await s.close()
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(types().filter((x) => x === "agent.exited")).toHaveLength(1)
  })

  test("crash during turn/start: prompt rejects and status does not return to ready", async () => {
    const { s, types } = make("crash-on-turn")
    await s.start()
    await expect(s.prompt({ text: "hi" })).rejects.toThrow()
    await until(() => types().includes("status:exited"))
    const t = types()
    expect(t.slice(t.indexOf("agent.exited"))).not.toContain("status:ready")
    await s.close()
  })

  test("close() is bounded when the app-server ignores turn/interrupt", async () => {
    const { s, types } = make("hang-interrupt")
    await s.start()
    await s.prompt({ text: "hi" })
    await until(() => types().includes("turn.started"))
    const t0 = Date.now()
    await s.close()
    expect(Date.now() - t0).toBeLessThan(6_000)
    expect(types().filter((x) => x === "agent.exited")).toHaveLength(1)
  }, 10_000)

  test("prompt queued after an interrupt of an in-flight turn/start still runs", async () => {
    const { s, events } = make("slow-start")
    await s.start()
    const a = s.prompt({ text: "A" })
    await Bun.sleep(50)
    await s.interrupt()
    await s.prompt({ text: "B" })
    await a
    await until(() => events.filter((e) => e.type === "turn.started").length === 2)
    const started = events.filter((e) => e.type === "turn.started").map((e) => (e.data as { prompt?: string }).prompt)
    expect(started).toEqual(["A", "B"])
    await s.close()
  })

  test("child-thread notifications do not end the parent turn", async () => {
    const { s, events } = make("child-thread")
    await s.start()
    await s.prompt({ text: "hi" })
    await until(() => events.some((e) => e.type === "turn.completed"))
    await Bun.sleep(50)
    expect(events.filter((e) => e.type === "turn.started").map((e) => (e.data as { turnId: string }).turnId)).toEqual(["t1"])
    expect(events.filter((e) => e.type === "turn.completed").map((e) => (e.data as { turnId: string }).turnId)).toEqual(["t1"])
    expect(events.filter((e) => e.type === "agent.session")).toHaveLength(1)
    await s.close()
  })
})

describe("codex translator", () => {
  const usage = (total: number[], last: number[]) => {
    const b = ([inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens]: number[]) => ({
      totalTokens: 0,
      inputTokens,
      cachedInputTokens,
      cacheWriteInputTokens: 0,
      outputTokens,
      reasoningOutputTokens,
    })
    return { threadId: "thr", turnId: "t1", tokenUsage: { total: b(total), last: b(last), modelContextWindow: null } }
  }
  const turn = (id: string, status: string) => ({ threadId: "thr", turn: { id, status, items: [], error: null } })
  const usages = (events: AgentEvent[]) =>
    events.filter((e) => e.type === "usage.updated").map((e) => (e as Extract<AgentEvent, { type: "usage.updated" }>).data)

  test("resumed thread: totals replayed before our first turn are an offset", () => {
    const events: AgentEvent[] = []
    const t = new CodexTranslator((e) => events.push(e))
    t.setThread("thr")
    t.notification("thread/tokenUsage/updated", usage([1000, 400, 100, 10], [50, 0, 5, 0]))
    expect(usages(events)).toEqual([])
    t.notification("turn/started", turn("t1", "inProgress"))
    t.notification("thread/tokenUsage/updated", usage([1200, 500, 130, 15], [200, 100, 30, 5]))
    expect(usages(events)).toEqual([{ input: 100, cachedInput: 100, output: 30, reasoning: 5, source: "reported", mode: "cumulative" }])
  })

  test("resumed thread without a replayed total: offset is total minus last", () => {
    const events: AgentEvent[] = []
    const t = new CodexTranslator((e) => events.push(e))
    t.setThread("thr")
    t.notification("turn/started", turn("t1", "inProgress"))
    t.notification("thread/tokenUsage/updated", usage([1200, 500, 130, 15], [200, 100, 30, 5]))
    t.notification("thread/tokenUsage/updated", usage([1300, 500, 140, 15], [100, 0, 10, 0]))
    expect(usages(events).map((u) => [u.input, u.cachedInput, u.output, u.reasoning])).toEqual([
      [100, 100, 30, 5],
      [200, 100, 40, 5],
    ])
  })

  test("fresh thread usage is unchanged", () => {
    const events: AgentEvent[] = []
    const t = new CodexTranslator((e) => events.push(e))
    t.setThread("thr")
    t.notification("turn/started", turn("t1", "inProgress"))
    t.notification("thread/tokenUsage/updated", usage([200, 100, 30, 5], [200, 100, 30, 5]))
    expect(usages(events).map((u) => [u.input, u.cachedInput, u.output])).toEqual([[100, 100, 30]])
  })

  test("notifications for other threads are ignored", () => {
    const events: AgentEvent[] = []
    const t = new CodexTranslator((e) => events.push(e))
    t.setThread("thr")
    t.notification("turn/started", turn("t1", "inProgress"))
    t.notification("thread/started", { thread: { id: "child" } })
    t.notification("turn/started", { threadId: "child", turn: { id: "c1", status: "inProgress", items: [], error: null } })
    t.notification("turn/completed", { threadId: "child", turn: { id: "c1", status: "completed", items: [], error: null } })
    expect(t.activeTurnId).toBe("t1")
    expect(t.threadId).toBe("thr")
    expect(events.filter((e) => e.type.startsWith("turn.")).map((e) => e.type)).toEqual(["turn.started"])
  })
})

describe("git snapshot paths", () => {
  test("paths with spaces, ' b/' and quotes, and content lines that look like headers", async () => {
    const cwd = tempWorkspace({ "s.sql": "-- old comment\nselect 1;\n" })
    const s = new GitSnapshotter(cwd)
    try {
      const before = await s.snapshot()
      mkdirSync(join(cwd, "x b"))
      writeFileSync(join(cwd, "x b", "y.txt"), "b\n")
      writeFileSync(join(cwd, 'q"uote.txt'), "q\n")
      writeFileSync(join(cwd, "s.sql"), "++ new comment\nselect 1;\n")
      const after = await s.snapshot()
      const files = await s.diff(before as string, after as string)
      const byPath = Object.fromEntries(files.map((f) => [f.path, f]))
      expect(Object.keys(byPath).sort()).toEqual([join(cwd, 'q"uote.txt'), join(cwd, "s.sql"), join(cwd, "x b/y.txt")].sort())
      expect(byPath[join(cwd, "x b/y.txt")]).toMatchObject({ created: true, added: 1, removed: 0 })
      expect(byPath[join(cwd, 'q"uote.txt')]).toMatchObject({ created: true, added: 1 })
      expect(byPath[join(cwd, "s.sql")]?.lines).toEqual([
        { kind: "del", text: "-- old comment", oldLine: 1 },
        { kind: "add", text: "++ new comment", newLine: 1 },
        { kind: "ctx", text: "select 1;", oldLine: 2, newLine: 2 },
      ])
    } finally {
      s.dispose()
    }
  })

  test("parseHunks counts lines instead of trusting ---/+++ prefixes", () => {
    const patch = "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n--- x\n+++ y\n z\n"
    expect(parseHunks(patch)).toEqual([
      { kind: "del", text: "-- x", oldLine: 1 },
      { kind: "add", text: "++ y", newLine: 1 },
      { kind: "ctx", text: "z", oldLine: 2, newLine: 2 },
    ])
  })
})
