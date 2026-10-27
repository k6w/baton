/**
 * Releases: how this install is updated, how versions compare, and a once-a-day check for a
 * newer release. The daemon does the check (it fetches anyway); the CLI only reads its result,
 * so starting Baton never waits on the network.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { BATON_VERSION } from "@batonsh/protocol"
import { stateDir } from "./config.ts"

export const REPO = process.env.BATON_REPO ?? "k6w/baton"

export type InstallKind = "binary" | "npm" | "homebrew" | "source"

export function installKind(env: Record<string, string | undefined> = process.env, execPath = process.execPath): InstallKind {
  if (env.BATON_INSTALL === "npm" || /[/\\]node_modules[/\\]batonsh-/.test(execPath)) return "npm"
  if (/\/(Cellar|homebrew|linuxbrew)\//i.test(execPath)) return "homebrew"
  // BATON_TARGET is defined at build time (scripts/build.ts): unset means `bun packages/cli/src/main.ts`
  if (!process.env.BATON_TARGET) return "source"
  return "binary"
}

/** The command that updates this install. */
export function updateCommand(kind: InstallKind = installKind()): string {
  return {
    npm: "npm install -g batonsh@latest",
    homebrew: "brew upgrade baton",
    source: "git pull && bun install",
    binary: "baton update",
  }[kind]
}

/** 1.2.10 > 1.2.9; a prerelease sorts before its release. */
export function newer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const [core = "", pre] = v.replace(/^v/, "").split("-", 2)
    return { nums: core.split(".").map((n) => Number(n) || 0), pre }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < 3; i++) if ((x.nums[i] ?? 0) !== (y.nums[i] ?? 0)) return (x.nums[i] ?? 0) > (y.nums[i] ?? 0)
  if (x.pre === y.pre) return false
  if (!x.pre) return true
  if (!y.pre) return false
  return x.pre > y.pre
}

export async function latestVersion(timeoutMs = 10_000): Promise<string> {
  // releases/latest redirects to .../tag/vX.Y.Z: no API call, so no API rate limit
  try {
    const r = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) })
    const tag = /\/tag\/v?([^/?#]+)$/.exec(r.headers.get("location") ?? "")?.[1]
    if (tag) return tag
  } catch {}
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "baton-update" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`GitHub: ${res.status} looking up the latest release of ${REPO}`)
  const j = (await res.json()) as { tag_name?: string }
  if (!j.tag_name) throw new Error("GitHub: the latest release has no tag")
  return j.tag_name.replace(/^v/, "")
}

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
const checkFile = () => join(stateDir(), "update-check.json")

/** Off from a checkout, offline, or with BATON_NO_UPDATE_CHECK=1. */
export function updateChecksOff(env: Record<string, string | undefined> = process.env): boolean {
  return env.BATON_NO_UPDATE_CHECK === "1" || env.BATON_OFFLINE === "1" || installKind(env) === "source"
}

function readCheck(): { checkedAt: number; latest: string } | undefined {
  try {
    const j = JSON.parse(readFileSync(checkFile(), "utf8")) as { checkedAt?: unknown; latest?: unknown }
    return typeof j.checkedAt === "number" && typeof j.latest === "string" ? { checkedAt: j.checkedAt, latest: j.latest } : undefined
  } catch {
    return undefined
  }
}

/** A newer release the last check found (no network), if any. */
export function knownUpdate(current = BATON_VERSION): string | undefined {
  if (updateChecksOff()) return undefined
  const c = readCheck()
  return c && newer(c.latest, current) ? c.latest : undefined
}

/** Look for a newer release, at most once a day (otherwise the last answer). */
export async function checkForUpdate(current = BATON_VERSION): Promise<string | undefined> {
  if (updateChecksOff()) return undefined
  const last = readCheck()
  let latest = last?.latest
  if (!last || Date.now() - last.checkedAt > CHECK_EVERY_MS) {
    try {
      latest = await latestVersion()
      mkdirSync(dirname(checkFile()), { recursive: true })
      writeFileSync(checkFile(), JSON.stringify({ checkedAt: Date.now(), latest }))
    } catch {
      return undefined
    }
  }
  return latest && newer(latest, current) ? latest : undefined
}
