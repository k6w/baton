/**
 * Sandbox for run_command.
 *
 *   macOS  `sandbox-exec -p <profile>`: reads anywhere; writes only to the workspace, the OS temp
 *          dirs (/private/tmp, /private/var/folders, $TMPDIR), ~/.cache and options.sandboxWritable;
 *          network allowed unless options.sandboxNetwork === false.
 *   Linux  `bwrap` when installed: / read-only, workspace + temp dirs (+ ~/.cache, extra paths)
 *          bound read-write, `--unshare-net` when network is off. Without bwrap: no sandbox (warned once).
 *
 * options.sandbox = "auto" (default) | "off". The yolo approval mode turns the sandbox off.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import type { ApprovalMode } from "@batonsh/protocol"
import { which } from "@batonsh/protocol"

export interface SandboxSettings {
  mode: "auto" | "off"
  network: boolean
  /** Extra writable paths (absolute or ~/…). */
  writable: string[]
}

export interface Sandbox {
  kind: "seatbelt" | "bwrap" | "none"
  /** Why there is no sandbox (kind "none"). */
  reason?: string
  writable: string[]
  network: boolean
  /** argv for a shell command. */
  wrap(argv: string[]): string[]
  describe(): string
}

export function sandboxSettings(o: Record<string, unknown>): SandboxSettings {
  const mode = o.sandbox === "off" || o.sandbox === false ? "off" : "auto"
  const writable = Array.isArray(o.sandboxWritable) ? o.sandboxWritable.filter((x): x is string => typeof x === "string" && !!x.trim()) : []
  return { mode, network: o.sandboxNetwork !== false, writable }
}

function expandHome(p: string, home: string): string {
  if (p === "~") return home
  if (p.startsWith("~/")) return join(home, p.slice(2))
  return p
}

/** realpath of the deepest existing ancestor + the rest (seatbelt matches resolved paths: /var → /private/var). */
function real(p: string): string {
  const tail: string[] = []
  let cur = resolve(p)
  for (;;) {
    try {
      return join(realpathSync(cur), ...tail.reverse())
    } catch {}
    const parent = dirname(cur)
    if (parent === cur) return resolve(p)
    tail.push(basename(cur))
    cur = parent
  }
}

/** A worktree's `.git` is a file pointing at the main repo's git dir: git needs to write there too. */
export function gitDirsFor(cwd: string): string[] {
  const dotgit = join(cwd, ".git")
  try {
    if (!statSync(dotgit).isFile()) return []
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotgit, "utf8"))
    if (!m?.[1]) return []
    const gitdir = real(isAbsolute(m[1].trim()) ? m[1].trim() : resolve(cwd, m[1].trim()))
    const out = [gitdir]
    try {
      const common = readFileSync(join(gitdir, "commondir"), "utf8").trim()
      if (common) out.push(real(isAbsolute(common) ? common : resolve(gitdir, common)))
    } catch {}
    return out
  } catch {
    return []
  }
}

/** Cache folders (under $HOME) that installs and builds write to. */
export const PACKAGE_CACHES = [
  ".bun/install/cache",
  ".npm",
  ".pnpm-store",
  ".yarn/berry/cache",
  "Library/Caches",
  "Library/pnpm",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
  ".rustup/tmp",
  ".local/share/pnpm",
]

export function writablePaths(cwd: string, settings: SandboxSettings, env: Record<string, string | undefined> = process.env): string[] {
  const home = env.HOME?.trim() || homedir()
  const tmp = env.TMPDIR?.trim() || tmpdir()
  const raw = [
    cwd,
    ...gitDirsFor(cwd),
    "/private/tmp",
    "/tmp",
    "/private/var/folders",
    tmp,
    join(home, ".cache"),
    // package-manager caches: installs and builds inside the workspace must keep working
    ...PACKAGE_CACHES.map((p) => join(home, p)),
    ...settings.writable.map((p) => expandHome(p, home)),
  ]
  const out: string[] = []
  for (const p of raw) {
    if (!isAbsolute(p)) continue
    const r = real(p).replace(/\/+$/, "") || "/"
    if (!out.includes(r)) out.push(r)
  }
  return out
}

const sbString = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

export function seatbeltProfile(writable: string[], network: boolean): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    ...writable.map((p) => `  (subpath ${sbString(p)})`),
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/tty") (regex #"^/dev/fd/") (regex #"^/dev/ptmx$") (regex #"^/dev/ttys"))',
  ]
  if (!network) lines.push("(deny network*)", "(allow network* (remote unix-socket) (local unix-socket))")
  return lines.join("\n")
}

let warnedNoBwrap = false

export function resolveSandbox(opts: {
  settings: SandboxSettings
  approval: ApprovalMode
  cwd: string
  env?: Record<string, string | undefined>
  platform?: NodeJS.Platform
  log?: (level: "warn" | "info", msg: string) => void
  /** Lookup for executables (tests). */
  which?: (bin: string) => string | null | undefined
}): Sandbox {
  const { settings } = opts
  const none = (reason: string): Sandbox => ({ kind: "none", reason, writable: [], network: true, wrap: (a) => a, describe: () => `off (${reason})` })
  if (settings.mode === "off") return none("options.sandbox = off")
  if (opts.approval === "yolo") return none("yolo approval")
  const platform = opts.platform ?? process.platform
  const find = opts.which ?? ((b: string) => which(b))
  const writable = writablePaths(opts.cwd, settings, opts.env)
  const network = settings.network
  const desc = (kind: string) => `${kind} (writes: ${writable.join(", ")}; network: ${network ? "allowed" : "blocked"})`
  if (platform === "darwin") {
    const bin = existsSync("/usr/bin/sandbox-exec") ? "/usr/bin/sandbox-exec" : find("sandbox-exec")
    if (!bin) return none("sandbox-exec not found")
    const profile = seatbeltProfile(writable, network)
    return { kind: "seatbelt", writable, network, wrap: (argv) => [bin, "-p", profile, ...argv], describe: () => desc("seatbelt") }
  }
  if (platform === "linux") {
    const bwrap = find("bwrap")
    if (!bwrap) {
      if (!warnedNoBwrap) {
        warnedNoBwrap = true
        opts.log?.("warn", "run_command is not sandboxed: bubblewrap (bwrap) is not installed — install it to confine commands to the workspace")
      }
      return none("bwrap not installed")
    }
    const binds = writable.filter((p) => existsSync(p)).flatMap((p) => ["--bind", p, p])
    const args = [bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", ...binds, "--die-with-parent"]
    if (!network) args.push("--unshare-net")
    return { kind: "bwrap", writable, network, wrap: (argv) => [...args, "--", ...argv], describe: () => desc("bwrap") }
  }
  return none(`no sandbox on ${platform}`)
}

export function resetSandboxWarnings(): void {
  warnedNoBwrap = false
}
