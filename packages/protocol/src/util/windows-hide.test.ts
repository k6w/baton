import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Glob } from "bun"

// On Windows the daemon runs without a console, so a child started without windowsHide flashes a
// console window open and shut (dozens per session). Every spawn in shipped code must hide it;
// only commands that take over your terminal (stdin: "inherit") are exempt.
test("every Bun.spawn / spawnSync in shipped code sets windowsHide", () => {
  const root = join(import.meta.dir, "..", "..", "..")
  const missing: string[] = []
  for (const file of new Glob("**/src/**/*.{ts,tsx}").scanSync({ cwd: root })) {
    if (file.includes("node_modules") || file.includes(".test.") || file.includes("fixtures")) continue
    const src = readFileSync(join(root, file), "utf8")
    for (const m of src.matchAll(/Bun\.spawn(?:Sync)?\(/g)) {
      let depth = 0
      let end = (m.index ?? 0) + m[0].length - 1
      for (; end < src.length; end++) {
        const ch = src[end]
        if (ch === "(" || ch === "[" || ch === "{") depth++
        else if (ch === ")" || ch === "]" || ch === "}") if (--depth === 0) break
      }
      const call = src.slice(m.index, end + 1)
      if (call.includes("windowsHide") || call.includes("...run.opts") || call.includes('stdin: "inherit"')) continue
      missing.push(`${file}:${src.slice(0, m.index).split("\n").length}`)
    }
  }
  expect(missing).toEqual([])
})
