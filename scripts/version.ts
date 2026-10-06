/**
 * Bump Baton's version everywhere it is written down, and date the changelog.
 *   bun scripts/version.ts 0.2.0          # set it
 *   bun scripts/version.ts --check        # fail if the copies disagree (CI)
 */
import { readFileSync, writeFileSync } from "node:fs"
import { Glob } from "bun"

const SOURCE = "packages/protocol/src/version.ts"
const current = /BATON_VERSION = "([^"]+)"/.exec(readFileSync(SOURCE, "utf8"))?.[1]
if (!current) throw new Error(`no BATON_VERSION in ${SOURCE}`)

const packageJsons = ["packages/*/package.json", "packages/adapters/*/package.json"].flatMap((g) => [...new Glob(g).scanSync(".")]).sort()
const copies: { file: string; re: RegExp; fmt: (v: string) => string }[] = [
  { file: SOURCE, re: /BATON_VERSION = "[^"]+"/, fmt: (v) => `BATON_VERSION = "${v}"` },
  ...packageJsons.map((file) => ({ file, re: /"version": "[^"]+"/, fmt: (v: string) => `"version": "${v}"` })),
  { file: "sdk-python/pyproject.toml", re: /^version = "[^"]+"/m, fmt: (v) => `version = "${v}"` },
  { file: "sdk-python/baton/__init__.py", re: /__version__ = "[^"]+"/, fmt: (v) => `__version__ = "${v}"` },
]

if (process.argv.includes("--check")) {
  const bad = copies.filter((c) => {
    const m = c.re.exec(readFileSync(c.file, "utf8"))
    return !m || m[0] !== c.fmt(current)
  })
  const tag = process.env.GITHUB_REF_NAME
  if (tag?.startsWith("v") && tag.slice(1) !== current) {
    console.error(`tag ${tag} does not match BATON_VERSION ${current}`)
    process.exit(1)
  }
  if (bad.length) {
    console.error(`version ${current} is not written in: ${bad.map((c) => c.file).join(", ")} — run bun scripts/version.ts ${current}`)
    process.exit(1)
  }
  console.log(`version ${current} ✓ (${copies.length} files)`)
  process.exit(0)
}

const next = process.argv[2]
if (!next || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(next)) {
  console.error(`usage: bun scripts/version.ts <x.y.z> | --check   (current: ${current})`)
  process.exit(2)
}
for (const c of copies) {
  const s = readFileSync(c.file, "utf8")
  if (!c.re.test(s)) throw new Error(`no version in ${c.file}`)
  writeFileSync(c.file, s.replace(c.re, c.fmt(next)))
}
// "## Unreleased" becomes this release; a fresh Unreleased section goes on top
const log = readFileSync("CHANGELOG.md", "utf8")
const date = new Date().toISOString().slice(0, 10)
if (log.includes("## Unreleased")) writeFileSync("CHANGELOG.md", log.replace("## Unreleased", `## Unreleased\n\n## ${next} — ${date}`))
console.log(`${current} → ${next} (${copies.length} files, CHANGELOG.md)\nnext: git commit -am "v${next}" && git tag v${next} && git push --follow-tags`)
