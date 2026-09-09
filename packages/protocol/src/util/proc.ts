import { existsSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

/** Extra locations agent CLIs commonly install to, beyond PATH. */
export function extraBinDirs(): string[] {
  const h = homedir()
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
  if (bin.includes("/")) return existsSync(bin) ? bin : undefined
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

export async function runCapture(
  cmd: string[],
  opts: { timeoutMs?: number; cwd?: string; env?: Record<string, string | undefined> } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: { ...process.env, PATH: augmentedPath(), ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 10_000)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, stdout, stderr }
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
