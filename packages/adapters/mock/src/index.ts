/**
 * Mock adapter — a scripted, deterministic-ish fake agent. Used by `baton demo`, the TUI
 * tests and the daemon tests. It never touches the filesystem; everything is simulated.
 *
 * Options (SessionConfig.options):
 *   speed:   multiplier for delays (default 1; tests use 0)
 *   persona: "claude" | "codex" | "generic" — affects tool naming/titles
 *   seed:    number for the PRNG
 *   fail:    if true, the turn ends with an error
 */
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type DetectResult,
  DEFAULT_PERMISSION_OPTIONS,
  type PromptInput,
  type SessionConfig,
  deferred,
  diffLines,
  diffStat,
  newId,
} from "@batonsh/protocol"

type Persona = "claude" | "codex" | "generic"

interface Step {
  delay: number
  run: () => Promise<void> | void
}

function prng(seed: number) {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 0xffffffff
  }
}

const FILES = [
  "src/app.ts",
  "src/components/LoginButton.tsx",
  "src/theme/tokens.ts",
  "README.md",
  "tests/button.spec.ts",
  "package.json",
  "src/server/routes.ts",
]

const SNIPPETS: [string, string][] = [
  ["  background: #3b82f6;", "  background: var(--btn-bg);"],
  ["teh fastest way", "the fastest way"],
  ["const retries = 3", "const retries = 5"],
  ["if (!hex) return", "if (!hex) throw new Error(\"missing color\")"],
  ["export const timeout = 1000", "export const timeout = 30_000"],
]

const COMMANDS: [string, string][] = [
  ["git diff --stat", " 1 file changed, 1 insertion(+), 1 deletion(-)"],
  ["bun test", " 42 pass\n 0 fail"],
  ["rg -n \"teh\" .", "README.md:14:teh fastest way"],
  ["make lint", "✓ 0 problems"],
  ["curl -s localhost:3000/health", "200 OK · 18ms"],
]

export const mockAdapter: AgentAdapter = {
  id: "mock",
  displayName: "Mock Agent",
  family: "mock",
  binaries: [],
  async detect(): Promise<DetectResult> {
    return { installed: true, version: "1.0.0", auth: "ok", protocols: ["in-process"] }
  },
  capabilities(): AdapterCapabilities {
    return {
      steer: true,
      interrupt: true,
      resume: true,
      fork: false,
      diff: true,
      usage: true,
      cost: true,
      permissions: true,
      mcp: false,
      models: ["mock-fast", "mock-smart"],
    }
  },
  async start(cfg: SessionConfig, ctx): Promise<AgentSession> {
    return new MockSession(cfg, ctx.emit, ctx.signal)
  },
}

class MockSession implements AgentSession {
  private persona: Persona
  private speed: number
  private rand: () => number
  private running = false
  private aborted = false
  private queue: PromptInput[] = []
  private steered: PromptInput[] = []
  private pendingPerms = new Map<string, ReturnType<typeof deferred<string | null>>>()
  private sessionId = newId("mock")
  private usage = { input: 0, cachedInput: 0, output: 0, reasoning: 0, costUsd: 0 }
  private turn = 0

  constructor(
    private cfg: SessionConfig,
    private emit: (e: AgentEvent) => void,
    signal: AbortSignal,
  ) {
    const o = cfg.options ?? {}
    this.persona = (o.persona as Persona) ?? "generic"
    this.speed = typeof o.speed === "number" ? o.speed : 1
    this.rand = prng(typeof o.seed === "number" ? o.seed : hash(cfg.name))
    signal.addEventListener("abort", () => void this.close())
    queueMicrotask(() => {
      this.emit({ type: "agent.session", data: { sessionId: this.sessionId } })
      this.emit({ type: "agent.updated", data: { version: "1.0.0", model: cfg.model ?? "mock-fast" } })
      this.emit({ type: "agent.status", data: { status: "ready" } })
    })
  }

  resumeId(): string {
    return this.sessionId
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.running) {
      this.queue.push(input)
      return
    }
    void this.runTurn(input)
  }

  async steer(input: PromptInput): Promise<void> {
    if (!this.running) return this.prompt(input)
    this.steered.push(input)
  }

  async interrupt(): Promise<void> {
    if (!this.running) return
    this.aborted = true
    for (const [id, d] of this.pendingPerms) {
      d.resolve(null)
      this.pendingPerms.delete(id)
    }
  }

  async respondPermission(requestId: string, optionId: string | null): Promise<void> {
    const d = this.pendingPerms.get(requestId)
    if (!d) return
    this.pendingPerms.delete(requestId)
    d.resolve(optionId)
  }

  async close(): Promise<void> {
    await this.interrupt()
    this.queue = []
    this.emit({ type: "agent.exited", data: { code: 0, reason: "closed" } })
  }

  private sleep(ms: number): Promise<void> {
    const t = ms * this.speed
    return t <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, t))
  }

  private pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.rand() * arr.length)] as T
  }

  private addUsage(input: number, output: number) {
    this.usage.input += input
    this.usage.cachedInput += Math.floor(input * 0.6)
    this.usage.output += output
    this.usage.costUsd += (input * 3 + output * 15) / 1_000_000
    this.emit({ type: "usage.updated", data: { ...this.usage, mode: "cumulative", source: "reported" } })
  }

  private async say(text: string, role: "assistant" | "thought" = "assistant") {
    const messageId = newId("msg")
    const words = text.split(/(?<= )/)
    for (const w of words) {
      if (this.aborted) return
      this.emit({ type: "message.delta", data: { messageId, role, text: w } })
      await this.sleep(15 + this.rand() * 25)
    }
    this.emit({ type: "message.completed", data: { messageId, role, text } })
  }

  private toolName(kind: "read" | "edit" | "execute" | "search"): string {
    if (this.persona === "codex") return { read: "read", edit: "apply_patch", execute: "shell", search: "rg" }[kind]
    return { read: "Read", edit: "Edit", execute: "Bash", search: "Grep" }[kind]
  }

  private title(kind: "read" | "edit" | "execute" | "search", arg: string): string {
    if (this.persona === "codex") {
      return { read: `Read ${arg}`, edit: `Edited ${arg}`, execute: `Ran ${arg}`, search: `Searched ${arg}` }[kind]
    }
    return { read: `Read(${arg})`, edit: `Update(${arg})`, execute: `Bash(${arg})`, search: `Grep(${arg})` }[kind]
  }

  /** Ask baton for permission; resolves true when allowed. */
  private async ask(toolCallId: string, title: string, kind: "execute" | "edit"): Promise<boolean> {
    if (this.cfg.approval === "yolo" || this.cfg.approval === "auto") return true
    if (this.cfg.approval === "auto-edit" && kind === "edit") return true
    const requestId = newId("perm")
    const d = deferred<string | null>()
    this.pendingPerms.set(requestId, d)
    this.emit({ type: "agent.status", data: { status: "awaiting_approval" } })
    this.emit({
      type: "permission.requested",
      data: { requestId, toolCallId, title, kind, options: DEFAULT_PERMISSION_OPTIONS },
    })
    const optionId = await d.promise
    this.emit({ type: "agent.status", data: { status: "busy" } })
    return optionId === "allow_once" || optionId === "allow_always"
  }

  private async runTurn(input: PromptInput) {
    this.running = true
    this.aborted = false
    const turnId = `t${++this.turn}`
    this.emit({ type: "agent.status", data: { status: "busy" } })
    this.emit({ type: "turn.started", data: { turnId, prompt: input.text } })
    this.addUsage(1200 + Math.floor(this.rand() * 4000), 0)
    try {
      if (/\bpong\b/i.test(input.text)) {
        await this.say("PONG")
      } else {
        await this.workLoop(input)
      }
      if (this.cfg.options?.fail) throw new Error("mock failure")
      if (this.aborted) {
        this.emit({ type: "turn.interrupted", data: { turnId } })
      } else {
        this.emit({ type: "turn.completed", data: { turnId, stopReason: "end_turn" } })
      }
    } catch (e) {
      this.emit({ type: "error", data: { message: e instanceof Error ? e.message : String(e) } })
      this.emit({ type: "turn.completed", data: { turnId, stopReason: "error" } })
    } finally {
      this.running = false
      this.emit({ type: "agent.status", data: { status: "ready" } })
      const next = this.queue.shift()
      if (next) void this.runTurn(next)
    }
  }

  private async workLoop(input: PromptInput) {
    const steps = 3 + Math.floor(this.rand() * 4)
    await this.say(`Looking into: ${input.text.slice(0, 60)}`, "thought")
    this.emit({
      type: "plan.updated",
      data: {
        entries: Array.from({ length: steps }, (_, i) => ({ content: `step ${i + 1}`, status: "pending" as const })),
      },
    })
    for (let i = 0; i < steps && !this.aborted; i++) {
      const steer = this.steered.shift()
      if (steer) await this.say(`Got it${steer.from ? ` (${steer.from})` : ""} — ${steer.text.slice(0, 50)}.`)
      const r = this.rand()
      if (r < 0.3) await this.readStep()
      else if (r < 0.65) await this.editStep()
      else await this.execStep()
      this.addUsage(800 + Math.floor(this.rand() * 3000), 120 + Math.floor(this.rand() * 600))
      this.emit({
        type: "plan.updated",
        data: {
          entries: Array.from({ length: steps }, (_, k) => ({
            content: `step ${k + 1}`,
            status: k <= i ? ("completed" as const) : k === i + 1 ? ("in_progress" as const) : ("pending" as const),
          })),
        },
      })
      await this.sleep(300 + this.rand() * 900)
    }
    if (!this.aborted) await this.say(this.pick(["Done.", "All checks pass.", "Change landed; tests green.", "Finished — diff is ready for review."]))
  }

  private async readStep() {
    const file = this.pick(FILES)
    const toolCallId = newId("tc")
    this.emit({
      type: "tool.call",
      data: { toolCallId, kind: "read", name: this.toolName("read"), title: this.title("read", file), status: "in_progress", locations: [{ path: file }] },
    })
    await this.sleep(200 + this.rand() * 500)
    const n = 20 + Math.floor(this.rand() * 400)
    this.emit({ type: "tool.update", data: { toolCallId, status: "completed", summary: `Read ${n} lines` } })
  }

  private async editStep() {
    const file = this.pick(FILES)
    const [before, after] = this.pick(SNIPPETS)
    const toolCallId = newId("tc")
    const title = this.title("edit", file)
    this.emit({
      type: "tool.call",
      data: { toolCallId, kind: "edit", name: this.toolName("edit"), title, status: "pending", locations: [{ path: file }] },
    })
    const ok = await this.ask(toolCallId, title, "edit")
    if (!ok) {
      this.emit({ type: "tool.update", data: { toolCallId, status: "failed", summary: "Denied" } })
      return
    }
    await this.sleep(200 + this.rand() * 400)
    const base = 10 + Math.floor(this.rand() * 170)
    const oldText = ["// context", before, "// more context"].join("\n")
    const newText = ["// context", after, "// more context"].join("\n")
    const lines = diffLines(oldText, newText, 0).map((l) => ({
      ...l,
      oldLine: l.oldLine !== undefined ? l.oldLine + base : undefined,
      newLine: l.newLine !== undefined ? l.newLine + base : undefined,
    }))
    const { added, removed } = diffStat(lines)
    this.emit({
      type: "tool.update",
      data: {
        toolCallId,
        status: "completed",
        summary: `Updated ${Math.max(added, removed)} line${Math.max(added, removed) === 1 ? "" : "s"}`,
        content: [{ type: "diff", path: file, lines, added, removed }],
      },
    })
  }

  private async execStep() {
    const [cmd, out] = this.pick(COMMANDS)
    const toolCallId = newId("tc")
    const title = this.title("execute", cmd)
    this.emit({
      type: "tool.call",
      data: { toolCallId, kind: "execute", name: this.toolName("execute"), title, status: "pending", rawInput: { command: cmd } },
    })
    const ok = await this.ask(toolCallId, title, "execute")
    if (!ok) {
      this.emit({ type: "tool.update", data: { toolCallId, status: "failed", summary: "Denied" } })
      return
    }
    this.emit({ type: "tool.update", data: { toolCallId, status: "in_progress" } })
    await this.sleep(300 + this.rand() * 900)
    this.emit({
      type: "tool.update",
      data: {
        toolCallId,
        status: "completed",
        summary: out.split("\n")[0]?.trim(),
        content: [{ type: "terminal", command: cmd, output: out, exitCode: 0 }],
      },
    })
  }
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

export default mockAdapter
