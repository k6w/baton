import { describe, expect, test } from "bun:test"
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
