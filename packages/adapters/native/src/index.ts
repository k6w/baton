/**
 * Baton agent — a built-in coding agent that runs on any model provider (via the Vercel AI SDK).
 *
 * Its own loop: model step (streamed, with tools) → run the tool calls (asking Baton when the
 * approval mode says so; read-only calls of one step run concurrently) → feed results back →
 * repeat until the model stops, the step limit is hit, or the turn is interrupted. Steering
 * messages are injected as user messages before the next model step. MCP servers from the session
 * config (incl. Baton's bus) are exposed as tools. Conversations are saved under
 * <stateDir>/native-sessions so `resumeId` survives daemon restarts.
 *
 * Options (SessionConfig.options):
 *   maxSteps           model steps per turn (default 40)
 *   contextTokens      context window used for compaction (default: models.dev limit, else 128k)
 *   compactThreshold   fraction of contextTokens that triggers a summarising compaction (0.75)
 *   compactKeepMessages recent messages kept verbatim when compacting (default 8)
 *   commandTimeoutMs   default run_command timeout (default 120000)
 *   maxOutputChars     cap on tool output fed back to the model (default 30000)
 *   temperature        sampling temperature (provider default when unset)
 *   maxOutputTokens    per-step output token cap
 *   providerOptions    passed through to the AI SDK (e.g. { anthropic: { thinking: {...} } })
 *   pricing            { input, output, cachedInput, cacheWrite } USD per million tokens (overrides models.dev)
 *   promptCaching      Anthropic prompt caching (default true)
 *   sandbox            "auto" (default) | "off" — OS sandbox for run_command (off under yolo)
 *   sandboxWritable    extra writable paths for the sandbox
 *   sandboxNetwork     false blocks network access from commands
 *   allowPrivateFetch  let web_fetch reach loopback / private addresses
 *   vision             force image support on/off (default: models.dev / provider)
 *   fork               with resumeId: copy the conversation into a new session
 */

import { createMCPClient, type MCPClient } from "@ai-sdk/mcp"
import {
  type AdapterCapabilities,
  type AdapterContext,
  type AgentAdapter,
  type AgentEvent,
  type AgentSession,
  type ApprovalMode,
  DEFAULT_PERMISSION_OPTIONS,
  type DetectResult,
  deferred,
  newId,
  type PromptInput,
  type ProviderSpec,
  type SessionConfig,
  type ToolContent,
  type ToolKind,
} from "@batonsh/protocol"
import {
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type SystemModelMessage,
  streamText,
  type Tool,
  type ToolResultPart,
  type ToolSet,
  tool,
} from "ai"
import { ensureCatalogueFresh, loadCatalogue, topModels } from "./catalogue.ts"
import { COMPACTION_PROMPT, estimateTokens, renderForSummary, splitForCompaction, summaryMessage, trimTranscript } from "./context.ts"
import { AUTH_HINT, CLAUDE_SUBSCRIPTION_NOTE, credentialToProvider, type DetectedCredential, detectCredentials, detectCredentialsSync } from "./credentials.ts"
import { needsApproval } from "./policy.ts"
import { contextLimitFor, costUsd, type Price, priceFor, supportsVision } from "./pricing.ts"
import { systemPrompt } from "./prompt.ts"
import { NO_PROVIDER_MESSAGE, type ResolvedModel, resolveModel } from "./providers.ts"
import { resolveSandbox, type Sandbox, type SandboxSettings, sandboxSettings } from "./sandbox.ts"
import { loadSession, maybePrune, type StoredSession, saveSession } from "./sessions.ts"
import { type AnyTool, BUILTIN_TOOLS, capOutput, type ToolImage, type ToolOutcome } from "./tools.ts"
import { PathEscapeError, Workspace } from "./workspace.ts"

export { trimTranscript } from "./context.ts"
export { detectCredentials } from "./credentials.ts"
export { isDestructiveCommand, needsApproval } from "./policy.ts"
export { contextLimitFor, costUsd, priceFor } from "./pricing.ts"
export { resolveModel } from "./providers.ts"
export { PathEscapeError, Workspace } from "./workspace.ts"

export const VERSION = "0.1.0"

/** Recent conversations, also kept in memory (a fallback when the state dir is not writable). */
const transcripts = new Map<string, StoredSession>()
const MAX_TRANSCRIPTS = 64

function remember(s: StoredSession) {
  transcripts.delete(s.id)
  transcripts.set(s.id, s)
  while (transcripts.size > MAX_TRANSCRIPTS) {
    const oldest = transcripts.keys().next().value
    if (oldest === undefined) break
    transcripts.delete(oldest)
  }
}

/** Last detect() result: lets the sync capabilities() list models for the detected provider. */
let lastDetected: DetectedCredential | undefined

export const nativeAdapter: AgentAdapter = {
  id: "baton",
  displayName: "Baton agent",
  family: "native",
  binaries: [],
  async detect(): Promise<DetectResult> {
    ensureCatalogueFresh()
    const c = await detectCredentials({ env: process.env })
    lastDetected = c
    if (!c)
      return {
        installed: true,
        version: VERSION,
        auth: "missing",
        authHint: AUTH_HINT,
        protocols: ["in-process"],
        notes: ["no API key or local model server found (agents with a configured [providers.<name>] entry still work)", CLAUDE_SUBSCRIPTION_NOTE],
      }
    return {
      installed: true,
      version: VERSION,
      auth: "ok",
      protocols: ["in-process"],
      notes: [`default provider: ${c.kind} (from ${c.source})${c.model ? `, model ${c.model}` : ""}`],
    }
  },
  capabilities(): AdapterCapabilities {
    const c = lastDetected ?? detectCredentialsSync(process.env)
    const models = c ? (c.models?.length ? c.models.slice(0, 20) : topModels(loadCatalogue(), c.kind, 20)) : []
    return {
      steer: true,
      interrupt: true,
      resume: true,
      fork: true,
      diff: true,
      usage: true,
      cost: true,
      permissions: true,
      mcp: true,
      models,
    }
  },
  async start(cfg: SessionConfig, ctx: AdapterContext): Promise<AgentSession> {
    const s = new NativeSession(cfg, ctx)
    await s.init()
    return s
  },
}

interface McpEntry {
  server: string
  tool: string
  def: Tool
  readOnly: boolean
}

interface StepResult {
  toolCalls: ToolCall[]
  finishReason?: FinishReason
}

interface ToolCall {
  toolCallId: string
  toolName: string
  input: unknown
  invalid?: boolean
  error?: unknown
}

interface ToolRun {
  part: ToolResultPart
  image?: { image: ToolImage; label: string }
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : d)
const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } } as const

class NativeSession implements AgentSession {
  private ws!: Workspace
  private resolved!: ResolvedModel
  private price: Price | undefined
  private env: Record<string, string | undefined>
  private messages: ModelMessage[] = []
  private sessionId = newId("baton")
  private createdAt = new Date().toISOString()
  private forkedFrom?: string
  private system = ""
  private builtins = new Map<string, AnyTool>(BUILTIN_TOOLS.map((t) => [t.name, t]))
  private mcp = new Map<string, McpEntry>()
  private mcpClients: MCPClient[] = []
  private modelTools: ToolSet = {}

  private running = false
  private closed = false
  private queue: PromptInput[] = []
  private steered: PromptInput[] = []
  private turnAbort?: AbortController
  private currentTurnId?: string
  private turnCount = 0
  private pendingPerms = new Map<string, ReturnType<typeof deferred<string | null>>>()
  private remembered = new Map<string, "allow" | "deny">()
  private usage = { input: 0, cachedInput: 0, output: 0, reasoning: 0, costUsd: 0 }

  /** Provider-reported prompt size of the last step, and the transcript length it covered. */
  private usageMark?: { tokens: number; at: number }
  /** Estimate at which the last compaction attempt failed (don't retry until it grows 10%). */
  private compactFailedAt = 0
  private contextTokens = 128_000
  private vision = false

  /** Provider found by credential detection (when none is configured and no env key is set). */
  private detected?: ProviderSpec
  private sandboxSettings: SandboxSettings
  private sandboxCache?: { approval: ApprovalMode; sandbox: Sandbox }

  private readonly maxSteps: number
  private readonly commandTimeoutMs: number
  private readonly maxOutputChars: number
  private readonly compactThreshold: number
  private readonly compactKeep: number
  private emit: (e: AgentEvent) => void

  constructor(
    private cfg: SessionConfig,
    private ctx: AdapterContext,
  ) {
    this.emit = (e) => {
      if (!this.closed) ctx.emit(e)
    }
    const o = cfg.options ?? {}
    this.maxSteps = num(o.maxSteps, 40)
    this.commandTimeoutMs = num(o.commandTimeoutMs, 120_000)
    this.maxOutputChars = num(o.maxOutputChars, 30_000)
    this.compactThreshold = Math.min(0.95, num(o.compactThreshold, 0.75))
    this.compactKeep = Math.max(2, Math.floor(num(o.compactKeepMessages, 8)))
    this.sandboxSettings = sandboxSettings(o)
    this.env = { ...process.env, ...cfg.env }
  }

  async init(): Promise<void> {
    this.ws = new Workspace(this.cfg.cwd)
    try {
      maybePrune()
    } catch {}
    ensureCatalogueFresh()

    let stored: StoredSession | undefined
    if (this.cfg.resumeId) {
      const id = this.cfg.resumeId
      stored = transcripts.get(id) ?? loadSession(id)
      if (stored) {
        this.messages = structuredClone(stored.messages)
        if (this.cfg.options?.fork === true) {
          this.forkedFrom = id
          this.ctx.log("info", `forked session ${id} → ${this.sessionId}`)
        } else {
          this.sessionId = id
          this.createdAt = stored.createdAt
          this.forkedFrom = stored.forkedFrom
        }
      } else this.ctx.log("warn", `resume id ${id} not found; starting a fresh conversation`)
    }

    await this.resolveProvider(stored)

    const mcpInstructions = await this.connectMcp()
    this.currentSandbox() // logs the effective sandbox
    // the note stays valid when autonomy changes later (yolo lifts the sandbox; the note says "may")
    const sandboxAvailable =
      this.sandboxSettings.mode === "auto" &&
      resolveSandbox({ settings: this.sandboxSettings, approval: "ask", cwd: this.ws.root, env: this.env }).kind !== "none"
    this.system = systemPrompt({
      cwd: this.ws.root,
      extra: this.cfg.systemPrompt,
      mcpInstructions,
      sandbox: sandboxAvailable
        ? `Commands may run in a sandbox: writing outside the workspace, the temp directories and ~/.cache fails with "Operation not permitted"${
            this.sandboxSettings.network ? "" : ", and network access is blocked"
          }. If a command fails because of the sandbox, say what you need instead of working around it.`
        : undefined,
    })
    this.buildModelTools()
    if (this.forkedFrom && this.cfg.options?.fork === true) this.persist()
    this.ctx.signal.addEventListener("abort", () => void this.close(), { once: true })
    queueMicrotask(() => {
      this.emit({ type: "agent.session", data: { sessionId: this.sessionId } })
      this.emit({ type: "agent.updated", data: { version: VERSION, model: this.resolved.modelId, provider: this.resolved.providerId } })
      this.emit({ type: "agent.status", data: { status: "ready" } })
    })
  }

  /** Configured provider → environment key → detected credential (key files, local servers). */
  private async resolveProvider(stored: StoredSession | undefined) {
    let r: ResolvedModel
    try {
      r = resolveModel(this.cfg.provider, this.cfg.model, this.env)
    } catch (e) {
      if (!(e instanceof Error) || e.message !== NO_PROVIDER_MESSAGE) throw e
      const det = await detectCredentials({ env: this.env })
      if (!det) throw e
      this.ctx.log("info", `using ${det.kind} from ${det.source}`)
      this.detected = credentialToProvider(det)
      r = resolveModel(undefined, this.cfg.model ?? det.model, this.env, this.detected)
    }
    // a resumed session keeps its model when the agent doesn't pin one and the provider is the same
    if (!this.cfg.model && stored?.model && stored.providerId === r.providerId && stored.model !== r.modelId) {
      try {
        r = resolveModel(this.cfg.provider, stored.model, this.env, this.detected)
      } catch {}
    }
    this.setResolved(r)
  }

  private setResolved(r: ResolvedModel) {
    this.resolved = r
    const o = this.cfg.options ?? {}
    const cat = loadCatalogue()
    this.price = priceFor(r.modelId, r.kind, o.pricing, cat)
    this.contextTokens = num(o.contextTokens, contextLimitFor(r.modelId, r.kind, cat))
    this.vision = typeof o.vision === "boolean" ? o.vision : (supportsVision(r.modelId, r.kind, cat) ?? false)
  }

  private currentSandbox(): Sandbox {
    const approval = this.cfg.approval
    if (this.sandboxCache?.approval === approval) return this.sandboxCache.sandbox
    const sandbox = resolveSandbox({
      settings: this.sandboxSettings,
      approval,
      cwd: this.ws.root,
      env: this.env,
      log: (level, msg) => this.ctx.log(level, msg),
    })
    this.sandboxCache = { approval, sandbox }
    this.ctx.log("info", `run_command sandbox: ${sandbox.describe()}`)
    return sandbox
  }

  private async connectMcp(): Promise<string[]> {
    const instructions: string[] = []
    const taken = new Set(this.builtins.keys())
    await Promise.all(
      this.cfg.mcpServers.map(async (srv) => {
        let client: MCPClient | undefined
        try {
          client = await withTimeout(
            createMCPClient({
              transport: { type: "http", url: srv.url, headers: srv.headers, redirect: "follow" },
              onUncaughtError: (e) => this.ctx.log("warn", `mcp ${srv.name}: ${errMsg(e)}`),
            }),
            15_000,
            `connecting to MCP server ${srv.name}`,
          )
          this.mcpClients.push(client)
          const tools = (await withTimeout(client.tools(), 15_000, `listing tools of ${srv.name}`)) as Record<string, Tool>
          for (const [name, def] of Object.entries(tools)) {
            let exposed = sanitizeToolName(name)
            if (taken.has(exposed)) exposed = sanitizeToolName(`${srv.name}__${name}`)
            if (taken.has(exposed)) continue
            taken.add(exposed)
            const readOnly = (def as { metadata?: { annotations?: { readOnlyHint?: boolean } } }).metadata?.annotations?.readOnlyHint === true
            this.mcp.set(exposed, { server: srv.name, tool: name, def, readOnly })
          }
          if (client.instructions) instructions.push(`# ${srv.name} (MCP)\n${client.instructions}`)
          this.ctx.log("info", `mcp ${srv.name}: ${Object.keys(tools).length} tools`)
        } catch (e) {
          this.ctx.log("error", `mcp ${srv.name}: ${errMsg(e)}`)
          queueMicrotask(() =>
            this.emit({ type: "error", data: { message: `Baton agent could not connect to MCP server "${srv.name}"`, detail: errMsg(e), fatal: false } }),
          )
          if (client) void client.close().catch(() => {})
        }
      }),
    )
    return instructions
  }

  private buildModelTools() {
    const tools: ToolSet = {}
    for (const t of this.builtins.values()) tools[t.name] = tool({ description: t.description, inputSchema: t.schema })
    // MCP tools are executed by us (no `execute` here) so they go through the same event path.
    for (const [name, e] of this.mcp) {
      const { execute: _drop, ...rest } = e.def as Tool & { execute?: unknown }
      tools[name] = rest as Tool
    }
    this.modelTools = tools
  }

  resumeId(): string {
    return this.sessionId
  }

  async prompt(input: PromptInput): Promise<void> {
    if (this.closed) throw new Error("baton agent session is closed")
    if (this.running) {
      this.queue.push(input)
      return
    }
    void this.runTurn(input)
  }

  async steer(input: PromptInput): Promise<void> {
    if (this.closed) throw new Error("baton agent session is closed")
    if (!this.running) return this.prompt(input)
    this.steered.push(input)
  }

  async interrupt(): Promise<void> {
    if (!this.running) return
    this.turnAbort?.abort()
    for (const [id, d] of this.pendingPerms) {
      this.pendingPerms.delete(id)
      d.resolve(null)
    }
  }

  async respondPermission(requestId: string, optionId: string | null): Promise<void> {
    const d = this.pendingPerms.get(requestId)
    if (!d) return
    this.pendingPerms.delete(requestId)
    d.resolve(optionId)
  }

  async setModel(model: string): Promise<void> {
    if (this.closed) throw new Error("baton agent session is closed")
    this.setResolved(resolveModel(this.cfg.provider, model, this.env, this.detected))
    this.usageMark = undefined
    this.cfg = { ...this.cfg, model }
    this.emit({ type: "agent.updated", data: { model: this.resolved.modelId, provider: this.resolved.providerId } })
  }

  async setApproval(mode: ApprovalMode): Promise<void> {
    if (this.closed) throw new Error("baton agent session is closed")
    this.cfg = { ...this.cfg, approval: mode }
    this.emit({ type: "agent.updated", data: { approval: mode } })
  }

  async close(): Promise<void> {
    if (this.closed) return
    const turnId = this.running ? this.currentTurnId : undefined
    await this.interrupt()
    this.queue = []
    this.steered = []
    if (turnId) this.emit({ type: "turn.interrupted", data: { turnId } })
    this.emit({ type: "agent.exited", data: { code: 0, reason: "closed" } })
    this.closed = true
    this.persist()
    const clients = this.mcpClients.splice(0)
    await Promise.all(clients.map((c) => withTimeout(c.close(), 3000, "closing MCP client").catch(() => {})))
  }

  /** Save the conversation (never credentials) to disk and the in-memory cache. */
  private persist() {
    if (!this.messages.length) return
    const s: StoredSession = {
      version: 1,
      id: this.sessionId,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      cwd: this.ws?.root,
      providerId: this.resolved?.providerId,
      kind: this.resolved?.kind,
      model: this.resolved?.modelId,
      ...(this.forkedFrom ? { forkedFrom: this.forkedFrom } : {}),
      messages: this.messages,
    }
    remember({ ...s, messages: [...this.messages] })
    try {
      saveSession(s)
    } catch (e) {
      this.ctx.log("warn", `could not save session ${this.sessionId}: ${errMsg(e)} (kept in memory only)`)
    }
  }

  // ───────────────────────────── the loop ─────────────────────────────

  private async runTurn(input: PromptInput) {
    this.running = true
    const abort = new AbortController()
    this.turnAbort = abort
    const turnId = `t${++this.turnCount}`
    this.currentTurnId = turnId
    this.emit({ type: "agent.status", data: { status: "busy" } })
    this.emit({ type: "turn.started", data: { turnId, prompt: input.text } })
    this.messages.push(userMessage(input))
    let stopReason = "end_turn"
    try {
      let step = 0
      for (;;) {
        if (abort.signal.aborted) break
        this.injectSteers()
        if (step >= this.maxSteps) {
          stopReason = "max_steps"
          this.say(`Stopped after ${this.maxSteps} steps (step limit for one turn). Send another message to continue.`)
          break
        }
        step++
        await this.manageContext(abort.signal)
        if (abort.signal.aborted) break
        const r = await this.modelStep(abort.signal)
        if (abort.signal.aborted) break
        if (r.toolCalls.length === 0) {
          if (this.steered.length) continue // a steer arrived while the model was answering
          stopReason = mapFinish(r.finishReason)
          break
        }
        await this.runTools(r.toolCalls, abort.signal)
      }
      if (abort.signal.aborted) this.emit({ type: "turn.interrupted", data: { turnId } })
      else this.emit({ type: "turn.completed", data: { turnId, stopReason } })
    } catch (e) {
      if (abort.signal.aborted) this.emit({ type: "turn.interrupted", data: { turnId } })
      else {
        this.ctx.log("error", `turn ${turnId}: ${errMsg(e)}`)
        this.emit({ type: "error", data: { message: errMsg(e) } })
        this.emit({ type: "turn.completed", data: { turnId, stopReason: "error" } })
      }
    } finally {
      this.running = false
      this.turnAbort = undefined
      this.currentTurnId = undefined
      this.persist()
      this.emit({ type: "agent.status", data: { status: "ready" } })
      const next = this.closed ? undefined : this.queue.shift()
      if (next) void this.runTurn(next)
    }
  }

  private injectSteers() {
    while (this.steered.length) {
      const s = this.steered.shift() as PromptInput
      this.messages.push(userMessage(s))
    }
  }

  private say(text: string, role: "assistant" | "thought" = "assistant") {
    const messageId = newId("msg")
    this.emit({ type: "message.delta", data: { messageId, role, text } })
    this.emit({ type: "message.completed", data: { messageId, role, text } })
  }

  // ───────────────────────────── context ─────────────────────────────

  /** Prompt size of the next request: the last reported input tokens + an estimate of what was added since. */
  private estimatePromptTokens(): number {
    const m = this.usageMark
    if (m && m.at <= this.messages.length) return m.tokens + estimateTokens(this.messages.slice(m.at))
    return estimateTokens(this.messages) + Math.ceil(this.system.length / 4)
  }

  private async manageContext(signal: AbortSignal) {
    const est = this.estimatePromptTokens()
    const limit = this.contextTokens
    if (est > limit * this.compactThreshold && (!this.compactFailedAt || est > this.compactFailedAt * 1.1)) await this.compact(est, signal)
    // hard guard (≈ 4 chars/token), also the fallback when summarising is impossible
    this.trim(limit * 4, "context trimmed")
  }

  private trim(budgetChars: number, what: string): boolean {
    const r = trimTranscript(this.messages, budgetChars)
    if (!r.trimmedOutputs && !r.droppedMessages) return false
    this.messages = r.messages
    this.usageMark = undefined
    this.ctx.log("info", `${what}: ${r.trimmedOutputs} tool outputs stubbed, ${r.droppedMessages} messages dropped`)
    return true
  }

  /** Replace the middle of the conversation with a model-written summary. */
  private async compact(estimate: number, signal: AbortSignal) {
    const limit = this.contextTokens
    const fallbackBudget = Math.floor(limit * this.compactThreshold * 0.8 * 4)
    const split = splitForCompaction(this.messages, this.compactKeep)
    if (!split) {
      this.compactFailedAt = estimate
      this.trim(fallbackBudget, "context near the limit, nothing to summarise; trimmed")
      return
    }
    try {
      const excerpt = renderForSummary(split.middle, Math.max(20_000, Math.floor(limit * 2)))
      const summary = await this.complete(COMPACTION_PROMPT, `Conversation excerpt to summarise:\n\n${excerpt}`, signal)
      if (!summary.trim()) throw new Error("empty summary")
      this.messages = [...split.head, summaryMessage(summary), ...split.tail]
      this.usageMark = undefined
      this.compactFailedAt = 0
      const after = this.estimatePromptTokens()
      this.ctx.log("info", `orch.note: context compacted — ${split.middle.length} messages summarised (~${estimate} → ~${after} tokens, limit ${limit})`)
      this.say("(context compacted)", "thought")
    } catch (e) {
      if (signal.aborted) return
      this.compactFailedAt = estimate
      this.ctx.log("warn", `context compaction failed (${errMsg(e)}); falling back to trimming`)
      this.trim(fallbackBudget, "context trimmed")
    }
  }

  /** One plain model call (no tools) — used for the compaction summary. Usage is counted. */
  private async complete(instructions: string, prompt: string, signal: AbortSignal): Promise<string> {
    // no providerOptions: e.g. a thinking budget larger than this call's output cap would fail it
    const result = streamText({
      model: this.resolved.model,
      instructions,
      messages: [{ role: "user", content: prompt }],
      abortSignal: signal,
      maxRetries: 1,
      maxOutputTokens: 4000,
      onError: () => {},
    })
    let text = ""
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text
      else if (part.type === "finish-step") this.addUsage(part.usage)
      else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error(errMsg(part.error))
    }
    return text
  }

  // ───────────────────────────── model step ─────────────────────────────

  private cachingOn(): boolean {
    return this.resolved.kind === "anthropic" && this.cfg.options?.promptCaching !== false
  }

  /** Anthropic: cache breakpoints on the system prompt and the last user/tool message (a per-step copy). */
  private requestMessages(): { instructions: string | SystemModelMessage; messages: ModelMessage[] } {
    if (!this.cachingOn()) return { instructions: this.system, messages: this.messages }
    const messages = [...this.messages]
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as ModelMessage
      if (m.role !== "user" && m.role !== "tool") continue
      messages[i] = { ...m, providerOptions: { ...(m.providerOptions ?? {}), ...ANTHROPIC_CACHE } } as ModelMessage
      break
    }
    return { instructions: { role: "system", content: this.system, providerOptions: ANTHROPIC_CACHE }, messages }
  }

  private async modelStep(signal: AbortSignal): Promise<StepResult> {
    const o = this.cfg.options ?? {}
    const sentLength = this.messages.length
    const req = this.requestMessages()
    const result = streamText({
      model: this.resolved.model,
      instructions: req.instructions,
      messages: req.messages,
      tools: this.modelTools,
      abortSignal: signal,
      maxRetries: 2,
      ...(typeof o.temperature === "number" ? { temperature: o.temperature } : {}),
      ...(typeof o.maxOutputTokens === "number" ? { maxOutputTokens: o.maxOutputTokens } : {}),
      ...(o.providerOptions && typeof o.providerOptions === "object" ? { providerOptions: o.providerOptions as never } : {}),
      onError: () => {}, // surfaced through the stream's error part
    })
    const open = new Map<string, { messageId: string; role: "assistant" | "thought"; text: string }>()
    const partialText: string[] = []
    const out: StepResult = { toolCalls: [] }
    const finish = (id: string) => {
      const m = open.get(id)
      if (!m) return
      open.delete(id)
      if (m.text) this.emit({ type: "message.completed", data: { messageId: m.messageId, role: m.role, text: m.text } })
    }
    const delta = (id: string, role: "assistant" | "thought", text: string) => {
      if (!text) return
      const key = `${role}:${id}`
      let m = open.get(key)
      if (!m) {
        m = { messageId: newId("msg"), role, text: "" }
        open.set(key, m)
      }
      m.text += text
      if (role === "assistant") partialText.push(text)
      this.emit({ type: "message.delta", data: { messageId: m.messageId, role, text } })
    }
    let streamError: unknown
    let stepInput: number | undefined
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "text-delta":
            delta(part.id, "assistant", part.text)
            break
          case "text-end":
            finish(`assistant:${part.id}`)
            break
          case "reasoning-delta":
            delta(part.id, "thought", part.text)
            break
          case "reasoning-end":
            finish(`thought:${part.id}`)
            break
          case "tool-call":
            out.toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              invalid: "invalid" in part ? part.invalid : undefined,
              error: "error" in part ? part.error : undefined,
            })
            break
          case "finish-step":
            out.finishReason = part.finishReason
            stepInput = this.addUsage(part.usage)
            break
          case "error":
            streamError = part.error
            break
        }
        if (streamError) break
      }
    } catch (e) {
      if (!signal.aborted) streamError = e
    } finally {
      for (const id of [...open.keys()]) finish(id)
    }
    if (signal.aborted) {
      void Promise.resolve(result.response).catch(() => {})
      // keep what the user already saw; drop half-made tool calls
      const text = partialText.join("")
      if (text) this.messages.push({ role: "assistant", content: text })
      return { toolCalls: [] }
    }
    if (streamError) {
      void Promise.resolve(result.response).catch(() => {})
      throw streamError instanceof Error ? streamError : new Error(errMsg(streamError))
    }
    const response = await result.response
    if (stepInput) this.usageMark = { tokens: stepInput, at: sentLength }
    this.messages.push(...response.messages)
    return out
  }

  /** Adds a step's usage to the session totals; returns its input tokens (incl. cache reads/writes). */
  private addUsage(
    u: Pick<LanguageModelUsage, "inputTokens" | "outputTokens"> & {
      inputTokenDetails?: Partial<LanguageModelUsage["inputTokenDetails"]>
      outputTokenDetails?: Partial<LanguageModelUsage["outputTokenDetails"]>
    },
  ): number {
    const input = u.inputTokens ?? 0
    const output = u.outputTokens ?? 0
    const cacheRead = u.inputTokenDetails?.cacheReadTokens ?? 0
    const cacheWrite = u.inputTokenDetails?.cacheWriteTokens ?? 0
    if (!input && !output) return 0
    this.usage.input += input
    this.usage.cachedInput += cacheRead
    this.usage.output += output
    this.usage.reasoning += u.outputTokenDetails?.reasoningTokens ?? 0
    this.usage.costUsd += costUsd(this.price, { input, cacheRead, cacheWrite, output })
    this.emit({ type: "usage.updated", data: { ...this.usage, source: "reported", mode: "cumulative" } })
    return input
  }

  // ───────────────────────────── tools ─────────────────────────────

  /** Read-only and not gated by an approval prompt → may run concurrently with its neighbours. */
  private parallelSafe(c: ToolCall): boolean {
    if (c.invalid) return false
    const b = this.builtins.get(c.toolName)
    if (b) return !!b.readOnly && !needsApproval(this.cfg.approval, b.category)
    return this.mcp.get(c.toolName)?.readOnly === true
  }

  private async runTools(calls: ToolCall[], signal: AbortSignal) {
    const runs: ToolRun[] = new Array(calls.length)
    const runOne = async (c: ToolCall): Promise<ToolRun> => {
      if (signal.aborted) return { part: toolResult(c, "Not run: the turn was interrupted.", true) }
      try {
        return await this.runTool(c, signal)
      } catch (e) {
        return { part: toolResult(c, `Tool failed: ${errMsg(e)}`, true) }
      }
    }
    let i = 0
    while (i < calls.length) {
      let j = i
      while (j < calls.length && this.parallelSafe(calls[j] as ToolCall)) j++
      if (j - i > 1) {
        // runTool emits tool.call synchronously before its first await → events stay in request order
        const batch = await Promise.all(calls.slice(i, j).map(runOne))
        batch.forEach((r, k) => {
          runs[i + k] = r
        })
        i = j
      } else {
        runs[i] = await runOne(calls[i] as ToolCall)
        i++
      }
    }
    this.messages.push({ role: "tool", content: runs.map((r) => r.part) })
    // providers without image support in tool results get the pictures as a user message
    const images = runs.filter((r) => r.image)
    if (images.length)
      this.messages.push({
        role: "user",
        content: images.flatMap((r) => [
          { type: "text" as const, text: `[image from ${r.image?.label}]` },
          { type: "file" as const, data: r.image?.image.data as string, mediaType: r.image?.image.mediaType as string },
        ]),
      })
  }

  private async runTool(c: ToolCall, signal: AbortSignal): Promise<ToolRun> {
    const id = newId("tc")
    const builtin = this.builtins.get(c.toolName)
    const mcp = this.mcp.get(c.toolName)
    if ((!builtin && !mcp) || c.invalid) {
      const why = !builtin && !mcp ? `Unknown tool "${c.toolName}".` : `Invalid arguments for ${c.toolName}: ${errMsg(c.error)}`
      this.emit({ type: "tool.call", data: { toolCallId: id, kind: "other", name: c.toolName, title: c.toolName, status: "pending", rawInput: c.input } })
      this.emit({ type: "tool.update", data: { toolCallId: id, status: "failed", summary: !builtin && !mcp ? "Unknown tool" : "Invalid input" } })
      return { part: toolResult(c, why, true) }
    }
    if (mcp) return { part: await this.runMcpTool(id, c, mcp, signal) }
    const t = builtin as AnyTool
    const parsed = t.schema.safeParse(c.input ?? {})
    if (!parsed.success) {
      this.emit({ type: "tool.call", data: { toolCallId: id, kind: t.kind, name: t.name, title: t.name, status: "pending", rawInput: c.input } })
      this.emit({ type: "tool.update", data: { toolCallId: id, status: "failed", summary: "Invalid input" } })
      return { part: toolResult(c, `Invalid arguments for ${t.name}: ${parsed.error.message}`, true) }
    }
    const input = parsed.data
    const title = t.title(input)
    let locations: { path: string; line?: number }[] | undefined
    try {
      locations = t.locations?.(input, this.ws)
    } catch {}
    this.emit({
      type: "tool.call",
      data: { toolCallId: id, kind: t.kind, name: t.name, title, status: "pending", rawInput: input, ...(locations ? { locations } : {}) },
    })

    // confinement first: an escaping path is refused before anyone is asked about it
    const pathArg = typeof input.path === "string" ? input.path : undefined
    if (pathArg !== undefined) {
      try {
        this.ws.resolve(pathArg)
      } catch (e) {
        this.emit({ type: "tool.update", data: { toolCallId: id, status: "failed", summary: "Refused: outside workspace" } })
        return { part: toolResult(c, `Refused: ${errMsg(e)}`, true) }
      }
    }

    const command = typeof input.command === "string" ? input.command : undefined
    const url = typeof input.url === "string" ? input.url : undefined
    if (needsApproval(this.cfg.approval, t.category, command)) {
      const allowed = await this.ask(id, title, t.kind, t.permissionKey(input), command ?? url ?? pathArg, signal)
      if (!allowed) {
        this.emit({ type: "tool.update", data: { toolCallId: id, status: "failed", summary: signal.aborted ? "Interrupted" : "Denied" } })
        return {
          part: toolResult(
            c,
            signal.aborted ? "Not run: the turn was interrupted." : "The user denied this tool call. Do not retry it; adjust your approach or ask.",
            true,
          ),
        }
      }
    }

    this.emit({ type: "tool.update", data: { toolCallId: id, status: "in_progress" } })
    let outcome: ToolOutcome
    try {
      outcome = await t.run(input, {
        ws: this.ws,
        signal,
        env: this.cfg.env ?? {},
        commandTimeoutMs: this.commandTimeoutMs,
        maxOutputChars: this.maxOutputChars,
        progress: (content) => this.emit({ type: "tool.update", data: { toolCallId: id, content } }),
        sandbox: t.category === "execute" ? this.currentSandbox() : undefined,
        vision: this.vision,
        allowPrivateFetch: this.cfg.options?.allowPrivateFetch === true,
      })
    } catch (e) {
      const refused = e instanceof PathEscapeError
      outcome = { output: refused ? `Refused: ${e.message}` : `Error: ${errMsg(e)}`, isError: true, summary: refused ? "Refused: outside workspace" : "Error" }
    }
    this.emit({
      type: "tool.update",
      data: {
        toolCallId: id,
        status: outcome.isError ? "failed" : "completed",
        ...(outcome.summary ? { summary: outcome.summary } : {}),
        ...(outcome.content ? { content: outcome.content } : outcome.isError ? { content: [{ type: "text" as const, text: outcome.output }] } : {}),
      },
    })
    const text = capOutput(outcome.output, this.maxOutputChars)
    if (outcome.image && !outcome.isError) {
      // Anthropic and OpenAI accept images inside tool results; OpenAI-compatible chat APIs don't
      if (this.resolved.kind === "anthropic" || this.resolved.kind === "openai")
        return {
          part: {
            type: "tool-result",
            toolCallId: c.toolCallId,
            toolName: c.toolName,
            output: {
              type: "content",
              value: [
                { type: "text", text },
                { type: "file", data: { type: "data", data: outcome.image.data }, mediaType: outcome.image.mediaType },
              ],
            },
          },
        }
      return { part: toolResult(c, `${text} (the image follows in the next message)`, false), image: { image: outcome.image, label: title } }
    }
    return { part: toolResult(c, text, !!outcome.isError) }
  }

  private async runMcpTool(id: string, c: ToolCall, e: McpEntry, signal: AbortSignal): Promise<ToolResultPart> {
    const name = `mcp__${e.server}__${e.tool}`
    const args = c.input && typeof c.input === "object" ? JSON.stringify(c.input) : ""
    const title = `${e.tool}${args && args !== "{}" ? ` ${oneLine(args, 70)}` : ""}`
    const kind: ToolKind = /spawn|delegate|send_message|assign/.test(e.tool) ? "delegate" : "other"
    this.emit({ type: "tool.call", data: { toolCallId: id, kind, name, title, status: "in_progress", rawInput: c.input } })
    const execute = (e.def as { execute?: (input: unknown, opts: unknown) => Promise<unknown> }).execute
    if (!execute) {
      this.emit({ type: "tool.update", data: { toolCallId: id, status: "failed", summary: "Not executable" } })
      return toolResult(c, `MCP tool ${e.tool} cannot be executed`, true)
    }
    try {
      const raw = await abortable(execute(c.input ?? {}, { toolCallId: c.toolCallId, messages: [], abortSignal: signal, context: undefined }), signal)
      const { text, isError } = mcpResultText(raw)
      const content: ToolContent[] = text ? [{ type: "text", text: capOutput(text, 8000) }] : []
      this.emit({
        type: "tool.update",
        data: { toolCallId: id, status: isError ? "failed" : "completed", summary: oneLine(text.split("\n")[0] ?? "", 60) || "Done", content },
      })
      return toolResult(c, capOutput(text || "(no output)", this.maxOutputChars), isError)
    } catch (err) {
      const msg = signal.aborted ? "Interrupted" : errMsg(err)
      this.emit({ type: "tool.update", data: { toolCallId: id, status: "failed", summary: oneLine(msg, 60) } })
      return toolResult(c, `MCP tool error: ${msg}`, true)
    }
  }

  /** Ask Baton; resolves true when allowed. Remembers allow_always / reject_always per tool+command. */
  private async ask(toolCallId: string, title: string, kind: ToolKind, key: string, detail: string | undefined, signal: AbortSignal): Promise<boolean> {
    const known = this.remembered.get(key)
    if (known) return known === "allow"
    if (signal.aborted) return false
    const requestId = newId("perm")
    const d = deferred<string | null>()
    this.pendingPerms.set(requestId, d)
    const onAbort = () => {
      if (this.pendingPerms.delete(requestId)) d.resolve(null)
    }
    signal.addEventListener("abort", onAbort, { once: true })
    this.emit({ type: "agent.status", data: { status: "awaiting_approval" } })
    // The daemon emits permission.resolved itself when it answers (runtime.resolvePermission), so we don't.
    this.emit({
      type: "permission.requested",
      data: { requestId, toolCallId, title, kind, ...(detail ? { detail } : {}), options: DEFAULT_PERMISSION_OPTIONS },
    })
    const optionId = await d.promise
    signal.removeEventListener("abort", onAbort)
    if (!signal.aborted) this.emit({ type: "agent.status", data: { status: "busy" } })
    const kindOf = DEFAULT_PERMISSION_OPTIONS.find((o) => o.optionId === optionId)?.kind ?? optionId
    if (kindOf === "allow_always") this.remembered.set(key, "allow")
    if (kindOf === "reject_always") this.remembered.set(key, "deny")
    return kindOf === "allow_once" || kindOf === "allow_always"
  }
}

// ───────────────────────────── helpers ─────────────────────────────

function userMessage(input: PromptInput): ModelMessage {
  const from = input.from && input.from !== "user" ? `[message from ${input.from}]\n` : ""
  return { role: "user", content: from + input.text }
}

function toolResult(c: { toolCallId: string; toolName: string }, text: string, isError: boolean): ToolResultPart {
  return { type: "tool-result", toolCallId: c.toolCallId, toolName: c.toolName, output: { type: isError ? "error-text" : "text", value: text } }
}

function mapFinish(r: FinishReason | undefined): string {
  switch (r) {
    case "length":
      return "max_tokens"
    case "content-filter":
      return "refusal"
    case "error":
      return "error"
    default:
      return "end_turn"
  }
}

function mcpResultText(raw: unknown): { text: string; isError: boolean } {
  if (typeof raw === "string") return { text: raw, isError: false }
  if (raw && typeof raw === "object") {
    const r = raw as { content?: unknown; isError?: unknown; toolResult?: unknown; structuredContent?: unknown }
    if (Array.isArray(r.content)) {
      const parts = r.content.map((p: { type?: string; text?: string; resource?: { text?: string; uri?: string } }) =>
        p.type === "text" ? (p.text ?? "") : p.type === "resource" ? (p.resource?.text ?? p.resource?.uri ?? "") : `[${p.type} content]`,
      )
      return { text: parts.join("\n"), isError: r.isError === true }
    }
    if (r.structuredContent !== undefined) return { text: JSON.stringify(r.structuredContent), isError: r.isError === true }
    if (r.toolResult !== undefined) return { text: JSON.stringify(r.toolResult), isError: r.isError === true }
  }
  return { text: JSON.stringify(raw) ?? "", isError: false }
}

function sanitizeToolName(n: string): string {
  return n.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
}

function oneLine(s: string, max = 80): string {
  const line = s.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === "string") return e
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`timed out ${what}`)), ms)))])
  } finally {
    clearTimeout(t)
  }
}

function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("interrupted"))
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("interrupted"))
    signal.addEventListener("abort", onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener("abort", onAbort)
        reject(e)
      },
    )
  })
}

export default nativeAdapter
