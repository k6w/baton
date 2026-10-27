/**
 * The Baton runtime: owns the event store, the live run state, every agent session, the
 * bus (inboxes + delivery), the approval policy and budgets. Transport layers (control
 * socket, MCP server) are thin wrappers around this class.
 */

import {
  type BatonConfig,
  EventStore,
  gitInfo,
  loadRoles,
  loadSkills,
  notesBlock,
  projectName,
  type Role,
  RunState,
  readSkill,
  resolveSecret,
  type Skill,
} from "@batonsh/kernel"
import {
  type AdapterCapabilities,
  type AgentAdapter,
  type AgentEvent,
  type AgentInfo,
  type AgentSession,
  type ApprovalMode,
  type BatonEvent,
  type BusKind,
  type Delivery,
  deferred,
  newId,
  type PermissionOption,
  runCapture,
  type SpawnParams,
  shellCommand,
  type ToolContent,
  type ToolKind,
} from "@batonsh/protocol"
import { Collaboration } from "./collab.ts"
import { identityBlock, loadPlaybook } from "./playbooks.ts"
import { type Autonomy, PolicyEngine, pickOption } from "./policy.ts"
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
  /** Watchdog bookkeeping. */
  lastEventAt: number
  lastToolTitle?: string
  toolRepeats: number
  flagged?: "stalled" | "looping"
  lastAssistantText: string
  turnDiff: { added: number; removed: number }
  /** "toolCallId|path" → that edit's stats (updates repeat a tool's content: count each once). */
  turnEdits: Map<string, { added: number; removed: number }>
  /** Why the last turn failed, when Baton knows better than the agent's own summary. */
  failReason?: string
  /** Acceptance check outcome to append to the next result. */
  acceptanceNote?: string
  /** Failed acceptance checks in a row (the worker gets two more tries). */
  acceptanceTries?: number
  busy: boolean
  closing: boolean
  budgetWarned: boolean
  /** Per-agent budget exceeded: no new prompts until the budget is raised. */
  budgetStopped?: boolean
  /** Blocking baton tool calls in flight (wait_for_results, plan_tasks, asks) — not a stall. */
  blocked: number
  /** Tool calls started but not finished (long commands aren't stalls either). */
  openTools: Set<string>
  /** Retry timer for messages held back by the delivery rate limit. */
  flushTimer?: ReturnType<typeof setTimeout>
  /** Approval the agent would have without a run-wide autonomy override. */
  baseApproval: ApprovalMode
  /** agent.exited side effects (results, tasks, workspace) — started once, awaited by kill(). */
  exitHandled?: Promise<void>
  /** Running commands' latest output: shown live (throttled), stored once with the result. */
  liveOutput: Map<string, { content: ToolContent; dirty: boolean; timer?: ReturnType<typeof setTimeout> }>
}

/** How often a running command's output is sent to the screen. */
const LIVE_OUTPUT_MS = 250

type ToolUpdate = Extract<AgentEvent, { type: "tool.update" }>["data"]

/**
 * A running command's output so far — nothing else. Agents send one per chunk with all the
 * output yet; storing each made logs of gigabytes, so these are shown live and not stored.
 */
function isOutputProgress(d: ToolUpdate): boolean {
  return (
    (d.status === undefined || d.status === "in_progress") &&
    !d.title &&
    !d.summary &&
    d.content?.length === 1 &&
    d.content[0]!.type === "terminal" &&
    // native and ACP agents say "still running" with exitCode: null
    d.content[0]!.exitCode == null
  )
}

export interface InboxMessage {
  messageId: string
  from: string
  fromName: string
  kind: BusKind
  body: string
  ts: number
  /** Doesn't start a turn or end a wait: read along with the next real message (acks, chatter). */
  quiet?: boolean
}

export interface RuntimeOptions {
  projectRoot: string
  config: BatonConfig
  storePath?: string
  /** Base URL of the MCP server (set by the daemon once it's listening). */
  mcpBaseUrl?: string
}

const MAX_AUTO_DELIVERIES_PER_MIN = 20
/** How long an adapter that ran out of quota is kept out of new spawns. */
const QUOTA_COOLDOWN_MS = 30 * 60_000
/** Worker↔worker chat messages within PAIR_WINDOW_MS before further ones stop waking the other side. */
const MAX_PAIR_CHAT = 6
const PAIR_WINDOW_MS = 5 * 60_000

const ACK =
  /^(?:ok(?:ay)?|thanks?(?: you)?|thx|ty|ack(?:nowledged)?|got it|received|noted|confirmed|understood|great|perfect|sounds good|all good|closing (?:this )?out|closed out|nothing further|no further action)\b/i

/** A message that needs no answer: "Thanks, acknowledged." / "Got it — closing out." */
/** Out of quota / credits / plan usage: retrying won't help for a long while. */
const QUOTA =
  /usage (?:limit|exceeded|cap)|free usage|quota|insufficient[_ ]?(?:quota|credits?|balance|funds)|credit balance|out of credits|billing|payment required|\b402\b|subscribe to|upgrade your plan|usage_limit|resource[_ ]exhausted/i

export function isQuotaError(text: string): boolean {
  return QUOTA.test(text)
}

export function isAck(body: string): boolean {
  const t = body.trim()
  return t.length <= 160 && !t.includes("?") && ACK.test(t)
}

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
  /** "a|b" (sorted agent ids) → timestamps of chat between two workers. */
  private pairChat = new Map<string, number[]>()
  private heartbeatTimer?: ReturnType<typeof setInterval>
  private watchdogTimer?: ReturnType<typeof setInterval>
  private runWarned = false
  /** Run budget exceeded: no new prompts or auto-deliveries until the budget is raised. */
  private runStopped = false
  /** Run-wide autonomy (normal = per-agent settings). */
  autonomy: Autonomy = "normal"
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
    if (opts.config.policy.autonomy !== "normal") {
      this.autonomy = opts.config.policy.autonomy
      this.policy.setAutonomy(this.autonomy)
      this.emit({ type: "run.autonomy", data: { mode: this.autonomy } })
    }
    this.watchdogTimer = setInterval(() => this.watchdog(), 30_000)
    this.watchdogTimer.unref?.()
    if (opts.config.bus.heartbeat_s > 0) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), opts.config.bus.heartbeat_s * 1000)
      this.heartbeatTimer.unref?.()
    }
  }

  async init(): Promise<void> {
    await this.registry.loadBuiltins()
    // warm the detect cache in the background (welcome screen, /agents, spawn defaults)
    void this.registry.detectAll().catch(() => {})
    for (const err of this.registry.loadErrors) this.emit({ type: "log", data: { level: "warn", message: `adapter load: ${err}` } })
  }

  emit(ev: AgentEvent, agentId?: string): BatonEvent {
    return this.store.append(this.runId, ev, { agentId })
  }

  // ───────────────────────────── agents ─────────────────────────────

  private allocateName(adapter: string, requested?: string, self?: AgentRuntime): string {
    const taken = new Set([...this.agents.values()].filter((a) => !a.closing && a !== self).map((a) => a.info.name.toLowerCase()))
    // reserved addresses on the bus
    for (const r of ["orchestrator", "lead", "user", "baton", "all"]) taken.add(r)
    if (requested) {
      requested = requested.trim().replace(/^@/, "").replace(/\s+/g, "-") || adapter
      let name = requested
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
  /** Roles and skills, read fresh (cheap: a few small files) so edits apply to the next spawn. */
  /** Switched off in [features] → empty, so nothing offers or applies them. */
  roles() {
    return this.config.features.roles ? loadRoles(this.projectRoot, this.config) : new Map<string, Role>()
  }

  skills() {
    return this.config.features.skills ? loadSkills(this.projectRoot, this.config) : new Map<string, Skill>()
  }

  /** The skills section of a worker's instructions: a menu (load_skill) or, without the bus, the full text. */
  private skillsBlock(names: string[], inline: boolean): string {
    const catalog = this.skills()
    const list = names.map((n) => catalog.get(n)).filter((x): x is Skill => !!x)
    if (inline) {
      let text = "\n## Skills\n"
      for (const s of list) {
        const body = readSkill(s)
        if (text.length + body.length > 24_000) break
        text += `\n${body}\n`
      }
      return text
    }
    return `\n## Skills\nYou have these skills. Load one with the load_skill tool before you start the part of the work it covers:\n${list.map((s) => `- ${s.name}: ${s.description}`).join("\n")}`
  }

  private resolveProfile(ref: string): { adapterId: string; profile?: BatonConfig["agents"][string] } {
    const profile = this.config.agents[ref]
    if (profile) return { adapterId: profile.adapter, profile }
    return { adapterId: ref }
  }

  async spawn(
    params: SpawnParams & {
      isOrchestrator?: boolean
      /** Native session id to resume (history → resume). */
      resumeId?: string
      /** Re-attach an existing worktree instead of creating one. */
      adoptWorkspace?: { path: string; branch?: string; base?: string }
    },
  ): Promise<AgentInfo> {
    // a role supplies defaults (adapter, model, tier, access, acceptance, skills); explicit params win
    const role = params.role && !params.isOrchestrator ? this.roles().get(params.role.toLowerCase()) : undefined
    const adapterRef = params.adapter || role?.adapter || this.config.defaults.worker
    const { adapterId, profile } = this.resolveProfile(adapterRef)
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
    const name = params.isOrchestrator ? "orchestrator" : this.allocateName(adapterId, params.name ?? (profile ? adapterRef : undefined))
    let detected = await this.registry.detect(adapterId)
    // fail fast and clearly instead of starting a session that dies with "Not logged in" (a profile
    // with its own env / provider brings its own credentials)
    // (also: an adapter that just ran out of quota)
    if ((detected?.auth === "missing" || this.registry.cooling(adapterId)) && !profile?.env && !profile?.provider) {
      const why = await this.registry.unusable(adapterId)
      if (why) {
        const others = (await this.registry.detectAll())
          .filter((d) => d.installed && d.auth !== "missing" && !this.registry.cooling(d.id) && d.id !== adapterId && d.id !== "mock" && d.id !== "a2a")
          .map((d) => d.id)
        throw new Error(`${why}${others.length ? `. Ready to use: ${others.join(", ")}` : ""}`)
      }
      detected = await this.registry.detect(adapterId)
    }
    const access = params.access ?? role?.access ?? "write"
    const baseApproval = params.approval ?? profile?.approval ?? (params.isOrchestrator ? this.config.orchestrator.approval : this.config.defaults.approval)
    const approval = capApproval(effectiveApproval(baseApproval, this.autonomy), access)
    const tier = params.tier ?? role?.tier
    const tierModel = tier ? this.config.routing[adapterId]?.[tier] : undefined
    // defaults.model belongs to the default worker's agent: other agents keep their own default
    const workerModel = !params.isOrchestrator && adapterRef === this.config.defaults.worker ? this.config.defaults.model : undefined
    const model =
      params.model ?? role?.model ?? profile?.model ?? tierModel ?? (params.isOrchestrator ? this.config.orchestrator.model : workerModel || undefined)
    // skills: the role's plus any asked for; unknown names are reported, not fatal
    const catalog = this.skills()
    const wanted = [...new Set([...(role?.skills ?? []), ...(params.skills ?? [])].map((x) => x.toLowerCase()))]
    const skills = wanted.filter((x) => catalog.has(x))
    const missingSkills = wanted.filter((x) => !catalog.has(x))
    const acceptance = this.config.features.acceptance ? params.acceptance?.trim() || role?.acceptance?.trim() || undefined : undefined
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
      ...(skills.length ? { skills } : {}),
      ...(access === "read-only" ? { access } : {}),
      ...(acceptance ? { acceptance } : {}),
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
      turnEdits: new Map(),
      busy: false,
      closing: false,
      budgetWarned: false,
      baseApproval,
      lastEventAt: Date.now(),
      toolRepeats: 0,
      blocked: 0,
      openTools: new Set(),
      liveOutput: new Map(),
    }
    this.agents.set(agentId, rt)
    this.policy.setAccess(agentId, access)
    this.emit({ type: "agent.spawned", data: info }, agentId)
    if (missingSkills.length)
      this.emit({ type: "log", data: { level: "warn", message: `[${name}] unknown skills: ${missingSkills.join(", ")} (baton skills lists them)` } }, agentId)

    const peers = [...this.agents.values()].filter((a) => a !== rt && !a.closing).map((a) => a.info.name)
    const rolePrompt = role?.prompt || (info.role && this.config.features.roles ? this.config.roles[info.role]?.prompt : undefined)
    const playbook = loadPlaybook(params.isOrchestrator ? this.config.orchestrator.mode : "worker", this.projectRoot, this.config.features)
    // agents that can't reach Baton's bus (no MCP: remote A2A agents, plain CLIs) get a short brief
    // instead of a playbook full of tools they don't have
    const busless = !rt.caps.mcp && !params.isOrchestrator
    const systemPrompt = [
      busless
        ? `You are "${name}", one of several coding agents working on this project in a Baton session. Do the task you are given, then finish with a short summary of what you changed and how you verified it.`
        : playbook,
      busless ? undefined : identityBlock({ name, adapter: adapterId, isOrchestrator: params.isOrchestrator, peers }),
      params.isOrchestrator ? this.config.orchestrator.instructions : undefined,
      params.isOrchestrator ? workspacePolicy(this.config) : undefined,
      rolePrompt ? `\n## Your role: ${info.role}\n${rolePrompt}` : undefined,
      access === "read-only"
        ? "\n## Read-only\nYou may read files and run commands, but not edit files: Baton refuses your edits. Report what should change instead."
        : undefined,
      params.instructions?.trim() ? `\n## Instructions for you\n${params.instructions.trim()}` : undefined,
      acceptance
        ? `\n## Done means\nBaton runs \`${acceptance}\` in your workspace when you finish; your result counts only if it passes. Run it yourself before you report.`
        : undefined,
      skills.length ? this.skillsBlock(skills, busless) : undefined,
      this.config.features.notes ? notesBlock(this.projectRoot, this.config.notes.max) : undefined,
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
    if (params.adoptWorkspace) info.cwd = this.collab.adopt(rt, params.adoptWorkspace)
    else if (isolation === "worktree") {
      try {
        info.cwd = await this.collab.prepare(rt, "worktree")
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        rt.closing = true
        this.emit({ type: "error", data: { message: `workspace for ${name}: ${message}`, fatal: true } }, agentId)
        this.emit({ type: "agent.exited", data: { code: null, reason: message } }, agentId)
        await this.onExited(rt, message)
        throw new Error(`could not create a worktree for ${name}: ${message}`)
      }
    } else this.emit({ type: "workspace.created", data: { path: info.cwd, mode: "shared" } }, agentId)
    if (params.taskId) this.collab.assignTask(params.taskId, agentId)
    // the files it owns: claimed for it, so others are warned off (and told who to talk to)
    if (params.files?.length) {
      const c = this.collab.claim(agentId, params.files)
      if (!c.ok)
        this.emit(
          {
            type: "orch.note",
            data: { level: "warn", text: `${name}: ${c.conflicts.map((x) => `${x.globs.join(", ")} already claimed by ${x.agent}`).join("; ")}` },
          },
          agentId,
        )
    }

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
          // identity travels as a bearer header, not in the URL (URLs end up in process lists and logs)
          mcpServers:
            this.mcpBaseUrl && rt.caps.mcp ? [{ name: "baton", url: `${this.mcpBaseUrl}/mcp`, headers: { Authorization: `Bearer ${rt.token}` } }] : [],
          approval,
          env: { ...this.collab.workspaces.env(agentId), ...profile?.env, BATON_AGENT: name, BATON_AGENT_ID: agentId, BATON_PROJECT_ROOT: this.projectRoot },
          command: profile?.command,
          args: profile?.args,
          resumeId: params.resumeId,
          // the lead's directory also receives merges — don't attribute those to its own commands
          options: { ...(params.isOrchestrator ? { shellDiffs: false } : {}), ...profile?.options, ...params.options },
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
      rt.closing = true
      this.emit({ type: "agent.exited", data: { code: null, reason: message } }, agentId)
      await this.onExited(rt, message)
      throw new Error(`failed to start ${name}: ${message}`)
    }
    if (this.state.agents.get(agentId)?.status === "starting") this.emit({ type: "agent.status", data: { status: "ready" } }, agentId)
    if (params.prompt) await this.promptAgent(agentId, params.prompt, { from: params.parentId ?? "user", expectResult: !!params.parentId })
    // messages that arrived while the agent was starting
    else queueMicrotask(() => this.flushInbox(rt))
    return info
  }

  /** Requests the runtime already resolved — adapters echo their own `permission.resolved`. */
  private resolvedRequests = new Set<string>()

  private onAgentEvent(rt: AgentRuntime, ev: AgentEvent) {
    if (this.closed) return
    const agentId = rt.info.agentId
    if (ev.type === "permission.resolved" && this.resolvedRequests.has(ev.data.requestId)) return
    if (ev.type === "tool.update") {
      if (isOutputProgress(ev.data)) return rt.closing ? undefined : this.liveOutput(rt, ev.data)
      const last = rt.liveOutput.get(ev.data.toolCallId)
      const term = ev.data.content?.find((c) => c.type === "terminal")
      // a stored update with output is newer than what's live: the result mustn't fall back to it
      if (last && term && ev.data.status !== "completed" && ev.data.status !== "failed") last.content = term
      if (last && (ev.data.status === "completed" || ev.data.status === "failed")) {
        clearTimeout(last.timer)
        rt.liveOutput.delete(ev.data.toolCallId)
        // the result keeps the output it ended with when the agent doesn't repeat it
        if (!ev.data.content?.some((c) => c.type === "terminal")) ev = { ...ev, data: { ...ev.data, content: [...(ev.data.content ?? []), last.content] } }
      }
    }
    let stored: BatonEvent
    try {
      stored = this.emit(ev, agentId)
    } catch (e) {
      this.emit({ type: "log", data: { level: "warn", message: `[${rt.info.name}] invalid event ${ev.type}: ${e instanceof Error ? e.message : e}` } }, agentId)
      return
    }
    rt.lastEventAt = stored.ts
    if (rt.flagged === "stalled") rt.flagged = undefined
    if (stored.type === "tool.call") {
      this.loopCheck(rt, stored.data.title)
      if (stored.data.status === "pending" || stored.data.status === "in_progress") rt.openTools.add(stored.data.toolCallId)
    } else if (stored.type === "tool.update" && (stored.data.status === "completed" || stored.data.status === "failed"))
      rt.openTools.delete(stored.data.toolCallId)
    switch (stored.type) {
      case "turn.started":
        rt.busy = true
        rt.lastAssistantText = ""
        rt.turnDiff = { added: 0, removed: 0 }
        rt.turnEdits.clear()
        break
      case "message.completed":
        if (stored.data.role === "assistant" && stored.data.text.trim()) rt.lastAssistantText = stored.data.text
        break
      case "tool.update":
        for (const c of stored.data.content ?? [])
          if (c.type === "diff") rt.turnEdits.set(`${stored.data.toolCallId}|${c.path}`, { added: c.added ?? 0, removed: c.removed ?? 0 })
        rt.turnDiff = { added: 0, removed: 0 }
        for (const d of rt.turnEdits.values()) {
          rt.turnDiff.added += d.added
          rt.turnDiff.removed += d.removed
        }
        break
      case "turn.completed":
      case "turn.interrupted":
        rt.busy = false
        rt.openTools.clear()
        this.storeLiveOutput(rt)
        {
          const outcome = stored.type === "turn.interrupted" ? "interrupted" : stored.data.stopReason === "error" ? "failed" : "ok"
          // a worker with an acceptance check is done only when the check passes
          if (outcome === "ok" && rt.info.acceptance && rt.resultTo.size && !rt.closing) void this.checkAcceptance(rt)
          else this.reportResult(rt, outcome)
        }
        queueMicrotask(() => this.flushInbox(rt))
        break
      case "agent.status":
        if (stored.data.status === "ready") {
          rt.busy = false
          queueMicrotask(() => this.flushInbox(rt))
        } else if (stored.data.status === "busy") {
          rt.busy = true
          // agents retry forever on an exhausted plan ("retrying (attempt 3): Free usage exceeded")
          if (stored.data.detail && /retry/i.test(stored.data.detail) && isQuotaError(stored.data.detail)) this.outOfQuota(rt, stored.data.detail)
        }
        break
      case "permission.requested":
        this.routePermission(rt, stored.data.requestId, stored.data.title, stored.data.kind, stored.data.detail, stored.data.options)
        break
      case "usage.updated":
        this.checkBudget(rt)
        break
      case "error":
        if (/not logged in|authenticat|unauthori[sz]ed|\b401\b|invalid api key|please run \/login/i.test(stored.data.message)) {
          this.registry.forget(rt.info.adapter)
          this.authHint(rt)
        } else if (isQuotaError(stored.data.message)) this.outOfQuota(rt, stored.data.message)
        break
      case "agent.exited":
        rt.closing = true
        this.collab.onEvent(rt, stored)
        void this.onExited(rt, stored.data.reason ?? (stored.data.code ? `exit code ${stored.data.code}` : "exited"))
        return
    }
    this.collab.onEvent(rt, stored)
  }

  /** Store the last output of commands that never reported a result (the turn ended without one). */
  private storeLiveOutput(rt: AgentRuntime) {
    for (const [toolCallId, o] of rt.liveOutput) {
      clearTimeout(o.timer)
      this.emit({ type: "tool.update", data: { toolCallId, content: [o.content] } }, rt.info.agentId)
    }
    rt.liveOutput.clear()
  }

  /** Show a running command's latest output: right away, then at most every LIVE_OUTPUT_MS. */
  private liveOutput(rt: AgentRuntime, d: ToolUpdate) {
    rt.lastEventAt = Date.now()
    if (rt.flagged === "stalled") rt.flagged = undefined
    const id = d.toolCallId
    let entry = rt.liveOutput.get(id)
    if (!entry) {
      entry = { content: d.content![0]!, dirty: true }
      rt.liveOutput.set(id, entry)
    } else {
      entry.content = d.content![0]!
      entry.dirty = true
    }
    if (entry.timer) return
    const e = entry
    const flush = () => {
      e.timer = undefined
      if (this.closed || rt.liveOutput.get(id) !== e || !e.dirty) return
      e.dirty = false
      this.store.append(
        this.runId,
        { type: "tool.update", data: { toolCallId: id, content: [e.content] } },
        { agentId: rt.info.agentId, live: true, trusted: true },
      )
      e.timer = setTimeout(flush, LIVE_OUTPUT_MS)
    }
    flush()
  }

  /**
   * Everything that has to happen once an agent is gone — crashed, killed or failed to start:
   * dispatchers get a failed result (so wait_for_results returns), its task fails, pending
   * asks resolve, long-polls wake, and its workspace + leases are released.
   */
  private onExited(rt: AgentRuntime, reason: string): Promise<void> {
    rt.exitHandled ??= this.handleExit(rt, reason)
    return rt.exitHandled
  }

  private async handleExit(rt: AgentRuntime, reason: string): Promise<void> {
    rt.closing = true
    const wasBusy = rt.busy
    rt.busy = false
    if (rt.flushTimer) clearTimeout(rt.flushTimer)
    if (!this.closed) this.storeLiveOutput(rt)
    for (const o of rt.liveOutput.values()) clearTimeout(o.timer)
    rt.liveOutput.clear()
    for (const w of [...rt.waiters]) w()
    this.policy.forgetAgent(rt.info.agentId)
    for (const [id, ask] of this.asks) if (ask.agentId === rt.info.agentId) void this.resolvePermission(rt.info.agentId, id, "no", "cancelled")
    if (wasBusy || rt.resultTo.size) {
      if (!rt.lastAssistantText.trim()) rt.lastAssistantText = `(${rt.info.name} exited: ${reason})`
      this.reportResult(rt, "failed")
    } else this.collab.onResult(rt, "failed")
    if (!this.closed) await this.collab.remove(rt.info.agentId).catch(() => {})
    // the entry stays (names, reviews and results still refer to it); what it held goes
    rt.session = undefined
    rt.inbox.length = 0
    rt.deliveries.length = 0
    rt.turnEdits.clear()
    rt.openTools.clear()
  }

  private authHinted = new Set<string>()

  /**
   * The agent's plan / credits ran out: stop the retry loop, say so plainly (to the lead and the
   * user), and keep this adapter out of new spawns and reviews for a while.
   */
  private outOfQuota(rt: AgentRuntime, detail: string) {
    if (rt.failReason) return
    const why = detail.replace(/^retrying \(attempt \d+\):\s*/i, "").slice(0, 200)
    rt.failReason = `${rt.info.adapter} is out of quota: ${why}`
    this.registry.markUnavailable(rt.info.adapter, `out of quota (${why})`, QUOTA_COOLDOWN_MS)
    this.emit({ type: "orch.note", data: { level: "warn", text: `${rt.info.name}: ${rt.failReason} — stopped its turn; use another agent` } }, rt.info.agentId)
    if (rt.busy) void rt.session?.interrupt().catch(() => {})
  }

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
    if ((this.runStopped || rt.budgetStopped) && opts.from !== "user")
      throw new Error(`budget exceeded — ${rt.info.name} gets no new work until the budget is raised (budget.run_usd / budget.per_agent_usd)`)
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
    await this.onExited(rt, "killed")
  }

  rename(agentId: string, name?: string, label?: string) {
    const rt = this.agents.get(agentId)
    if (!rt) return
    // the orchestrator keeps its address; renaming to the current name is a no-op
    if (name?.trim() && !rt.info.isOrchestrator && name.trim().toLowerCase() !== rt.info.name.toLowerCase())
      rt.info.name = this.allocateName(rt.info.adapter, name, rt)
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
    const hit = v ? this.agents.get(v.agentId) : undefined
    if (hit && !hit.closing) return hit
    // a live agent may have reused the name of an exited one
    const lower = clean.toLowerCase()
    for (const a of this.agents.values()) if (!a.closing && a.info.name.toLowerCase() === lower) return a
    return undefined
  }

  orchestrator(): AgentRuntime | undefined {
    for (const a of this.agents.values()) if (a.info.isOrchestrator && !a.closing) return a
    return undefined
  }

  async ensureOrchestrator(): Promise<AgentRuntime> {
    const existing = this.orchestrator()
    if (existing) return existing
    if (!this.config.orchestrator.enabled) throw new Error("orchestrator is disabled (orchestrator.enabled = false)")
    return this.spawnLead({ adapter: this.config.orchestrator.agent, label: this.config.orchestrator.mode })
  }

  /** A lead being started: whoever else needs one (a task, a resume) waits for it instead of starting a second. */
  private leadStarting?: Promise<AgentInfo>

  /** Start the lead, unless one is running or already starting (then that one). */
  async spawnLead(params: SpawnParams & { resumeId?: string }): Promise<AgentRuntime> {
    for (;;) {
      const existing = this.orchestrator()
      if (existing) return existing
      if (!this.leadStarting) break
      await this.leadStarting.catch(() => {})
    }
    const starting = this.spawn({ ...params, isOrchestrator: true })
    this.leadStarting = starting
    try {
      const info = await starting
      return this.agents.get(info.agentId) as AgentRuntime
    } finally {
      if (this.leadStarting === starting) this.leadStarting = undefined
    }
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
    for (const r of recipients) {
      const quiet = this.isChatter(sender, r, kind, body)
      this.deliver(r, { messageId, from: params.from, fromName, kind, body, ts: Date.now(), ...(quiet ? { quiet } : {}) }, params.delivery ?? "queue")
    }
    return messageId
  }

  /**
   * Agents politely ping-pong ("Thanks!" → "Acknowledged." → "Closing out." …), each message
   * buying the other a full turn. Acknowledgments, and worker↔worker chat beyond a few rounds,
   * are delivered quietly: they wait in the inbox for the next real message.
   */
  private isChatter(sender: AgentRuntime | undefined, to: AgentRuntime, kind: BusKind, body: string): boolean {
    if (!sender || (kind !== "chat" && kind !== "reply")) return false
    if (isAck(body)) return true
    if (sender.info.isOrchestrator || to.info.isOrchestrator) return false
    const key = [sender.info.agentId, to.info.agentId].sort().join("|")
    const now = Date.now()
    const ts = (this.pairChat.get(key) ?? []).filter((t) => now - t < PAIR_WINDOW_MS)
    ts.push(now)
    this.pairChat.set(key, ts)
    if (ts.length === MAX_PAIR_CHAT + 1)
      this.notifyLeadAbout(
        to,
        `${sender.info.name} and ${to.info.name} keep messaging each other (${MAX_PAIR_CHAT}+ messages in 5 min) — further chat between them no longer starts turns until you step in.`,
      )
    return ts.length > MAX_PAIR_CHAT
  }

  private formatForAgent(msgs: InboxMessage[]): string {
    if (msgs.length === 1) {
      const m = msgs[0] as InboxMessage
      if (m.from === "user") return m.body
      return `[baton] ${m.kind === "result" ? "Result" : "Message"} from ${m.fromName}:\n${m.body}\n\n(Reply with the baton send_message tool, to: "${m.fromName}" — only if there's something to say: don't answer thanks or acknowledgments.)`
    }
    return `[baton] ${msgs.length} messages:\n\n${msgs.map((m) => `— from ${m.fromName} (${m.kind}):\n${m.body}`).join("\n\n")}\n\n(Reply with the baton send_message tool where needed — don't answer thanks or acknowledgments.)`
  }

  private deliver(rt: AgentRuntime, msg: InboxMessage, delivery: Delivery) {
    if (!rt.session || rt.closing || msg.quiet) {
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
    // a failed prompt (agent died, budget stop, adapter error) keeps the message for later
    const send = (via: Delivery | "prompt", d?: Delivery) =>
      this.promptAgent(rt.info.agentId, text, { from, delivery: d, expectResult }).then(
        () => this.markDelivered(msg.messageId, rt, via),
        () => {
          rt.inbox.push(msg)
        },
      )
    if (rt.busy) {
      if (delivery === "interrupt") return void send("interrupt", "interrupt")
      if (delivery === "steer" && rt.caps.steer) return void send("steer", "steer")
      rt.inbox.push(msg)
      return
    }
    if (this.runStopped || rt.budgetStopped || !this.allowAutoDelivery(rt)) {
      rt.inbox.push(msg)
      return
    }
    void send("prompt")
  }

  private allowAutoDelivery(rt: AgentRuntime): boolean {
    const now = Date.now()
    rt.deliveries = rt.deliveries.filter((t) => now - t < 60_000)
    if (rt.deliveries.length >= MAX_AUTO_DELIVERIES_PER_MIN) {
      if (!rt.flushTimer) {
        this.emit({ type: "orch.note", data: { text: `${rt.info.name}: message rate limit hit — holding messages in inbox`, level: "warn" } }, rt.info.agentId)
        // retry once the oldest delivery leaves the window
        const wait = 60_000 - (now - (rt.deliveries[0] ?? now)) + 50
        rt.flushTimer = setTimeout(() => {
          rt.flushTimer = undefined
          this.flushInbox(rt)
        }, wait)
        rt.flushTimer.unref?.()
      }
      return false
    }
    rt.deliveries.push(now)
    return true
  }

  private markDelivered(messageId: string, rt: AgentRuntime, via: string) {
    this.emit({ type: "bus.delivered", data: { messageId, to: rt.info.agentId, via } })
  }

  private flushInbox(rt: AgentRuntime) {
    if (rt.busy || rt.closing || !rt.session || rt.waiters.size > 0 || !rt.inbox.some((m) => !m.quiet)) return
    if (this.runStopped || rt.budgetStopped) return
    if (!this.allowAutoDelivery(rt)) return
    const msgs = rt.inbox.splice(0)
    const only = msgs.length === 1 ? (msgs[0] as InboxMessage) : undefined
    const expectResult = only ? (only.kind === "request" ? true : only.kind === "result" || only.kind === "reply" ? false : undefined) : false
    // batched: every request in the batch still gets its answer routed back to its sender
    if (!only)
      for (const m of msgs) {
        const sender = this.agents.get(m.from)
        if (m.kind === "request" && sender && !sender.closing) rt.resultTo.add(sender.info.agentId)
      }
    void this.promptAgent(rt.info.agentId, this.formatForAgent(msgs), { from: only?.from, expectResult }).then(
      () => {
        for (const m of msgs) this.markDelivered(m.messageId, rt, "prompt")
      },
      () => {
        rt.inbox.unshift(...msgs)
      },
    )
  }

  drainInbox(agentId: string): InboxMessage[] {
    const rt = this.agents.get(agentId)
    if (!rt) return []
    const msgs = rt.inbox.splice(0)
    for (const m of msgs) this.markDelivered(m.messageId, rt, "inbox")
    return msgs
  }

  /**
   * Long-poll for inbox messages (used by wait_for_results / read_inbox). When `signal`
   * aborts (the agent's MCP request went away) nothing is consumed: messages stay in the
   * inbox and are delivered normally.
   */
  async waitInbox(agentId: string, timeoutMs: number, until?: (inbox: InboxMessage[]) => boolean, signal?: AbortSignal): Promise<InboxMessage[]> {
    const rt = this.agents.get(agentId)
    if (!rt) return []
    const ready = () => rt.inbox.some((m) => !m.quiet) && (!until || until(rt.inbox))
    if (!ready()) {
      const d = deferred<void>()
      const w = () => {
        if (ready() || rt.closing) d.resolve()
      }
      const onAbort = () => d.resolve()
      rt.waiters.add(w)
      rt.blocked++
      signal?.addEventListener("abort", onAbort, { once: true })
      const t = setTimeout(() => d.resolve(), timeoutMs)
      if (signal?.aborted) d.resolve()
      await d.promise
      clearTimeout(t)
      signal?.removeEventListener("abort", onAbort)
      rt.waiters.delete(w)
      rt.blocked--
    }
    if (signal?.aborted) {
      queueMicrotask(() => this.flushInbox(rt))
      return []
    }
    return this.drainInbox(agentId)
  }

  /** Track a blocking tool call so the watchdog doesn't flag the agent as stalled. */
  async whileBlocked<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const rt = this.agents.get(agentId)
    if (rt) rt.blocked++
    try {
      return await fn()
    } finally {
      if (rt) {
        rt.blocked--
        rt.lastEventAt = Date.now()
      }
    }
  }

  private reportResult(rt: AgentRuntime, outcome: "ok" | "failed" | "interrupted") {
    this.collab.onResult(rt, outcome)
    if (rt.resultTo.size === 0) return
    const targets = [...rt.resultTo]
    rt.resultTo.clear()
    const diff = rt.turnDiff.added || rt.turnDiff.removed ? ` (+${rt.turnDiff.added} −${rt.turnDiff.removed})` : ""
    const text = rt.failReason
      ? `${rt.failReason}. It cannot work until that is resolved — give its task to a different agent (another adapter).`
      : rt.lastAssistantText.trim() || "(no summary)"
    const ws = this.collab.workspaces.byAgent.get(rt.info.agentId)
    const where =
      ws?.mode === "worktree" && (rt.turnDiff.added || rt.turnDiff.removed)
        ? `\n[changes are in ${rt.info.name}'s own worktree — call merge("${rt.info.name}") to bring them into the project]`
        : ""
    const check = rt.acceptanceNote ? `\n${rt.acceptanceNote}` : ""
    rt.acceptanceNote = undefined
    const body = `result ${outcome}${diff}\n${text.length > 4000 ? `${text.slice(0, 4000)}…` : text}${check}${where}`
    for (const t of targets) {
      if (!this.agents.get(t) || this.agents.get(t)?.closing) continue
      try {
        this.send({ from: rt.info.agentId, to: t, body, kind: "result", delivery: "queue" })
      } catch {}
    }
  }

  /**
   * Run the worker's acceptance check in its workspace (through the policy, like any command).
   * Pass → its result goes out with "acceptance ✓". Fail → the worker gets the output and two
   * more tries; after that the result goes out as failed.
   */
  private async checkAcceptance(rt: AgentRuntime): Promise<void> {
    const cmd = rt.info.acceptance as string
    const id = rt.info.agentId
    let d = this.policy.decide({ agentId: id, agentName: rt.info.name, adapter: rt.info.adapter, title: `Bash(${cmd})`, kind: "execute", detail: cmd })
    if (d === "ask") d = (await this.askUser(id, `run ${rt.info.name}'s acceptance check?`, cmd)) ? "allow" : "deny"
    if (d === "deny") {
      rt.acceptanceNote = `acceptance check \`${cmd}\` was not run (not allowed)`
      return this.reportResult(rt, "ok")
    }
    const toolCallId = newId("acc")
    this.emit({ type: "tool.call", data: { toolCallId, kind: "execute", name: "acceptance", title: `Acceptance: ${cmd}`, status: "in_progress" } }, id)
    const r = await runCapture(shellCommand(cmd), { cwd: rt.info.cwd, timeoutMs: 10 * 60_000, env: this.collab.workspaces.env(id) }).catch((e: unknown) => ({
      code: null as number | null,
      stdout: "",
      stderr: e instanceof Error ? e.message : String(e),
    }))
    if (rt.closing) return
    const output = `${r.stdout}${r.stderr}`.trim().split("\n").slice(-40).join("\n")
    const ok = r.code === 0
    this.emit(
      {
        type: "tool.update",
        data: {
          toolCallId,
          status: ok ? "completed" : "failed",
          content: [{ type: "terminal", terminalId: toolCallId, command: cmd, output, exitCode: r.code }],
          summary: ok ? "passed" : `failed (exit ${r.code ?? "timeout"})`,
        },
      },
      id,
    )
    if (ok) {
      rt.acceptanceTries = 0
      rt.acceptanceNote = `acceptance ✓ \`${cmd}\` passed`
      return this.reportResult(rt, "ok")
    }
    rt.acceptanceTries = (rt.acceptanceTries ?? 0) + 1
    if (rt.acceptanceTries <= 2) {
      try {
        this.send({
          from: "baton",
          to: id,
          kind: "chat",
          body: `Your acceptance check failed: \`${cmd}\` exited ${r.code ?? "(timed out)"}.\n\n${output}\n\nFix it, run the check yourself, then finish again.`,
        })
        return
      } catch {}
    }
    rt.acceptanceTries = 0
    rt.acceptanceNote = `acceptance ✗ \`${cmd}\` still failing (exit ${r.code ?? "timeout"}):\n${output.split("\n").slice(-15).join("\n")}`
    this.reportResult(rt, "failed")
  }

  /** Same tool call N times in a row → the agent is probably looping. */
  private loopCheck(rt: AgentRuntime, title: string) {
    const n = this.config.watchdog.loop_repeats
    if (rt.lastToolTitle === title) rt.toolRepeats++
    else {
      rt.lastToolTitle = title
      rt.toolRepeats = 1
      if (rt.flagged === "looping") {
        rt.flagged = undefined
        this.emit({ type: "agent.attention", data: { reason: "clear" } }, rt.info.agentId)
      }
    }
    if (n > 0 && rt.toolRepeats === n) {
      rt.flagged = "looping"
      const detail = `${title} ×${n}`
      this.emit({ type: "agent.attention", data: { reason: "looping", detail } }, rt.info.agentId)
      this.notifyLeadAbout(rt, `${rt.info.name} may be stuck in a loop (${detail}).`)
    }
  }

  /** Busy agents that went silent. Runs on the heartbeat timer (and every 30s). */
  watchdog(now = Date.now()) {
    const stall = this.config.watchdog.stall_s * 1000
    if (stall <= 0) return
    for (const rt of this.agents.values()) {
      if (!rt.busy || rt.closing || rt.flagged === "stalled" || rt.blocked > 0) continue
      if (this.state.agents.get(rt.info.agentId)?.status === "awaiting_approval") continue
      // a running command (build, test suite) is quiet but alive: give it 3× the patience
      if (now - rt.lastEventAt < (rt.openTools.size > 0 ? stall * 3 : stall)) continue
      rt.flagged = "stalled"
      const mins = Math.round((now - rt.lastEventAt) / 60000)
      const last = this.state.agents.get(rt.info.agentId)?.statusDetail
      this.emit({ type: "agent.attention", data: { reason: "stalled", detail: `no activity for ${mins}m${last ? ` (${last})` : ""}` } }, rt.info.agentId)
      this.notifyLeadAbout(rt, `${rt.info.name} has shown no activity for ${mins} minutes${last ? ` — its last status: "${last.slice(0, 200)}"` : ""}.`)
    }
  }

  private notifyLeadAbout(rt: AgentRuntime, text: string) {
    const lead = this.orchestrator()
    if (!lead || lead === rt) return
    try {
      this.send({
        from: "baton",
        to: lead.info.agentId,
        body: `${text} Consider nudging it (send_message), interrupting, or reassigning the task.`,
        kind: "system",
      })
    } catch {}
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

  private asks = new Map<string, { agentId: string; resolve: (ok: boolean) => void }>()

  /**
   * Ask the user a yes/no question on behalf of an agent (shows in the inbox like any approval,
   * but is never decided by the policy). Resolves false on deny or after `timeoutMs`.
   */
  askUser(agentId: string, title: string, detail?: string, timeoutMs = 15 * 60_000, signal?: AbortSignal): Promise<boolean> {
    const requestId = newId("ask")
    const d = deferred<boolean>()
    this.asks.set(requestId, { agentId, resolve: d.resolve })
    const rt = this.agents.get(agentId)
    if (rt) rt.blocked++
    const onAbort = () => {
      if (this.asks.has(requestId)) void this.resolvePermission(agentId, requestId, "no", "cancelled")
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    this.emit(
      {
        type: "permission.requested",
        data: {
          requestId,
          title,
          kind: "delegate",
          detail,
          options: [
            { optionId: "yes", name: "Yes", kind: "allow_once" },
            { optionId: "no", name: "No", kind: "reject_once" },
          ],
        },
      },
      agentId,
    )
    const t = setTimeout(() => {
      if (this.asks.has(requestId)) void this.resolvePermission(agentId, requestId, "no", "timeout")
    }, timeoutMs)
    t.unref?.()
    return d.promise.finally(() => {
      clearTimeout(t)
      signal?.removeEventListener("abort", onAbort)
      if (rt) {
        rt.blocked--
        rt.lastEventAt = Date.now()
      }
    })
  }

  // ── presence (shared runs) ──
  private viewers = new Map<string, { name: string; via: string }>()

  joinViewer(id: string, name: string, via: string) {
    this.viewers.set(id, { name, via })
    this.emitPresence()
  }

  leaveViewer(id: string) {
    if (this.viewers.delete(id)) this.emitPresence()
  }

  private emitPresence() {
    if (!this.closed) this.emit({ type: "run.presence", data: { viewers: [...this.viewers.values()] } })
  }

  async resolvePermission(agentId: string, requestId: string, optionId: string | null, by: "user" | "policy" | "timeout" | "cancelled" = "user", who?: string) {
    const ask = this.asks.get(requestId)
    if (ask) {
      this.asks.delete(requestId)
      this.emit({ type: "permission.resolved", data: { requestId, optionId, kind: optionId === "yes" ? "allow_once" : "reject_once", by, who } }, agentId)
      ask.resolve(optionId === "yes")
      return
    }
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
    this.emit({ type: "permission.resolved", data: { requestId, optionId, kind: opt?.kind ?? null, by, who } }, agentId)
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
        if (!rt.budgetStopped) {
          rt.budgetStopped = true
          this.emit({ type: "budget.exceeded", data: { scope: rt.info.name, usedUsd: used, limitUsd: b.per_agent_usd } }, rt.info.agentId)
          if (rt.busy) void this.interrupt(rt.info.agentId).catch(() => {})
        }
      } else if (!rt.budgetWarned && used >= b.per_agent_usd * b.warn_at) {
        rt.budgetWarned = true
        this.emit({ type: "budget.warn", data: { scope: rt.info.name, usedUsd: used, limitUsd: b.per_agent_usd } }, rt.info.agentId)
      }
    }
    if (b.run_usd) {
      const used = this.state.totals.costUsd
      if (used >= b.run_usd) {
        if (!this.runStopped) {
          this.runStopped = true
          this.emit({ type: "budget.exceeded", data: { scope: "run", usedUsd: used, limitUsd: b.run_usd } })
          for (const a of this.agents.values()) if (a.busy) void this.interrupt(a.info.agentId).catch(() => {})
        }
      } else if (!this.runWarned && used >= b.run_usd * b.warn_at) {
        this.runWarned = true
        this.emit({ type: "budget.warn", data: { scope: "run", usedUsd: used, limitUsd: b.run_usd } })
      }
    }
  }

  /** A raised (or removed) budget lifts the stop; held messages flow again. */
  private recheckBudgetStops() {
    const b = this.config.budget
    if (this.runStopped && (!b.run_usd || this.state.totals.costUsd < b.run_usd)) {
      this.runStopped = false
      this.runWarned = false
    }
    for (const rt of this.agents.values()) {
      const used = this.state.agents.get(rt.info.agentId)?.usage.costUsd ?? 0
      if (rt.budgetStopped && (!b.per_agent_usd || used < b.per_agent_usd)) {
        rt.budgetStopped = false
        rt.budgetWarned = false
      }
      if (!this.runStopped && !rt.budgetStopped) queueMicrotask(() => this.flushInbox(rt))
    }
  }

  /** Swap in a freshly loaded config (settings screen / file edits). New agents use it; running ones keep theirs. */
  applyConfig(next: BatonConfig) {
    const autonomyChanged = next.policy.autonomy !== this.config.policy.autonomy
    this.config = next
    this.policy.configure(next.policy.preset, next.policy.rules)
    this.collab.workspaces.configure(next.workspace)
    this.recheckBudgetStops()
    if (autonomyChanged) void this.setAutonomy(next.policy.autonomy)
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
    if (next.bus.heartbeat_s > 0) {
      this.heartbeatTimer = setInterval(() => this.heartbeat(), next.bus.heartbeat_s * 1000)
      this.heartbeatTimer.unref?.()
    }
  }

  setMode(mode: string) {
    this.emit({ type: "orch.mode", data: { mode } })
  }

  /**
   * Switch the run-wide autonomy level. Every live agent is moved to the matching approval
   * mode in place when its adapter supports it (`live`); the rest keep their native sandbox
   * until restarted (`pending`) — Baton's policy still auto-decides what they ask. Pending
   * approvals are re-decided under the new level.
   */
  async setAutonomy(mode: Autonomy): Promise<{ mode: Autonomy; live: string[]; pending: string[] }> {
    const live: string[] = []
    const pending: string[] = []
    const changed = mode !== this.autonomy
    this.autonomy = mode
    this.policy.setAutonomy(mode)
    if (changed) this.emit({ type: "run.autonomy", data: { mode } })
    for (const rt of this.agents.values()) {
      if (rt.closing || !rt.session) continue
      const next = capApproval(effectiveApproval(rt.baseApproval, mode), rt.info.access ?? "write")
      if (next === rt.info.approval) continue
      if (!rt.session.setApproval) {
        pending.push(rt.info.name)
        continue
      }
      try {
        await rt.session.setApproval(next)
        rt.info.approval = next
        this.emit({ type: "agent.updated", data: { approval: next } }, rt.info.agentId)
        live.push(rt.info.name)
      } catch (e) {
        pending.push(rt.info.name)
        this.emit(
          { type: "log", data: { level: "warn", message: `[${rt.info.name}] autonomy switch failed: ${e instanceof Error ? e.message : e}` } },
          rt.info.agentId,
        )
      }
    }
    // questions already waiting may not need a human any more
    for (const p of [...this.state.approvals.values()]) {
      if (this.asks.has(p.requestId)) continue
      const rt = this.agents.get(p.agentId)
      if (!rt) continue
      const decision = this.policy.decide({
        agentId: p.agentId,
        agentName: rt.info.name,
        adapter: rt.info.adapter,
        title: p.title,
        kind: p.kind,
        detail: p.detail,
      })
      if (decision === "ask") continue
      const opt = pickOption(p.options, decision)
      await this.resolvePermission(p.agentId, p.requestId, opt?.optionId ?? null, "policy")
    }
    return { mode, live, pending }
  }

  async close(): Promise<void> {
    if (this.closed) return
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (this.watchdogTimer) clearInterval(this.watchdogTimer)
    // what was still running is what resuming this run brings back (agents killed earlier stay gone)
    const agents = [...this.agents.values()].filter((a) => !a.closing).map((a) => a.info.agentId)
    await Promise.all([...this.agents.keys()].map((id) => this.kill(id)))
    this.emit({ type: "run.ended", data: { reason: "shutdown", agents } })
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

/** Approval an agent runs with under a run-wide autonomy level. */
/** Read-only agents always ask (so Baton's policy can refuse their edits), whatever the autonomy. */
export function capApproval(mode: ApprovalMode, access: "read-only" | "write"): ApprovalMode {
  return access === "read-only" ? "ask" : mode
}

export function effectiveApproval(base: ApprovalMode, autonomy: Autonomy): ApprovalMode {
  switch (autonomy) {
    case "ask":
      return "ask"
    case "auto":
      return base === "yolo" ? "yolo" : "auto"
    case "yolo":
      return "yolo"
    default:
      return base
  }
}
