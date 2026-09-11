import { describe, expect, test } from "bun:test"
import { contractSuite, LIVE, startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import { opencodeAdapter } from "./index.ts"

/** Cheap model that reports cost; override with BATON_OPENCODE_MODEL. */
const MODEL = process.env.BATON_OPENCODE_MODEL ?? "deepinfra/deepseek-ai/DeepSeek-V4-Flash"
const live = LIVE ? test : test.skip

describe("opencode adapter contract", () => {
  contractSuite(opencodeAdapter, { test, expect }, { model: MODEL })

  test("capabilities", () => {
    const c = opencodeAdapter.capabilities()
    expect(c).toMatchObject({ steer: false, interrupt: true, resume: true, permissions: true, mcp: true, diff: true, cost: true })
  })

  live(
    "live: interrupt mid-turn, then resume the same session",
    async () => {
      const cwd = tempWorkspace({ "README.md": "# hi\n" })
      const h = await startHarness(opencodeAdapter, { cwd, model: MODEL })
      let sessionId: string | undefined
      try {
        sessionId = h.session.resumeId()
        expect(sessionId).toStartWith("ses_")
        await h.session.prompt({ text: "Count from 1 to 300, one number per line. Do not use tools." })
        await h.waitFor("message.delta", undefined, 120_000)
        await h.session.interrupt()
        await h.waitFor("turn.interrupted", undefined, 30_000)
      } finally {
        await h.close()
      }
      const h2 = await startHarness(opencodeAdapter, { cwd, model: MODEL, resumeId: sessionId })
      try {
        expect(h2.session.resumeId()).toBe(sessionId)
        await h2.session.prompt({ text: "Reply with exactly the word RESUMED and nothing else." })
        await h2.waitTurn(120_000)
        const text = h2
          .ofType("message.delta")
          .map((e) => e.data.text)
          .join("")
        expect(text).toContain("RESUMED")
        expect(h2.ofType("usage.updated").some((u) => (u.data.costUsd ?? 0) > 0)).toBe(true)
      } finally {
        await h2.close()
      }
    },
    300_000,
  )
})
