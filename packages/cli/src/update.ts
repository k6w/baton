/**
 * `baton update`: replace this binary with the latest release (verified against SHA256SUMS), or
 * say how to update when a package manager owns the install (npm, Homebrew) or it runs from source.
 */
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { BATON_VERSION } from "@batonsh/protocol"

export const REPO = process.env.BATON_REPO ?? "k6w/baton"

export type InstallKind = "binary" | "npm" | "homebrew" | "source"

export function installKind(env: Record<string, string | undefined> = process.env, execPath = process.execPath): InstallKind {
  if (env.BATON_INSTALL === "npm" || /[/\\]node_modules[/\\]batonsh-/.test(execPath)) return "npm"
  if (/\/(Cellar|homebrew|linuxbrew)\//i.test(execPath)) return "homebrew"
  // BATON_TARGET is defined at build time (scripts/build.ts): unset means `bun packages/cli/src/main.ts`
  if (!process.env.BATON_TARGET) return "source"
  return "binary"
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
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "baton-update" },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`GitHub: ${res.status} looking up the latest release of ${REPO}`)
  const j = (await res.json()) as { tag_name?: string }
  if (!j.tag_name) throw new Error("GitHub: the latest release has no tag")
  return j.tag_name.replace(/^v/, "")
}

/** Archive name of this build's platform. */
function archiveName(): string {
  const target = process.env.BATON_TARGET ?? `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
  return target.startsWith("windows") ? `baton-${target}.zip` : `baton-${target}.tar.gz`
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { "user-agent": "baton-update" }, signal: AbortSignal.timeout(300_000) })
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`)
  return new Uint8Array(await res.arrayBuffer())
}

export interface UpdateOptions {
  check?: boolean
  version?: string
  log?: (s: string) => void
}

/** Returns the version now installed (or available, with check). */
export async function update(opts: UpdateOptions = {}): Promise<{ from: string; to: string; updated: boolean; how?: string }> {
  const log = opts.log ?? console.log
  const kind = installKind()
  const target = opts.version?.replace(/^v/, "") ?? (await latestVersion())
  const from = BATON_VERSION
  if (!opts.version && !newer(target, from)) return { from, to: from, updated: false }
  const how = {
    npm: "npm install -g batonsh@latest   (or: bun add -g batonsh@latest)",
    homebrew: "brew upgrade baton",
    source: "git pull && bun install   (you're running Baton from a checkout)",
    binary: undefined,
  }[kind]
  if (opts.check || how) return { from, to: target, updated: false, how }

  const archive = archiveName()
  const base = `${process.env.BATON_DOWNLOAD_BASE ?? `https://github.com/${REPO}/releases/download`}/v${target}`
  log(`downloading ${archive} (${target})…`)
  const [data, sums] = await Promise.all([download(`${base}/${archive}`), download(`${base}/SHA256SUMS`)])
  const want = new TextDecoder()
    .decode(sums)
    .split("\n")
    .find((l) => l.trim().endsWith(` ${archive}`))
    ?.split(/\s+/)[0]
  if (!want) throw new Error(`${archive} is not listed in the release's SHA256SUMS`)
  const got = new Bun.CryptoHasher("sha256").update(data).digest("hex")
  if (got !== want) throw new Error(`checksum mismatch for ${archive}: expected ${want}, got ${got} — not installed`)

  const tmp = mkdtempSync(join(tmpdir(), "baton-update-"))
  try {
    writeFileSync(join(tmp, archive), data)
    const unpack = archive.endsWith(".zip") ? ["unzip", "-q", archive] : ["tar", "-xzf", archive]
    const p = Bun.spawnSync(unpack, { cwd: tmp, stderr: "pipe" })
    if (p.exitCode !== 0) throw new Error(`could not unpack ${archive}: ${p.stderr.toString()}`)
    const exe = process.platform === "win32" ? "baton.exe" : "baton"
    const fresh = join(tmp, archive.replace(/\.(tar\.gz|zip)$/, ""), exe)
    // smoke test before swapping: the new binary must run
    const v = Bun.spawnSync([fresh, "--version"], { stdout: "pipe", stderr: "pipe" })
    if (v.exitCode !== 0 || !v.stdout.toString().includes(target)) throw new Error(`the downloaded binary did not run (${v.stderr.toString().trim()})`)
    const dest = process.execPath
    const staged = join(dirname(dest), `.baton-${target}.new`)
    writeFileSync(staged, readFileSync(fresh))
    chmodSync(staged, 0o755)
    // atomic on POSIX: running processes (the daemon) keep the old inode until they restart
    renameSync(staged, dest)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EACCES")
      throw new Error(`no permission to replace ${process.execPath} — rerun with sudo, or reinstall to a folder you own (install.sh)`)
    throw e
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  return { from, to: target, updated: true }
}
