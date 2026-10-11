import { describe, expect, test } from "bun:test"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent, SessionConfig } from "@batonsh/protocol"
import { contractSuite, LIVE, startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import { claudeAdapter } from "./index.ts"

describe("claude adapter contract", () => {
  contractSuite(claudeAdapter, { test, expect }, { model: "haiku" })
})

describe("claude adapter", () => {
  test("capabilities", () => {
    expect(claudeAdapter.capabilities()).toMatchObject({ steer: true, interrupt: true, permissions: true, mcp: true, models: ["sonnet", "opus", "haiku"] })
  })

  const live = LIVE ? test : test.skip
  live(
    "live: permission request round-trip and resume id",
    async () => {
      const cwd = tempWorkspace({ "a.txt": "one\n" })
      const h = await startHarness(claudeAdapter, { cwd, model: "haiku", approval: "ask" })
      try {
        await h.session.prompt({ text: "Run the shell command `echo baton-ok` with the Bash tool, then reply DONE." })
        await h.waitTurn()
        expect(h.ofType("permission.requested").length).toBeGreaterThan(0)
        expect(h.ofType("permission.resolved")[0]?.data.by).toBe("user")
        const bash = h.ofType("tool.update").find((e) => e.data.summary === "baton-ok")
        expect(bash?.data.status).toBe("completed")
        expect(h.session.resumeId()).toBeTruthy()
        expect(h.ofType("usage.updated").at(-1)?.data.costUsd).toBeGreaterThan(0)
      } finally {
        await h.close()
      }
    },
    240_000,
  )
})

/** The stream-json fake CLI speaks Claude Code's stdio protocol; wrap it as an executable. */
function fakeClaude(): string {
  const dir = tempWorkspace()
  const bin = join(dir, "fake-claude")
  const fake = join(import.meta.dir, "../../stream-json/src/fixtures/fake-cli.ts")
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`)
  chmodSync(bin, 0o755)
  return bin
}

describe("claude adapter lifecycle (fake CLI)", () => {
  // skipped on Windows: the fake CLI is a shell script
  test.skipIf(process.platform === "win32")(
    "CLI crash mid-turn fails the turn before agent.exited; later prompts reject",
    async () => {
      const h = await startHarness(claudeAdapter, { cwd: tempWorkspace(), approval: "ask", command: fakeClaude(), env: { FAKE_DIALECT: "claude" } })
      try {
        await h.session.prompt({ text: "crash now" })
        await h.waitFor("agent.exited", undefined, 10_000)
        const types = h.events.map((e) => e.type)
        expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("error")
        expect(h.ofType("turn.interrupted")).toHaveLength(0)
        expect(types.indexOf("turn.completed")).toBeLessThan(types.indexOf("agent.exited"))
        expect(h.ofType("agent.exited")).toHaveLength(1)
        const started = h.ofType("turn.started").length
        await expect(h.session.prompt({ text: "again" })).rejects.toThrow("not running")
        await expect(h.session.steer?.({ text: "again" })).rejects.toThrow("not running")
        expect(h.ofType("turn.started")).toHaveLength(started)
        expect(h.ofType("agent.status").at(-1)?.data.status).toBe("exited")
        const t = Date.now()
        await h.session.close()
        expect(Date.now() - t).toBeLessThan(1_000)
      } finally {
        await h.close()
      }
    },
    20_000,
  )

  test("CLI dying during initialize fails start() without ready/exit events", async () => {
    const events: AgentEvent[] = []
    const cfg = {
      agentId: "a",
      name: "a",
      cwd: tempWorkspace(),
      mcpServers: [],
      approval: "ask",
      command: fakeClaude(),
      env: { FAKE_DIALECT: "claude", FAKE_EXIT_ON_START: "3" },
    }
    const t = Date.now()
    await expect(
      claudeAdapter.start(cfg as unknown as SessionConfig, { emit: (e) => events.push(e), log: () => {}, signal: new AbortController().signal }),
    ).rejects.toThrow("failed to start")
    expect(Date.now() - t).toBeLessThan(10_000)
    const statuses = events.flatMap((e) => (e.type === "agent.status" ? [e.data.status] : []))
    expect(statuses).not.toContain("ready")
    expect(events.filter((e) => e.type === "agent.exited")).toHaveLength(0)
  }, 20_000)

  // skipped on Windows: the fake CLI is a shell script
  test.skipIf(process.platform === "win32")(
    "a normal turn still completes and reports ready",
    async () => {
      const h = await startHarness(claudeAdapter, { cwd: tempWorkspace(), approval: "ask", command: fakeClaude(), env: { FAKE_DIALECT: "claude" } })
      try {
        await h.session.prompt({ text: "ping" })
        await h.waitTurn(10_000)
        expect(h.ofType("turn.completed")[0]?.data.stopReason).toBe("end_turn")
      } finally {
        await h.close()
      }
    },
    20_000,
  )
})
