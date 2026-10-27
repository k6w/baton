import { expect, test } from "bun:test"
import { installKind, newer } from "./update.ts"

test("version ordering", () => {
  expect(newer("0.2.0", "0.1.9")).toBe(true)
  expect(newer("0.1.10", "0.1.9")).toBe(true)
  expect(newer("0.1.0", "0.1.0")).toBe(false)
  expect(newer("v1.0.0", "0.9.9")).toBe(true)
  expect(newer("1.0.0", "1.0.0-rc.1")).toBe(true)
  expect(newer("1.0.0-rc.1", "1.0.0")).toBe(false)
  expect(newer("1.0.0-rc.2", "1.0.0-rc.1")).toBe(true)
})

test("install kind", () => {
  expect(installKind({ BATON_INSTALL: "npm" }, "/x/baton")).toBe("npm")
  expect(installKind({}, "/usr/lib/node_modules/batonsh-linux-x64/bin/baton")).toBe("npm")
  expect(installKind({}, "/opt/homebrew/Cellar/baton/0.1.0/bin/baton")).toBe("homebrew")
  // tests run from source (no BATON_TARGET baked in)
  expect(installKind({}, "/Users/me/.bun/bin/bun")).toBe("source")
})

test("update check: the daemon's daily answer is read without the network", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { checkForUpdate, knownUpdate } = await import("@batonsh/kernel")
  const saved = { state: process.env.BATON_STATE_DIR, target: process.env.BATON_TARGET, off: process.env.BATON_NO_UPDATE_CHECK }
  const dir = mkdtempSync(join(tmpdir(), "baton-upd-"))
  process.env.BATON_STATE_DIR = dir
  process.env.BATON_TARGET = "test" // a built binary (from source, checks are off)
  delete process.env.BATON_NO_UPDATE_CHECK
  try {
    const answer = (latest: string) => writeFileSync(join(dir, "update-check.json"), JSON.stringify({ checkedAt: Date.now(), latest }))
    expect(knownUpdate("0.3.7")).toBeUndefined()
    answer("99.0.0")
    expect(knownUpdate("0.3.7")).toBe("99.0.0")
    // checked today: no new lookup
    expect(await checkForUpdate("0.3.7")).toBe("99.0.0")
    answer("0.3.7")
    expect(knownUpdate("0.3.7")).toBeUndefined()
    answer("99.0.0")
    process.env.BATON_NO_UPDATE_CHECK = "1"
    expect(knownUpdate("0.3.7")).toBeUndefined()
  } finally {
    for (const [k, v] of [
      ["BATON_STATE_DIR", saved.state],
      ["BATON_TARGET", saved.target],
      ["BATON_NO_UPDATE_CHECK", saved.off],
    ] as const)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
  }
})
