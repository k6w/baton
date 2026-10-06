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
  expect(installKind({}, "/usr/lib/node_modules/@batonsh/cli-linux-x64/bin/baton")).toBe("npm")
  expect(installKind({}, "/opt/homebrew/Cellar/baton/0.1.0/bin/baton")).toBe("homebrew")
  // tests run from source (no BATON_TARGET baked in)
  expect(installKind({}, "/Users/me/.bun/bin/bun")).toBe("source")
})
