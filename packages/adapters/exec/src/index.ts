/**
 * Exec adapter: drives any CLI that takes a prompt on the command line (Aider, Crush, Antigravity,
 * your own scripts). Each turn spawns the command in a pseudo-terminal (so TTY-only CLIs work),
 * streams its output as assistant text, and afterwards reports file changes as diffs using a
 * git snapshot (temporary index — the user's staging area is untouched).
 *
 * Config: [agents.x] adapter = "exec", command = "mycli", args = ["--msg", "{prompt}"]
 * Placeholders in args: {prompt} {model} {cwd}
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  augmentedPath,
  type DetectResult,
  diffStat,
  IS_WINDOWS,
  killProcessTree,
  newId,
  type PromptInput,
  parseUnifiedDiff,
  parseVersion,
  runCapture,
  type SessionConfig,
  spawnable,
  which,
} from "@batonsh/protocol"

export interface ExecPreset {
  id: string
  displayName: string
  binaries: string[]
  /** Argument template; {prompt} is required. */
  args: string[]
  /** Extra args inserted when a model is set (e.g. ["--model", "{model}"]). */
  modelArgs?: string[]
  versionArgs?: string[]
  env?: Record<string, string>
  notes?: string
}

export const EXEC_PRESETS: ExecPreset[] = [
  {
    id: "aider",
    displayName: "Aider",
    binaries: ["aider"],
    args: ["--yes-always", "--no-auto-commits", "--no-pretty", "--no-stream", "--no-check-update", "--message", "{prompt}"],
    modelArgs: ["--model", "{model}"],
    notes: "aider keeps chat history per directory, so follow-up turns have context",
  },
  {
    id: "crush",
    displayName: "Crush",
    binaries: ["crush"],
    args: ["run", "-q", "{prompt}"],
    modelArgs: ["--model", "{model}"],
  },
  {
    id: "agy",
    displayName: "Antigravity CLI",
    binaries: ["agy"],
    args: ["-p", "{prompt}"],
    modelArgs: ["--model", "{model}"],
    notes: "flags unverified — override with [agents.x] args if your version differs",
  },
]

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[@-Z\\-_]/g

/** Terminal output → plain text (strip escapes, apply carriage returns / backspaces). */
export function cleanTerminal(raw: string): string {
  const s = raw.replace(ANSI, "").replace(/\r\n/g, "\n")
  const out: string[] = []
  for (const line of s.split("\n")) {
    // a bare \r rewinds the line (spinners, progress bars): keep the last rewrite
    const parts = line.split("\r")
    let l = parts[parts.length - 1] ?? ""
    // backspace erases the previous char (\x08 — not \b, which is a word boundary outside [])
    while (/[^\x08]\x08/.test(l)) l = l.replace(/[^\x08]\x08/, "")
    out.push(l.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ""))
  }
  return out.join("\n")
}

function expand(args: string[], vars: Record<string, string>): string[] {
  return args.map((a) => a.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? ""))
}

/** Tree of the working directory via a temporary index (null outside git repos). */
function snapshot(cwd: string): string | null {
  const inside = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { windowsHide: true, cwd, stdout: "pipe", stderr: "ignore" })
  if (inside.exitCode !== 0) return null
  const dir = mkdtempSync(join(tmpdir(), "baton-exec-"))
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") }
  try {
    const head = Bun.spawnSync(["git", "rev-parse", "--verify", "-q", "HEAD"], { windowsHide: true, cwd, stdout: "pipe", stderr: "ignore" })
    if (head.exitCode === 0) Bun.spawnSync(["git", "read-tree", head.stdout.toString().trim()], { windowsHide: true, cwd, env })
    Bun.spawnSync(["git", "add", "-A", "--", "."], { windowsHide: true, cwd, env, stderr: "ignore" })
    const t = Bun.spawnSync(["git", "write-tree"], { windowsHide: true, cwd, env, stdout: "pipe" })
    return t.exitCode === 0 ? t.stdout.toString().trim() : null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function createExecAdapter(preset: ExecPreset): AgentAdapter {
  return {
    id: preset.id,
    displayName: preset.displayName,
    family: "exec",
    binaries: preset.binaries,
    async detect(opts): Promise<DetectResult> {
      const bin = opts?.command ? which(opts.command) : preset.binaries.map((b) => which(b)).find(Boolean)
      if (!bin) return { installed: false, auth: "unknown", protocols: ["exec"], notes: preset.notes ? [preset.notes] : undefined }
      const v = await runCapture([bin, ...(preset.versionArgs ?? ["--version"])], { timeoutMs: 8000 }).catch(() => undefined)
      return {
        installed: true,
        path: bin,
        version: v ? parseVersion(`${v.stdout} ${v.stderr}`) : undefined,
        auth: "unknown",
        protocols: ["exec"],
        notes: preset.notes ? [preset.notes] : undefined,
      }
    },
    capabilities(): AdapterCapabilities {
      return { steer: false, interrupt: true, resume: false, fork: false, diff: true, usage: false, cost: false, permissions: false, mcp: false, models: [] }
    },
    async start(cfg: SessionConfig, ctx): Promise<AgentSession> {
      const bin = cfg.command ? which(cfg.command) : preset.binaries.map((b) => which(b)).find(Boolean)
      if (!bin) throw new Error(`${preset.displayName} not found (looked for ${(cfg.command ? [cfg.command] : preset.binaries).join(", ")})`)
      return new ExecSession(bin, preset, cfg, ctx.emit, (l, m) => ctx.log(l, m))
    },
  }
}

class ExecSession implements AgentSession {
  private queue: PromptInput[] = []
  private proc: ReturnType<typeof Bun.spawn> | undefined
  private running = false
  private interrupted = false
  private closed = false
  private firstTurn = true
  private turns = 0
  private exited = false
  private current: Promise<void> | undefined
  private emit: (e: AgentEvent) => void

  constructor(
    private bin: string,
    private preset: ExecPreset,
    private cfg: SessionConfig,
    emit: (e: AgentEvent) => void,
    private log: (level: "debug" | "info" | "warn" | "error", m: string) => void,
  ) {
    // nothing is emitted after agent.exited
    this.emit = (e) => {
      if (!this.exited) emit(e)
    }
    queueMicrotask(() => {
      this.emit({ type: "agent.updated", data: { model: cfg.model } })
      this.emit({ type: "agent.status", data: { status: "ready" } })
    })
  }

  resumeId(): string | undefined {
    return undefined
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.closed) throw new Error(`${this.preset.displayName} session is closed`)
    if (this.running) {
      this.queue.push(input)
      return
    }
    this.current = this.run(input)
  }

  private async run(input: PromptInput) {
    this.running = true
    this.interrupted = false
    const turnId = `t${++this.turns}`
    // the system prompt (Baton identity/role) rides along with the first task — CLIs have no flag for it
    const text = this.firstTurn && this.cfg.systemPrompt ? `${this.cfg.systemPrompt}\n\n---\n\n${input.text}` : input.text
    this.firstTurn = false
    this.emit({ type: "agent.status", data: { status: "busy" } })
    this.emit({ type: "turn.started", data: { turnId, prompt: input.text } })
    const vars = { prompt: text, model: this.cfg.model ?? "", cwd: this.cfg.cwd }
    const args = [
      ...(this.cfg.args?.length ? expand(this.cfg.args, vars) : expand(this.preset.args, vars)),
      ...(this.cfg.model && this.preset.modelArgs && !this.cfg.args?.length ? expand(this.preset.modelArgs, vars) : []),
    ]
    let before: string | null = null
    const toolCallId = newId("tc")
    const messageId = newId("msg")
    let buf = ""
    let sent = ""
    const flush = () => {
      const clean = cleanTerminal(buf).trimEnd()
      if (clean.length > sent.length && clean.startsWith(sent)) {
        this.emit({ type: "message.delta", data: { messageId, role: "assistant", text: clean.slice(sent.length) } })
        sent = clean
      }
    }
    try {
      // inside the try: a failing snapshot (e.g. cwd vanished) must still end the turn
      before = snapshot(this.cfg.cwd)
      const env = { ...process.env, PATH: augmentedPath(), NO_COLOR: "1", TERM: "dumb", ...this.preset.env, ...this.cfg.env }
      const onData = (d: Uint8Array) => {
        buf += new TextDecoder().decode(d)
        flush()
      }
      if (IS_WINDOWS) {
        // Bun's pseudo-terminal is POSIX-only: plain pipes (most CLIs print the same either way)
        const run = spawnable([this.bin, ...args])
        const p = Bun.spawn(run.cmd, { ...run.opts, cwd: this.cfg.cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
        this.proc = p
        const pump = async (st: ReadableStream<Uint8Array>) => {
          for await (const chunk of st as unknown as AsyncIterable<Uint8Array>) onData(chunk)
        }
        void pump(p.stdout)
        void pump(p.stderr)
      } else
        this.proc = Bun.spawn([this.bin, ...args], {
          windowsHide: true,
          cwd: this.cfg.cwd,
          env,
          terminal: { cols: 160, rows: 50, data: (_t: unknown, d: Uint8Array) => onData(d) },
        } as never)
      const code = await this.proc.exited
      flush()
      const final = cleanTerminal(buf).trim()
      this.emit({ type: "message.completed", data: { messageId, role: "assistant", text: final || `(${this.preset.displayName} exited with ${code})` } })
      // file changes made during the turn → one edit tool call with diffs
      const after = before ? snapshot(this.cfg.cwd) : null
      if (before && after && before !== after) {
        const patch = Bun.spawnSync(["git", "diff", "--no-color", before, after], { windowsHide: true, cwd: this.cfg.cwd, stdout: "pipe" }).stdout.toString()
        const files = parseUnifiedDiff(patch).filter((f) => f.path)
        if (files.length) {
          this.emit({
            type: "tool.call",
            data: {
              toolCallId,
              kind: "edit",
              name: "edit",
              title: `Edited ${files.length === 1 ? files[0]!.path : `${files.length} files`}`,
              status: "in_progress",
            },
          })
          const content = files.map((f) => ({ type: "diff" as const, path: f.path as string, lines: f.lines, ...diffStat(f.lines) }))
          const added = content.reduce((n, c) => n + c.added, 0)
          const removed = content.reduce((n, c) => n + c.removed, 0)
          this.emit({ type: "tool.update", data: { toolCallId, status: "completed", summary: `+${added} −${removed}`, content } })
        }
      }
      if (this.interrupted) this.emit({ type: "turn.interrupted", data: { turnId } })
      else this.emit({ type: "turn.completed", data: { turnId, stopReason: code === 0 ? "end_turn" : "error" } })
      if (code !== 0 && !this.interrupted)
        this.emit({ type: "error", data: { message: `${this.preset.displayName} exited with code ${code}`, detail: final.split("\n").slice(-5).join("\n") } })
    } catch (e) {
      this.log("error", String(e))
      this.emit({ type: "error", data: { message: e instanceof Error ? e.message : String(e), fatal: false } })
      this.emit({ type: "turn.completed", data: { turnId, stopReason: "error" } })
    } finally {
      this.proc = undefined
      this.running = false
      if (!this.closed) this.emit({ type: "agent.status", data: { status: "ready" } })
      const next = this.closed ? undefined : this.queue.shift()
      if (next) this.current = this.run(next)
    }
  }

  async interrupt(): Promise<void> {
    if (!this.proc) return
    this.interrupted = true
    this.queue = []
    try {
      if (IS_WINDOWS) killProcessTree(this.proc?.pid, "SIGINT", this.proc ?? undefined)
      else (this.proc as unknown as { terminal?: { write(s: string): void } }).terminal?.write("\x03")
    } catch {}
    this.escalate(1500, 6000)
  }

  /** SIGINT then SIGKILL the turn's process (group) if it is still running after the delays. */
  private escalate(intMs: number, killMs: number) {
    const p = this.proc
    if (!p) return
    setTimeout(() => {
      if (this.proc === p) killProcessTree(p.pid, "SIGINT")
    }, intMs)
    setTimeout(() => {
      if (this.proc === p) killProcessTree(p.pid, "SIGKILL")
    }, killMs)
  }

  async respondPermission(): Promise<void> {}

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.queue = []
    if (this.proc) {
      this.interrupted = true
      try {
        if (IS_WINDOWS) killProcessTree(this.proc?.pid, "SIGINT", this.proc ?? undefined)
        else (this.proc as unknown as { terminal?: { write(s: string): void } }).terminal?.write("\x03")
      } catch {}
      this.escalate(300, 2000)
    }
    // let the running turn finish (turn.interrupted) before reporting the exit — bounded
    const cur = this.current
    if (cur) await Promise.race([cur.catch(() => {}), Bun.sleep(3000)])
    this.emit({ type: "agent.exited", data: { code: 0, reason: "closed" } })
    this.exited = true
  }
}

export const execAdapters: AgentAdapter[] = [
  ...EXEC_PRESETS.map(createExecAdapter),
  createExecAdapter({ id: "exec", displayName: "Command", binaries: [], args: ["{prompt}"] }),
]
export default createExecAdapter
