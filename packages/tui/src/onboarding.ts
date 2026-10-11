/**
 * Onboarding state + starter-task suggestions derived from the repository.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import { stateDir } from "@batonsh/kernel"

interface Onboarding {
  welcomed?: boolean
  /** Guide lessons already opened (ids). */
  lessons?: string[]
}

function file(): string {
  return join(stateDir(), "onboarding.json")
}

export function loadOnboarding(): Onboarding {
  try {
    return JSON.parse(readFileSync(file(), "utf8")) as Onboarding
  } catch {
    return {}
  }
}

export function saveOnboarding(o: Onboarding): void {
  try {
    mkdirSync(stateDir(), { recursive: true })
    writeFileSync(file(), JSON.stringify(o, null, 2))
  } catch {}
}

const SOURCE = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".py",
  ".go",
  ".rs",
  ".rb",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".cs",
  ".php",
  ".ex",
  ".vue",
  ".svelte",
])

function isTest(p: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(p) || /[._-](test|spec)\.[a-z]+$/.test(p) || /_test\.go$/.test(p) || /(^|\/)test_[^/]+\.py$/.test(p)
}

/** Three concrete first tasks for this repo (falls back to generic ones). */
export function suggestTasks(root: string): string[] {
  const out: string[] = []
  let files: string[] = []
  try {
    const r = Bun.spawnSync(["git", "ls-files"], { windowsHide: true, cwd: root, stdout: "pipe", stderr: "ignore" })
    if (r.exitCode === 0) files = r.stdout.toString().split("\n").filter(Boolean).slice(0, 5000)
  } catch {}
  const src = files.filter((f) => SOURCE.has(extname(f)) && !isTest(f) && !f.includes("node_modules/") && !f.startsWith("."))
  const tested = new Set(
    files.filter(isTest).map((f) =>
      basename(f)
        .replace(/[._-](test|spec)(?=\.)/, "")
        .replace(/^test_/, "")
        .replace(/_test(?=\.go$)/, ""),
    ),
  )
  const untested = src
    .filter((f) => !tested.has(basename(f)))
    .map((f) => ({ f, size: safeSize(join(root, f)) }))
    .filter((x) => x.size > 400)
    .sort((a, b) => b.size - a.size)
  if (untested[0]) out.push(`Add focused tests for ${untested[0].f} and make sure they pass`)
  // TODO / FIXME hotspot
  let todoFile = ""
  let todoCount = 0
  for (const f of src.slice(0, 400)) {
    try {
      const n = (readFileSync(join(root, f), "utf8").match(/\b(TODO|FIXME|XXX)\b/g) ?? []).length
      if (n > todoCount) {
        todoCount = n
        todoFile = f
      }
    } catch {}
  }
  if (todoCount > 0) out.push(`Resolve the ${todoCount} TODO/FIXME comment${todoCount === 1 ? "" : "s"} in ${todoFile}`)
  if (!files.some((f) => /^readme(\.|$)/i.test(f))) out.push("Write a README: what this project does, how to run it, how to test it")
  else if (src.length > 0)
    out.push(`Review ${src.length > 20 ? "the codebase" : "this project"} for bugs and risky code; have a second agent from another vendor verify each finding`)
  const generic = [
    "Find the slowest test or build step and make it faster",
    "Add input validation and clear error messages to the main entry point",
    "Set up linting and formatting, then fix what it reports",
  ]
  for (const g of generic) if (out.length < 3) out.push(g)
  return out.slice(0, 3)
}

function safeSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

export function hasProjectConfig(root: string): boolean {
  return existsSync(join(root, ".baton", "config.toml"))
}
