/**
 * Adapter testkit: drive an adapter session headlessly, collect events, and run the
 * shared contract suite. Live runs (real CLIs, real tokens) are gated behind BATON_LIVE=1.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentAdapter, AgentEvent, AgentSession, EventType, SessionConfig } from "@batonsh/protocol"
import { newId } from "@batonsh/protocol"

export interface Harness {
  session: AgentSession
  events: AgentEvent[]
  /** Resolves with the first event matching `pred` (including already-received ones). */
  waitFor<T extends EventType>(type: T, pred?: (e: Extract<AgentEvent, { type: T }>) => boolean, timeoutMs?: number): Promise<Extract<AgentEvent, { type: T }>>
  /** Wait until the agent completes a turn. */
  waitTurn(timeoutMs?: number): Promise<void>
  ofType<T extends EventType>(type: T): Extract<AgentEvent, { type: T }>[]
  close(): Promise<void>
  /** Auto-answer permission requests with this option kind (default: allow_once). */
  autoApprove: "allow_once" | "reject_once" | "off"
}

export function tempWorkspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "baton-test-"))
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c)
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
  return dir
}

export async function startHarness(adapter: AgentAdapter, cfg: Partial<SessionConfig> & { cwd: string }): Promise<Harness> {
  const events: AgentEvent[] = []
  const listeners = new Set<(e: AgentEvent) => void>()
  const ac = new AbortController()
  let session!: AgentSession
  const h: Harness = {
    events,
    autoApprove: "allow_once",
    get session() {
      return session
    },
    ofType: (type) => events.filter((e) => e.type === type) as never,
    waitFor(type, pred, timeoutMs = 120_000) {
      const match = (e: AgentEvent) => e.type === type && (!pred || pred(e as never))
      const existing = events.find(match)
      if (existing) return Promise.resolve(existing as never)
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          listeners.delete(l)
          reject(new Error(`timeout waiting for ${type}; got: ${events.map((e) => e.type).join(",")}`))
        }, timeoutMs)
        const l = (e: AgentEvent) => {
          if (match(e)) {
            clearTimeout(t)
            listeners.delete(l)
            resolve(e as never)
          }
        }
        listeners.add(l)
      })
    },
    async waitTurn(timeoutMs = 180_000) {
      const before = events.filter((e) => e.type === "turn.completed").length
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => {
          listeners.delete(l)
          reject(new Error(`timeout waiting for turn; got: ${events.map((e) => e.type).join(",")}`))
        }, timeoutMs)
        const l = () => {
          if (events.filter((e) => e.type === "turn.completed").length > before) {
            clearTimeout(t)
            listeners.delete(l)
            resolve()
          }
        }
        listeners.add(l)
      })
    },
    async close() {
      ac.abort()
      await session?.close()
    },
  }
  session = await adapter.start(
    {
      agentId: cfg.agentId ?? newId("ag"),
      name: cfg.name ?? `${adapter.id}-test`,
      mcpServers: [],
      approval: "ask",
      ...cfg,
    },
    {
      signal: ac.signal,
      log: (level, msg) => {
        if (process.env.BATON_TEST_DEBUG) console.error(`[${adapter.id}:${level}] ${msg}`)
      },
      emit: (e) => {
        events.push(e)
        if (process.env.BATON_TEST_DEBUG) console.error(`[${adapter.id}] ${e.type} ${JSON.stringify(e.data).slice(0, 200)}`)
        if (e.type === "permission.requested" && h.autoApprove !== "off") {
          const want = h.autoApprove
          const opt = e.data.options.find((o) => o.kind === want) ?? e.data.options[0]
          queueMicrotask(() => void session.respondPermission(e.data.requestId, opt?.optionId ?? null))
        }
        for (const l of [...listeners]) l(e)
      },
    },
  )
  return h
}

export const LIVE = process.env.BATON_LIVE === "1"

/**
 * Shared live contract scenarios. Call inside a `describe` in each adapter's test file:
 *   contractSuite(adapter, { test, expect, timeout })
 */
export function contractSuite(
  adapter: AgentAdapter,
  t: { test: typeof import("bun:test").test; expect: typeof import("bun:test").expect },
  opts: { model?: string; timeout?: number; skipEdit?: boolean } = {},
): void {
  const timeout = opts.timeout ?? 240_000
  const live = LIVE ? t.test : t.test.skip

  t.test("detect() returns a well-formed result", async () => {
    const d = await adapter.detect()
    t.expect(typeof d.installed).toBe("boolean")
    t.expect(["ok", "missing", "unknown"]).toContain(d.auth)
    t.expect(Array.isArray(d.protocols)).toBe(true)
  })

  live(
    "live: answers a prompt (turn lifecycle + assistant text)",
    async () => {
      const cwd = tempWorkspace({ "README.md": "# hello\n" })
      const h = await startHarness(adapter, { cwd, model: opts.model })
      try {
        await h.session.prompt({ text: "Reply with exactly the word PONG and nothing else. Do not use tools." })
        await h.waitTurn(timeout)
        t.expect(h.ofType("turn.started").length).toBeGreaterThan(0)
        const text = [...h.ofType("message.completed"), ...h.ofType("message.delta")]
          .filter((e) => e.data.role === "assistant")
          .map((e) => e.data.text)
          .join("")
        t.expect(text.toUpperCase()).toContain("PONG")
      } finally {
        await h.close()
      }
    },
    timeout,
  )

  if (!opts.skipEdit)
    live(
      "live: edits a file (tool.call edit + diff content)",
      async () => {
        const cwd = tempWorkspace({ "notes.txt": "teh quick brown fox\n" })
        const h = await startHarness(adapter, { cwd, model: opts.model, approval: "auto-edit" })
        try {
          await h.session.prompt({ text: "Fix the typo in notes.txt (teh -> the). Edit the file directly, no other changes." })
          await h.waitTurn(timeout)
          const content = await Bun.file(join(cwd, "notes.txt")).text()
          t.expect(content).toContain("the quick brown fox")
          const edits = h.ofType("tool.call").filter((e) => e.data.kind === "edit")
          t.expect(edits.length).toBeGreaterThan(0)
          const diffs = h.ofType("tool.update").flatMap((e) => e.data.content ?? []).filter((c) => c.type === "diff")
          t.expect(diffs.length).toBeGreaterThan(0)
        } finally {
          await h.close()
        }
      },
      timeout,
    )
}
