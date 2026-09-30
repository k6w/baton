/**
 * Client-side implementation of ACP `terminal/*`: real processes spawned with Bun.spawn,
 * stdout+stderr merged into one output buffer, truncated from the start to honour
 * `outputByteLimit` (as the spec requires, at a character boundary).
 */
import { isAbsolute, resolve } from "node:path"
import { augmentedPath, newId, which } from "@batonsh/protocol"

export interface TerminalExit {
  exitCode: number | null
  signal: string | null
}

export interface TerminalCreateOptions {
  command: string
  args?: string[]
  env?: { name: string; value: string }[]
  cwd?: string | null
  outputByteLimit?: number | null
}

interface Term {
  id: string
  command: string
  proc: ReturnType<typeof Bun.spawn>
  bytes: Uint8Array
  truncated: boolean
  limit: number | undefined
  exit: TerminalExit | undefined
  exited: Promise<TerminalExit>
  pumps: Promise<void>
}

const DEFAULT_LIMIT = 1024 * 1024
const PIPE_DRAIN_MS = 200

/**
 * Signal the process group of a child spawned with `detached: true` (it leads its own group),
 * falling back to the pid itself while it is still running. Errors (already gone) are ignored.
 */
export function killTree(proc: { pid: number; exitCode: number | null; signalCode: string | null }, signal: NodeJS.Signals = "SIGTERM"): void {
  try {
    process.kill(-proc.pid, signal)
    return
  } catch {}
  if (proc.exitCode !== null || proc.signalCode !== null) return
  try {
    process.kill(proc.pid, signal)
  } catch {}
}

export class TerminalManager {
  private terms = new Map<string, Term>()
  /** Final output of released terminals, so tool calls can still render them. */
  private released = new Map<string, { output: string; exit: TerminalExit | undefined; command: string }>()
  private shell = which("bash") ?? "/bin/sh"

  constructor(
    private opts: {
      cwd: string
      env: Record<string, string | undefined>
      onOutput?: (id: string) => void
      onExit?: (id: string, exit: TerminalExit) => void
    },
  ) {}

  create(o: TerminalCreateOptions): string {
    const id = newId("term")
    const cwd = o.cwd ? (isAbsolute(o.cwd) ? o.cwd : resolve(this.opts.cwd, o.cwd)) : this.opts.cwd
    const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath(), ...this.opts.env }
    for (const e of o.env ?? []) env[e.name] = e.value
    // Agents send either a full shell string (no args) or an argv split; honour both.
    const cmd = o.args && o.args.length > 0 ? [o.command, ...o.args] : [this.shell, "-c", o.command]
    const display = o.args && o.args.length > 0 ? [o.command, ...o.args].join(" ") : o.command
    // Own process group, so kill/release reach the whole tree (`cmd1; cmd2`, pipelines, `&` jobs).
    const proc = Bun.spawn(cmd, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true })
    const limit = o.outputByteLimit != null && o.outputByteLimit >= 0 ? o.outputByteLimit : DEFAULT_LIMIT
    const t: Term = {
      id,
      command: display,
      proc,
      bytes: new Uint8Array(0),
      truncated: false,
      limit,
      exit: undefined,
      exited: Promise.resolve({ exitCode: null, signal: null }),
      pumps: Promise.resolve(),
    }
    t.pumps = Promise.all([this.pump(t, proc.stdout as ReadableStream<Uint8Array>), this.pump(t, proc.stderr as ReadableStream<Uint8Array>)]).then(() => {})
    t.exited = proc.exited.then(async (code) => {
      // Exit is the process's, not the pipes': a background child can keep stdout open
      // indefinitely. Give trailing output a moment to drain, then report.
      await Promise.race([t.pumps.catch(() => {}), Bun.sleep(PIPE_DRAIN_MS)])
      const signal = proc.signalCode ?? null
      t.exit = { exitCode: signal ? null : code, signal }
      this.opts.onExit?.(id, t.exit)
      return t.exit
    })
    this.terms.set(id, t)
    return id
  }

  private async pump(t: Term, stream: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
        this.append(t, chunk)
        this.opts.onOutput?.(t.id)
      }
    } catch {}
  }

  private append(t: Term, chunk: Uint8Array): void {
    const merged = new Uint8Array(t.bytes.length + chunk.length)
    merged.set(t.bytes)
    merged.set(chunk, t.bytes.length)
    t.bytes = merged
    const limit = t.limit ?? DEFAULT_LIMIT
    if (t.bytes.length > limit) {
      let start = t.bytes.length - limit
      // never start in the middle of a UTF-8 sequence (continuation bytes are 10xxxxxx)
      while (start < t.bytes.length && ((t.bytes[start] ?? 0) & 0xc0) === 0x80) start++
      t.bytes = t.bytes.slice(start)
      t.truncated = true
    }
  }

  has(id: string): boolean {
    return this.terms.has(id)
  }

  command(id: string): string | undefined {
    return this.terms.get(id)?.command
  }

  output(id: string): { output: string; truncated: boolean; exitStatus: TerminalExit | null } {
    const t = this.get(id)
    return { output: new TextDecoder().decode(t.bytes), truncated: t.truncated, exitStatus: t.exit ?? null }
  }

  /** Output snapshot that tolerates released/unknown terminals (for UI rendering). */
  snapshot(id: string): { output: string; exit: TerminalExit | undefined; command?: string } | undefined {
    const t = this.terms.get(id)
    if (!t) return this.released.get(id)
    return { output: new TextDecoder().decode(t.bytes), exit: t.exit, command: t.command }
  }

  async waitForExit(id: string): Promise<TerminalExit> {
    return this.get(id).exited
  }

  kill(id: string): void {
    killTree(this.get(id).proc)
  }

  release(id: string): void {
    const t = this.terms.get(id)
    if (!t) return
    killTree(t.proc)
    this.terms.delete(id)
    this.released.set(id, { output: new TextDecoder().decode(t.bytes), exit: t.exit, command: t.command })
    if (this.released.size > 64) this.released.delete(this.released.keys().next().value as string)
  }

  async disposeAll(): Promise<void> {
    const all = [...this.terms.values()]
    this.terms.clear()
    for (const t of all) killTree(t.proc)
    await Promise.all(all.map((t) => Promise.race([t.exited, Bun.sleep(2000)]))).catch(() => {})
    for (const t of all) killTree(t.proc, "SIGKILL")
  }

  private get(id: string): Term {
    const t = this.terms.get(id)
    if (!t) throw new Error(`unknown terminal: ${id}`)
    return t
  }
}
