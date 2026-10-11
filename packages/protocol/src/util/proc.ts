import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

export const IS_WINDOWS = process.platform === "win32"

/**
 * The address to listen on / connect to for a control socket path. Windows has named pipes
 * instead of socket files: any other path maps to a pipe derived from it, the same on both ends.
 */
export function ipcPath(socketPath: string): string {
  if (!IS_WINDOWS || socketPath.startsWith("\\\\.\\pipe\\")) return socketPath
  const h = new Bun.CryptoHasher("sha1").update(socketPath.toLowerCase()).digest("hex").slice(0, 16)
  return `\\\\.\\pipe\\baton-${h}`
}

/** Extra locations agent CLIs commonly install to, beyond PATH. */
export function extraBinDirs(): string[] {
  const h = homedir()
  if (IS_WINDOWS) {
    const appData = process.env.APPDATA ?? join(h, "AppData", "Roaming")
    const local = process.env.LOCALAPPDATA ?? join(h, "AppData", "Local")
    return [
      join(appData, "npm"),
      join(h, ".bun", "bin"),
      join(h, ".local", "bin"),
      join(h, ".cargo", "bin"),
      join(h, "go", "bin"),
      join(h, "scoop", "shims"),
      join(local, "Programs"),
      join(local, "Microsoft", "WinGet", "Links"),
      join(h, ".opencode", "bin"),
      join(h, ".claude", "local"),
    ]
  }
  const dirs = [
    join(h, ".local/bin"),
    join(h, ".bun/bin"),
    join(h, ".cargo/bin"),
    join(h, "go/bin"),
    join(h, ".npm-global/bin"),
    join(h, ".opencode/bin"),
    join(h, ".claude/local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
  const nvm = join(h, ".nvm/versions/node")
  try {
    for (const v of readdirSync(nvm).sort().reverse()) dirs.push(join(nvm, v, "bin"))
  } catch {}
  return dirs
}

/** Find an executable on PATH or in common install dirs. Never resolves shell aliases. */
export function which(bin: string): string | undefined {
  if (bin.includes("/") || (IS_WINDOWS && bin.includes("\\"))) return existsSync(bin) ? bin : undefined
  const found = Bun.which(bin)
  if (found) return found
  const path = [...(process.env.PATH ?? "").split(delimiter), ...extraBinDirs()].join(delimiter)
  return Bun.which(bin, { PATH: path }) ?? undefined
}

/** PATH augmented with the extra dirs — pass to spawned agents so their own child tools resolve. */
export function augmentedPath(): string {
  const parts = (process.env.PATH ?? "").split(delimiter)
  for (const d of extraBinDirs()) if (!parts.includes(d)) parts.push(d)
  return parts.join(delimiter)
}

/**
 * Signal a child's whole process group (spawned with `detached: true`), falling back to the pid
 * itself — but not once `proc` reports it has exited (the pid may already belong to someone else).
 */
export function killProcessTree(
  pid: number | undefined,
  signal: NodeJS.Signals | number = "SIGTERM",
  proc?: { exitCode: number | null; signalCode?: string | null },
): void {
  if (!pid) return
  if (IS_WINDOWS) {
    // no process groups or signals: taskkill ends the process and everything it started
    if (proc && (proc.exitCode !== null || (proc.signalCode ?? null) !== null)) return
    try {
      Bun.spawnSync(["taskkill", "/pid", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" })
    } catch {}
    return
  }
  try {
    process.kill(-pid, signal)
    return
  } catch {}
  if (proc && (proc.exitCode !== null || (proc.signalCode ?? null) !== null)) return
  try {
    process.kill(pid, signal)
  } catch {}
}

/**
 * argv (and spawn options) to start a command. On Windows the command is resolved on PATH first
 * (PATHEXT: codex → codex.cmd); Bun runs .cmd / .bat shims itself, with correct quoting.
 * Elsewhere argv is returned unchanged.
 */
export function spawnable(argv: string[]): { cmd: string[]; opts: { windowsVerbatimArguments?: boolean } } {
  if (!IS_WINDOWS || !argv[0]) return { cmd: argv, opts: {} }
  const bin = /[\\/]/.test(argv[0]) ? argv[0] : (which(argv[0]) ?? argv[0])
  return { cmd: [bin, ...argv.slice(1)], opts: {} }
}

/** Drain a stream into memory; `cancel()` stops waiting (e.g. a grandchild still holds the pipe). */
function collect(stream: ReadableStream<Uint8Array>): { done: Promise<void>; cancel: () => void; text: () => string } {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  const done = (async () => {
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done) break
        chunks.push(r.value)
      }
    } catch {}
  })()
  return {
    done,
    cancel: () => {
      reader.cancel().catch(() => {})
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  }
}

/**
 * Run a command and capture its output. The child gets its own process group, which is SIGKILLed on
 * timeout; once the child exits we wait only briefly for its pipes (a backgrounded grandchild may
 * keep them open forever) before returning what we have.
 */
export async function runCapture(
  cmd: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined>; pipeGraceMs?: number } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const run = spawnable(cmd)
  const proc = Bun.spawn(run.cmd, {
    ...run.opts,
    cwd: opts.cwd,
    env: { ...process.env, PATH: augmentedPath(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: !IS_WINDOWS,
  })
  const out = collect(proc.stdout)
  const err = collect(proc.stderr)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killProcessTree(proc.pid, "SIGKILL")
  }, opts.timeoutMs ?? 10_000)
  const code = await proc.exited
  clearTimeout(timer)
  const pipes = Promise.all([out.done, err.done])
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  const drained = await Promise.race([
    pipes.then(() => true),
    new Promise<boolean>((r) => {
      graceTimer = setTimeout(() => r(false), timedOut ? 200 : (opts.pipeGraceMs ?? 1000))
    }),
  ])
  clearTimeout(graceTimer)
  if (!drained) {
    out.cancel()
    err.cancel()
  }
  return { code, stdout: out.text(), stderr: err.text() }
}

export function parseVersion(s: string): string | undefined {
  return /(\d+\.\d+\.\d+(?:[-+.][\w.]+)?)/.exec(s)?.[1]
}

/** Split a byte stream into lines (handles partial chunks). */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buf = ""
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let nl = buf.indexOf("\n")
    while (nl >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "")
      buf = buf.slice(nl + 1)
      if (line.length) yield line
      nl = buf.indexOf("\n")
    }
  }
  buf += decoder.decode()
  if (buf.trim().length) yield buf
}
