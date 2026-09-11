import { describe, expect, test } from "bun:test"
import { contractSuite, LIVE, startHarness, tempWorkspace } from "../../testkit/src/index.ts"
import codexDefault, { codexAdapter } from "./index.ts"

describe("codex adapter", () => {
  test("exports and capabilities", () => {
    expect(codexDefault).toBe(codexAdapter)
    expect(codexAdapter.id).toBe("codex")
    expect(codexAdapter.family).toBe("codex")
    const caps = codexAdapter.capabilities()
    expect(caps).toMatchObject({
      steer: true,
      interrupt: true,
      resume: true,
      fork: true,
      diff: true,
      usage: true,
      cost: false,
      permissions: true,
      mcp: true,
    })
    expect(Array.isArray(caps.models)).toBe(true)
  })

  test("start() fails cleanly for a missing binary", async () => {
    await expect(startHarness(codexAdapter, { cwd: tempWorkspace(), command: "/nonexistent/codex" })).rejects.toThrow(/not found/)
  })

  ;(LIVE ? test : test.skip)(
    "live: detect reports an installed, authenticated codex",
    async () => {
      const d = await codexAdapter.detect()
      expect(d.installed).toBe(true)
      expect(d.version).toMatch(/^\d+\.\d+\.\d+/)
      expect(d.protocols).toContain("app-server")
    },
    30_000,
  )
})

describe("codex contract", () => {
  contractSuite(codexAdapter, { test, expect })
})
