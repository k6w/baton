/**
 * The Baton runtime: owns the event store, the live run state, every agent session, the
 * bus (inboxes + delivery), the approval policy and budgets. Transport layers (control
 * socket, MCP server) are thin wrappers around this class.
 */

import { type BatonConfig, EventStore, gitInfo, projectName, RunState, resolveSecret } from "@batonsh/kernel"
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentInfo,
  type AgentSession,
  type BatonEvent,
  type BusKind,
  type Delivery,
  deferred,
  newId,
  type PermissionOption,
  type SpawnParams,
  type ToolKind,
} from "@batonsh/protocol"
import { Collaboration } from "./collab.ts"
import { identityBlock, loadPlaybook } from "./playbooks.ts"
import { PolicyEngine, pickOption } from "./policy.ts"
import { AdapterRegistry } from "./registry.ts"

export interface AgentRuntime {
  info: AgentInfo
  adapter: AgentAdapter
  caps: AdapterCapabilities
  session?: AgentSession
  token: string
  inbox: InboxMessage[]
  /** Agents waiting on this agent's next turn result (dispatchers). */
  resultTo: Set<string>
  /** Pending wait_for_results / read_inbox long-polls. */
  waiters: Set<() => void>
  /** Timestamps of auto-delivered prompts (loop protection). */
  deliveries: number[]
  lastProgressSent?: number
  lastAssistantText: string
  turnDiff: { added: number; removed: number }
  busy: boolean
  closing: boolean
  budgetWarned: boolean
}

export interface InboxMessage {
  messageId: string
  from: string
  fromName: string
  kind: BusKind
  body: string
  ts: number
}

export interface RuntimeOptions {
  projectRoot: string
  config: BatonConfig
  storePath?: string
  /** Base URL of the MCP server (set by the daemon once it's listening). */
  mcpBaseUrl?: string
}

const MAX_AUTO_DELIVERIES_PER_MIN = 20

export class Runtime {
  readonly store: EventStore
  readonly state = new RunState()
  readonly registry = new AdapterRegistry()
  readonly agents = new Map<string, AgentRuntime>()
  readonly policy: PolicyEngine
  runId: string
  config: BatonConfig
  mcpBaseUrl: string | undefined
  private counters = new Map<string, number>()
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private runWarned = false
  private closed = false
  readonly projectRoot: string
  readonly collab: Collaboration

  constructor(opts: RuntimeOptions) {
    this.projectRoot = opts.projectRoot
    this.config = opts.config
    this.mcpBaseUrl = opts.mcpBaseUrl
    this.store = new EventStore(opts.storePath ?? ":memory:")
    this.policy = new PolicyEngine(opts.config.policy.preset, opts.config.policy.rules)
    this.runId = this.store.createRun(opts.projectRoot)
    this.collab = new Collaboration(this)
    const git = gitInfo(opts.projectRoot)
    this.state.projectRoot = opts.projectRoot
    this.state.projectName = opts.config.project.name ?? projectName(opts.projectRoot)
    this.state.branch = git.branch
    this.store.subscribe((e) => this.state.apply(e))
    this.emit({ type: "run.started", data: { cwd: opts.projectRoot, mode: opts.config.orchestrator.mode } })
    if (opts.config.bus.heartbeat_s > 0) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), opts.config.bus.heartbeat_s * 1000)
      this.heartbeatTimer.unref?.()
    }
  }

  async init(): Promise<void> {
    await this.registry.loadBuiltins()
    for (const err of this.registry.loadErrors) this.emit({ type: "log", data: { level: "warn", message: `adapter load: ${err}` } })
  }

  emit(ev: AgentEvent, agentId?: string): BatonEvent {
    return this.store.append(this.runId, ev, { agentId })
  }

  // ───────────────────────────── agents ─────────────────────────────

  private allocateName(adapter: string, requested?: string): string {
    const taken = new Set([...this.agents.values()].filter((a) => !a.closing).map((a) => a.info.name.toLowerCase()))
    if (requested) {
      let name = requested.replace(/\s+/g, "-")
      let i = 2
      while (taken.has(name.toLowerCase())) name = `${requested}-${i++}`
      return name
    }
    const pattern = this.config.agent_style[adapter]?.name_pattern ?? "{adapter}-{n}"
    let n = this.counters.get(adapter) ?? 0
    let name: string
    do {
      n++
      name = pattern.replace("{adapter}", adapter).replace("{n}", String(n))
    } while (taken.has(name.toLowerCase()))
    this.counters.set(adapter, n)
    return name
  }

  /** Resolve a configured agent profile ("reviewer") or a raw adapter id ("codex"). */
  private resolveProfile(ref: string): { adapterId: string; profile?: BatonConfig["agents"][string] } {
    const profile = this.config.agents[ref]
    if (profile) return { adapterId: profile.adapter, profile }
    return { adapterId: ref }
  }

  async spawn(params: SpawnParams & { isOrchestrator?: boolean }): Promise<AgentInfo> {
    const { adapterId, profile } = this.resolveProfile(params.adapter)
    const adapter = this.registry.get(adapterId)
    if (!adapter)
      throw new Error(
        `unknown adapter "${adapterId}". Known: ${this.registry
          .list()
          .map((a) => a.id)
          .join(", ")}`,
      )
    const live = [...this.agents.values()].filter((a) => !a.closing).length
    if (!params.isOrchestrator && live >= this.config.budget.max_agents)
      throw new Error(`agent limit reached (${this.config.budget.max_agents}); raise budget.max_agents`)
    if (params.parentId) {
      let depth = 0
      let p: string | undefined = params.parentId
      while (p) {
        const parent = this.agents.get(p)
        if (!parent || parent.info.isOrchestrator) break
        depth++
        p = parent.info.parentId
      }
      if (depth >= this.config.budget.max_depth) throw new Error(`spawn depth limit reached (${this.config.budget.max_depth})`)
    }

    const agentId = newId("ag")
    const name = params.isOrchestrator ? "orchestrator" : this.allocateName(adapterId, params.name ?? (profile ? params.adapter : undefined))
    const detected = await this.registry.detect(adapterId)
    const approval = params.approval ?? profile?.approval ?? (params.isOrchestrator ? this.config.orchestrator.approval : this.config.defaults.approval)
    const model = params.model ?? profile?.model ?? (params.isOrchestrator ? this.config.orchestrator.model : undefined)
    const info: AgentInfo = {
      agentId,
      name,
      adapter: adapterId,
      role: params.role ?? profile?.role,
      model,
      cwd: params.cwd ?? this.projectRoot,
      version: detected?.version,
      approval,
      label: params.label ?? profile?.label,
      parentId: params.parentId,
      isOrchestrator: params.isOrchestrator,
    }
    const rt: AgentRuntime = {
      info,
      adapter,
      caps: adapter.capabilities(detected),
      token: newId("tok"),
      inbox: [],
      resultTo: new Set(),
      waiters: new Set(),
      deliveries: [],
      lastAssistantText: "",
      turnDiff: { added: 0, removed: 0 },
      busy: false,
      closing: false,
      budgetWarned: false,
    }
    this.agents.set(agentId, rt)
    this.emit({ type: "agent.spawned", data: info }, agentId)

    const peers = [...this.agents.values()].filter((a) => a !== rt && !a.closing).map((a) => a.info.name)
    const rolePrompt = info.role ? this.config.roles[info.role]?.prompt : undefined
    const playbook = loadPlaybook(params.isOrchestrator ? this.config.orchestrator.mode : "worker", this.projectRoot)
    const systemPrompt = [
      playbook,
      identityBlock({ name, adapter: adapterId, isOrchestrator: params.isOrchestrator, peers }),
      params.isOrchestrator ? this.config.orchestrator.instructions : undefined,
      params.isOrchestrator ? workspacePolicy(this.config) : undefined,
      rolePrompt ? `\n## Role: ${info.role}\n${rolePrompt}` : undefined,
    ]
      .filter(Boolean)
      .join("\n")

    const providerId = profile?.provider
    const providerCfg = providerId ? this.config.providers[providerId] : undefined
    const provider = providerCfg
      ? {
          id: providerId as string,
          kind: providerCfg.kind,
          baseUrl: providerCfg.base_url,
          apiKey: await resolveSecret(providerCfg.api_key),
          headers: providerCfg.headers,
        }
      : undefined

    // workers get their own git worktree; the orchestrator (and explicit cwd) work in place
    const isolation = params.isolation ?? (params.isOrchestrator || params.cwd ? "shared" : this.config.workspace.isolation)
    if (isolation === "worktree") info.cwd = await this.collab.prepare(rt, "worktree")
    else this.emit({ type: "workspace.created", data: { path: info.cwd, mode: "shared" } }, agentId)
    if (params.taskId) this.collab.assignTask(params.taskId, agentId)

    const ac = new AbortController()
    try {
      rt.session = await adapter.start(
        {
          agentId,
          name,
          cwd: info.cwd,
          model: model && providerCfg?.models?.[model] ? providerCfg.models[model] : model,
          provider,
          systemPrompt,
          mcpServers: this.mcpBaseUrl && rt.caps.mcp ? [{ name: "baton", url: `${this.mcpBaseUrl}/mcp/${rt.token}` }] : [],
          approval,
          env: { ...profile?.env, BATON_AGENT: name, BATON_AGENT_ID: agentId, BATON_PROJECT_ROOT: this.projectRoot },
          command: profile?.command,
          args: profile?.args,
          options: { ...profile?.options, ...params.options },
        },
        {
          signal: ac.signal,
          log: (level, message) => this.emit({ type: "log", data: { level, message: `[${name}] ${message}` } }, agentId),
          emit: (ev) => this.onAgentEvent(rt, ev),
        },
      )
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      this.emit({ type: "error", data: { message: `failed to start ${name}: ${message}`, fatal: true } }, agentId)
      this.emit({ type: "agent.exited", data: { code: null, reason: message } }, agentId)
      rt.closing = true
      void this.collab.remove(agentId)
      throw new Error(`failed to start ${name}: ${message}`)
    }
    if (this.state.agents.get(agentId)?.status === "starting") this.emit({ type: "agent.status", data: { status: "ready" } }, agentId)
    if (params.prompt) await this.promptAgent(agentId, params.prompt, { from: params.parentId ?? "user", expectResult: !!params.parentId })
    return info
  }

  /** Requests the runtime already resolved — adapters echo their own `permission.resolved`. */
  private resolvedRequests = new Set<string>()

  private onAgentEvent(rt: AgentRuntime, ev: AgentEvent) {
    if (this.closed) return
    const agentId = rt.info.agentId
    if (ev.type === "permission.resolved" && this.resolvedRequests.has(ev.data.requestId)) return
    let stored: BatonEvent
    try {
      stored = this.emit(ev, agentId)
    } catch (e) {
      this.emit({ type: "log", data: { level: "warn", message: `[${rt.info.name}] invalid event ${ev.type}: ${e instanceof Error ? e.message : e}` } }, agentId)
      return
    }
    switch (stored.type) {
      case "turn.started":
        rt.busy = true
        rt.lastAssistantText = ""
        rt.turnDiff = { added: 0, removed: 0 }
        break
      case "message.completed":
        if (stored.data.role === "assistant" && stored.data.text.trim()) rt.lastAssistantText = stored.data.text
        break
      case "tool.update":
        for (const c of stored.data.content ?? []) {
          if (c.type === "diff") {
            rt.turnDiff.added += c.added ?? 0
            rt.turnDiff.removed += c.removed ?? 0
          }
        }
        break
      case "turn.completed":
      case "turn.interrupted":
        rt.busy = false
        this.reportResult(rt, stored.type === "turn.interrupted" ? "interrupted" : stored.data.stopReason === "error" ? "failed" : "ok")
        queueMicrotask(() => this.flushInbox(rt))
        break
      case "agent.status":
        if (stored.data.status === "ready") {
          rt.busy = false
          queueMicrotask(() => this.flushInbox(rt))
        } else if (stored.data.status === "busy") rt.busy = true
        break
      case "permission.requested":
        this.routePermission(rt, stored.data.requestId, stored.data.title, stored.data.kind, stored.data.detail, stored.data.options)
        break
      case "usage.updated":
        this.checkBudget(rt)
        break
      case "error":
        if (/not logged in|authenticat|unauthori[sz]ed|\b401\b|invalid api key|please run \/login/i.test(stored.data.message)) this.authHint(rt)
        break
      case "agent.exited":
        rt.closing = true
        rt.busy = false
        for (const w of rt.waiters) w()
        this.policy.forgetAgent(agentId)
        break
    }
    this.collab.onEvent(rt, stored)
  }

  private authHinted = new Set<string>()

  /** One actionable note per adapter when it fails on authentication. */
  private authHint(rt: AgentRuntime) {
    if (this.authHinted.has(rt.info.adapter)) return
    this.authHinted.add(rt.info.adapter)
    void this.registry.detect(rt.info.adapter).then((d) => {
      const hint = d?.authHint ?? `log in to ${rt.info.adapter} in a terminal`
      const others = ["codex", "claude", "opencode", "gemini", "cursor"].filter((a) => a !== rt.info.adapter)
      const switchHint = rt.info.isOrchestrator
        ? ` — or use another orchestrator: set [orchestrator] agent = "${others[0]}" in .baton/config.toml, or start with --orchestrator ${others[0]}`
        : ""
      this.emit({ type: "orch.note", data: { level: "warn", text: `${rt.info.adapter} is not authenticated: ${hint}${switchHint}` } }, rt.info.agentId)
    })
  }

  /**
   * Send input to an agent. `expectResult` (default: the sender dispatched work — i.e. it is
   * the orchestrator or the agent's parent) makes the agent's next turn result flow back to
   * the sender as a `result` bus message.
   */
  async promptAgent(agentId: string, text: string, opts: { from?: string; delivery?: Delivery; expectResult?: boolean } = {}): Promise<void> {
    const rt = this.agents.get(agentId)
    if (!rt?.session || rt.closing) throw new Error(`agent ${agentId} is not running`)
    const fromAgent = opts.from ? this.agents.get(opts.from) : undefined
    const dispatcher = !!fromAgent && (fromAgent.info.isOrchestrator || rt.info.parentId === fromAgent.info.agentId)
    if (fromAgent && (opts.expectResult ?? dispatcher)) rt.resultTo.add(fromAgent.info.agentId)
    const input = { text, from: fromAgent?.info.name ?? opts.from }
    const delivery = opts.delivery ?? "queue"
    if (delivery === "interrupt" && rt.busy) {
      await rt.session.interrupt()
      await rt.session.prompt(input)
    } else if (delivery === "steer" && rt.busy && rt.caps.steer && rt.session.steer) {
      await rt.session.steer(input)
    } else {
      await rt.session.prompt(input)
    }
  }

  async interrupt(agentId: string): Promise<void> {
    const rt = this.agents.get(agentId)
    if (!rt?.session) return
    await rt.session.interrupt()
  }

  async kill(agentId: string): Promise<void> {
    const rt = this.agents.get(agentId)
    if (!rt || rt.closing) return
    rt.closing = true
    try {
      await Promise.race([rt.session?.close(), new Promise((r) => setTimeout(r, 5000))])
    } catch {}
    if (this.state.agents.get(agentId)?.status !== "exited") this.emit({ type: "agent.exited", data: { code: 0, reason: "killed" } }, agentId)
    await this.collab.remove(agentId)
  }

  rename(agentId: string, name?: string, label?: string) {
    const rt = this.agents.get(agentId)
    if (!rt) return
    if (name) rt.info.name = this.allocateName(rt.info.adapter, name)
    if (label !== undefined) rt.info.label = label
    this.emit({ type: "agent.updated", data: { name: rt.info.name, label: rt.info.label } }, agentId)
  }

  findAgent(ref: string): AgentRuntime | undefined {
    const clean = ref.replace(/^@/, "")
    if (clean === "orchestrator" || clean === "lead") {
      const o = this.orchestrator()
      if (o) return o
    }
    const v = this.state.findAgent(clean)
    return v ? this.agents.get(v.agentId) : undefined
  }

  orchestrator(): AgentRuntime | undefined {
    for (const a of this.agents.values()) if (a.info.isOrchestrator && !a.closing) return a
    return undefined
  }

  async ensureOrchestrator(): Promise<AgentRuntime> {
    const existing = this.orchestrator()
    if (existing) return existing
    if (!this.config.orchestrator.enabled) throw new Error("orchestrator is disabled (orchestrator.enabled = false)")
    const info = await this.spawn({ adapter: this.config.orchestrator.agent, isOrchestrator: true, label: this.config.orchestrator.mode })
    return this.agents.get(info.agentId) as AgentRuntime
  }

  // ───────────────────────────── bus ─────────────────────────────

  /** Resolve a bus address to agent runtimes. */
  resolveRecipients(to: string, from?: string): AgentRuntime[] {
    const live = [...this.agents.values()].filter((a) => !a.closing)
    if (to === "*" || to === "all") return live.filter((a) => a.info.agentId !== from)
    if (to.startsWith("role:")) return live.filter((a) => a.info.role === to.slice(5))
    if (to.startsWith("adapter:")) return live.filter((a) => a.info.adapter === to.slice(8))
    const one = this.findAgent(to)
    return one ? [one] : []
  }

  /** Send a bus message. Returns the message id; throws if nobody matches `to`. */
  send(params: { from: string; to: string; body: string; kind?: BusKind; delivery?: Delivery; replyTo?: string }): string {
    const sender = this.agents.get(params.from)
    const fromName = sender?.info.name ?? params.from
    const kind = params.kind ?? "chat"
    const recipients = this.resolveRecipients(params.to, params.from)
    if (recipients.length === 0) throw new Error(`no agent matches "${params.to}"`)
    if (this.config.bus.contact === "tree" && sender && !sender.info.isOrchestrator) {
      for (const r of recipients) {
        const ok =
          r.info.isOrchestrator ||
          r.info.parentId === sender.info.agentId ||
          sender.info.parentId === r.info.agentId ||
          r.info.parentId === sender.info.parentId
        if (!ok) throw new Error(`bus.contact = "tree": ${fromName} may not message ${r.info.name}`)
      }
    }
    const body = params.body.length > this.config.bus.max_body ? `${params.body.slice(0, this.config.bus.max_body)}… [truncated]` : params.body
    const messageId = newId("msg")
    const toLabel = recipients.length === 1 ? (recipients[0] as AgentRuntime).info.agentId : params.to
    this.emit({
      type: "bus.message",
      data: { messageId, from: sender?.info.agentId ?? params.from, to: toLabel, kind, body, delivery: params.delivery ?? "queue", replyTo: params.replyTo },
    })
    if (kind === "heartbeat" || kind === "progress") return messageId
    for (const r of recipients) this.deliver(r, { messageId, from: params.from, fromName, kind, body, ts: Date.now() }, params.delivery ?? "queue")
    return messageId
  }

  private formatForAgent(msgs: InboxMessage[]): string {
    if (msgs.length === 1) {
      const m = msgs[0] as InboxMessage
      if (m.from === "user") return m.body
      return `[baton] ${m.kind === "result" ? "Result" : "Message"} from ${m.fromName}:\n${m.body}\n\n(Reply with the baton send_message tool, to: "${m.fromName}".)`
    }
    return `[baton] ${msgs.length} messages:\n\n${msgs.map((m) => `— from ${m.fromName} (${m.kind}):\n${m.body}`).join("\n\n")}\n\n(Reply with the baton send_message tool.)`
  }

  private deliver(rt: AgentRuntime, msg: InboxMessage, delivery: Delivery) {
    if (!rt.session) {
      rt.inbox.push(msg)
      return
    }
    // A pending wait_for_results / read_inbox long-poll consumes messages directly.
    if (rt.waiters.size > 0) {
      rt.inbox.push(msg)
      for (const w of [...rt.waiters]) w()
      return
    }
    const text = this.formatForAgent([msg])
    const from = msg.from
    // requests expect an answer; results/replies never trigger another result
    const expectResult = msg.kind === "request" ? true : msg.kind === "result" || msg.kind === "reply" ? false : undefined
    if (rt.busy) {
      if (delivery === "interrupt") {
        void this.promptAgent(rt.info.agentId, text, { from, delivery: "interrupt", expectResult }).then(() =>
          this.markDelivered(msg.messageId, rt, "interrupt"),
        )
        return
      }
      if (delivery === "steer" && rt.caps.steer) {
        void this.promptAgent(rt.info.agentId, text, { from, delivery: "steer", expectResult }).then(() => this.markDelivered(msg.messageId, rt, "steer"))
        return
      }
      rt.inbox.push(msg)
      return
    }
    if (!this.allowAutoDelivery(rt)) {
      rt.inbox.push(msg)
      return
    }
    void this.promptAgent(rt.info.agentId, text, { from, expectResult }).then(() => this.markDelivered(msg.messageId, rt, "prompt"))
  }

  private allowAutoDelivery(rt: AgentRuntime): boolean {
    const now = Date.now()
    rt.deliveries = rt.deliveries.filter((t) => now - t < 60_000)
    if (rt.deliveries.length >= MAX_AUTO_DELIVERIES_PER_MIN) {
      this.emit({ type: "orch.note", data: { text: `${rt.info.name}: message rate limit hit — holding messages in inbox`, level: "warn" } }, rt.info.agentId)
      return false
    }
    rt.deliveries.push(now)
    return true
  }

  private markDelivered(messageId: string, rt: AgentRuntime, via: string) {
    this.emit({ type: "bus.delivered", data: { messageId, to: rt.info.agentId, via } })
  }

  private flushInbox(rt: AgentRuntime) {
    if (rt.busy || rt.closing || !rt.session || rt.inbox.length === 0 || rt.waiters.size > 0) return
    if (!this.allowAutoDelivery(rt)) return
    const msgs = rt.inbox.splice(0)
    const only = msgs.length === 1 ? (msgs[0] as InboxMessage) : undefined
    const expectResult = only ? (only.kind === "request" ? true : only.kind === "result" || only.kind === "reply" ? false : undefined) : false
    void this.promptAgent(rt.info.agentId, this.formatForAgent(msgs), { from: only?.from, expectResult }).then(() => {
      for (const m of msgs) this.markDelivered(m.messageId, rt, "prompt")
    })
  }

  drainInbox(agentId: string): InboxMessage[] {
    const rt = this.agents.get(agentId)
    if (!rt) return []
    const msgs = rt.inbox.splice(0)
    for (const m of msgs) this.markDelivered(m.messageId, rt, "inbox")
    return msgs
  }

  /** Long-poll for inbox messages (used by wait_for_results / read_inbox). */
  async waitInbox(agentId: string, timeoutMs: number, until?: (inbox: InboxMessage[]) => boolean): Promise<InboxMessage[]> {
    const rt = this.agents.get(agentId)
    if (!rt) return []
    const ready = () => rt.inbox.length > 0 && (!until || until(rt.inbox))
    if (!ready()) {
      const d = deferred<void>()
      const w = () => {
        if (ready() || rt.closing) d.resolve()
      }
      rt.waiters.add(w)
      const t = setTimeout(() => d.resolve(), timeoutMs)
      await d.promise
      clearTimeout(t)
      rt.waiters.delete(w)
    }
    return this.drainInbox(agentId)
  }

  private reportResult(rt: AgentRuntime, outcome: "ok" | "failed" | "interrupted") {
    this.collab.onResult(rt, outcome)
    if (rt.resultTo.size === 0) return
    const targets = [...rt.resultTo]
    rt.resultTo.clear()
    const diff = rt.turnDiff.added || rt.turnDiff.removed ? ` (+${rt.turnDiff.added} −${rt.turnDiff.removed})` : ""
    const text = rt.lastAssistantText.trim() || "(no summary)"
    const ws = this.collab.workspaces.byAgent.get(rt.info.agentId)
    const where =
      ws?.mode === "worktree" && (rt.turnDiff.added || rt.turnDiff.removed)
        ? `\n[changes are in ${rt.info.name}'s own worktree — call merge("${rt.info.name}") to bring them into the project]`
        : ""
    const body = `result ${outcome}${diff}\n${text.length > 4000 ? `${text.slice(0, 4000)}…` : text}${where}`
    for (const t of targets) {
      if (!this.agents.get(t) || this.agents.get(t)?.closing) continue
      try {
        this.send({ from: rt.info.agentId, to: t, body, kind: "result", delivery: "queue" })
      } catch {}
    }
  }

  private heartbeat() {
    for (const rt of this.agents.values()) {
      if (rt.closing || rt.info.isOrchestrator || !rt.busy) continue
      const target = rt.info.parentId ?? this.orchestrator()?.info.agentId
      if (!target) continue
      const view = this.state.agents.get(rt.info.agentId)
      const pct = view?.progress !== undefined ? Math.round(view.progress * 100) : undefined
      const kind: BusKind = pct !== undefined && pct !== rt.lastProgressSent ? "progress" : "heartbeat"
      if (kind === "progress") rt.lastProgressSent = pct
      try {
        this.send({ from: rt.info.agentId, to: target, body: kind === "progress" ? `${pct}% done` : "heartbeat", kind })
      } catch {}
    }
  }

  // ───────────────────────────── approvals ─────────────────────────────

  private routePermission(
    rt: AgentRuntime,
    requestId: string,
    title: string,
    kind: ToolKind | undefined,
    detail: string | undefined,
    options: PermissionOption[],
  ) {
    const req = { agentId: rt.info.agentId, agentName: rt.info.name, adapter: rt.info.adapter, title, kind, detail }
    const decision = this.policy.decide(req)
    if (decision === "ask") {
      const timeout = this.config.policy.timeout_s
      if (timeout > 0) {
        setTimeout(() => {
          if (this.state.approvals.has(requestId))
            void this.resolvePermission(rt.info.agentId, requestId, pickOption(options, "deny")?.optionId ?? null, "timeout")
        }, timeout * 1000).unref?.()
      }
      return
    }
    const opt = pickOption(options, decision)
    queueMicrotask(() => void this.resolvePermission(rt.info.agentId, requestId, opt?.optionId ?? null, "policy"))
  }

  async resolvePermission(agentId: string, requestId: string, optionId: string | null, by: "user" | "policy" | "timeout" | "cancelled" = "user") {
    const rt = this.agents.get(agentId)
    const pending = this.state.approvals.get(requestId)
    if (!rt?.session || !pending) return
    const opt = pending.options.find((o) => o.optionId === optionId)
    if (opt && (opt.kind === "allow_always" || opt.kind === "reject_always")) {
      this.policy.remember(
        { agentId, agentName: rt.info.name, adapter: rt.info.adapter, title: pending.title, kind: pending.kind, detail: pending.detail },
        opt.kind,
      )
    }
    this.resolvedRequests.add(requestId)
    if (this.resolvedRequests.size > 5000) this.resolvedRequests.delete(this.resolvedRequests.values().next().value as string)
    this.emit({ type: "permission.resolved", data: { requestId, optionId, kind: opt?.kind ?? null, by } }, agentId)
    try {
      await rt.session.respondPermission(requestId, optionId)
    } catch (e) {
      this.emit({ type: "log", data: { level: "warn", message: `respondPermission failed: ${e instanceof Error ? e.message : e}` } }, agentId)
    }
  }

  // ───────────────────────────── budget ─────────────────────────────

  private checkBudget(rt: AgentRuntime) {
    const b = this.config.budget
    const view = this.state.agents.get(rt.info.agentId)
    if (b.per_agent_usd && view) {
      const used = view.usage.costUsd
      if (used >= b.per_agent_usd) {
        this.emit({ type: "budget.exceeded", data: { scope: rt.info.name, usedUsd: used, limitUsd: b.per_agent_usd } }, rt.info.agentId)
        void this.interrupt(rt.info.agentId)
      } else if (!rt.budgetWarned && used >= b.per_agent_usd * b.warn_at) {
        rt.budgetWarned = true
        this.emit({ type: "budget.warn", data: { scope: rt.info.name, usedUsd: used, limitUsd: b.per_agent_usd } }, rt.info.agentId)
      }
    }
    if (b.run_usd) {
      const used = this.state.totals.costUsd
      if (used >= b.run_usd) {
        this.emit({ type: "budget.exceeded", data: { scope: "run", usedUsd: used, limitUsd: b.run_usd } })
        for (const a of this.agents.values()) if (a.busy) void this.interrupt(a.info.agentId)
      } else if (!this.runWarned && used >= b.run_usd * b.warn_at) {
        this.runWarned = true
        this.emit({ type: "budget.warn", data: { scope: "run", usedUsd: used, limitUsd: b.run_usd } })
      }
    }
  }

  setMode(mode: string) {
    this.emit({ type: "orch.mode", data: { mode } })
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    await Promise.all([...this.agents.keys()].map((id) => this.kill(id)))
    this.emit({ type: "run.ended", data: { reason: "shutdown" } })
    this.closed = true
    this.store.close()
  }
}

function workspacePolicy(c: BatonConfig): string {
  const w = c.workspace
  const lines = ["\n## Project settings"]
  lines.push(
    w.isolation === "worktree"
      ? "- Workers get their own worktree; nothing lands until you merge(agent)."
      : "- isolation = shared: workers edit the project directly (no merge step) — keep their files disjoint.",
  )
  if (w.review === "required") lines.push("- Reviews are REQUIRED: merge refuses until a reviewer approves the current changes (request_review).")
  else if (w.review === "suggested") lines.push("- Get a cross-vendor review (request_review) before merging non-trivial changes.")
  if (w.verify) lines.push(`- Merges run \`${w.verify}\` in the worktree first; failures block the merge.`)
  if (c.orchestrator.plan_approval) lines.push("- The user approves plans: call plan_tasks before spawning workers and wait for the verdict.")
  return lines.join("\n")
}
