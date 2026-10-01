/**
 * Baton Event Protocol (BEP).
 *
 * A superset of the Agent Client Protocol (ACP) session-update model. Every adapter
 * translates its native event stream into these events; the daemon appends them to the
 * event store and streams them to clients. Field names follow ACP where ACP has a concept.
 */
import { z } from "zod"

export const BEP_VERSION = 1

// ───────────────────────────── shared pieces ─────────────────────────────

export const AgentStatus = z.enum([
  "starting",
  "ready", // idle, waiting for work
  "busy", // running a turn
  "awaiting_approval",
  "error",
  "exited",
])
export type AgentStatus = z.infer<typeof AgentStatus>

export const ToolKind = z.enum([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "switch_mode",
  "delegate", // spawning / messaging another agent (Task tool, spawn_agent, …)
  "other",
])
export type ToolKind = z.infer<typeof ToolKind>

export const ToolStatus = z.enum(["pending", "in_progress", "completed", "failed"])
export type ToolStatus = z.infer<typeof ToolStatus>

export const DiffHunkLine = z.object({
  kind: z.enum(["add", "del", "ctx"]),
  text: z.string(),
  oldLine: z.number().int().optional(),
  newLine: z.number().int().optional(),
})
export type DiffHunkLine = z.infer<typeof DiffHunkLine>

export const ToolContent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({
    type: z.literal("diff"),
    path: z.string(),
    oldText: z.string().nullable().optional(),
    newText: z.string().optional(),
    /** Pre-computed lines (adapters may supply them; otherwise computed from old/new). */
    lines: z.array(DiffHunkLine).optional(),
    added: z.number().int().optional(),
    removed: z.number().int().optional(),
  }),
  z.object({
    type: z.literal("terminal"),
    terminalId: z.string().optional(),
    command: z.string().optional(),
    output: z.string(),
    exitCode: z.number().int().nullable().optional(),
  }),
])
export type ToolContent = z.infer<typeof ToolContent>

export const Location = z.object({ path: z.string(), line: z.number().int().optional() })

export const PermissionOptionKind = z.enum(["allow_once", "allow_always", "reject_once", "reject_always"])
export type PermissionOptionKind = z.infer<typeof PermissionOptionKind>

export const PermissionOption = z.object({
  optionId: z.string(),
  name: z.string(),
  kind: PermissionOptionKind,
})
export type PermissionOption = z.infer<typeof PermissionOption>

export const Usage = z.object({
  input: z.number().nonnegative().default(0),
  cachedInput: z.number().nonnegative().default(0),
  output: z.number().nonnegative().default(0),
  reasoning: z.number().nonnegative().default(0),
  costUsd: z.number().nonnegative().optional(),
  /** "reported" = adapter got exact numbers, "estimated" = computed by baton. */
  source: z.enum(["reported", "estimated"]).default("reported"),
  /** cumulative = numbers are session totals; delta = add to running totals. */
  mode: z.enum(["cumulative", "delta"]).default("cumulative"),
})
export type Usage = z.infer<typeof Usage>

export const TaskState = z.enum(["submitted", "working", "input_required", "auth_required", "completed", "failed", "canceled", "rejected"])
export type TaskState = z.infer<typeof TaskState>

export const BusKind = z.enum(["chat", "request", "reply", "heartbeat", "progress", "result", "lease", "system"])
export type BusKind = z.infer<typeof BusKind>

export const Delivery = z.enum(["steer", "queue", "interrupt"])
export type Delivery = z.infer<typeof Delivery>

export const AgentInfo = z.object({
  agentId: z.string(),
  name: z.string(),
  adapter: z.string(),
  role: z.string().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  cwd: z.string(),
  version: z.string().optional(),
  approval: z.string().optional(),
  label: z.string().optional(), // short task label shown on the card ("find typo")
  parentId: z.string().optional(), // spawned by (orchestrator or another agent)
  isOrchestrator: z.boolean().optional(),
})
export type AgentInfo = z.infer<typeof AgentInfo>

// ───────────────────────────── event payloads ─────────────────────────────

export const EventSchemas = {
  // run lifecycle
  "run.started": z.object({ title: z.string().optional(), cwd: z.string(), mode: z.string() }),
  "run.ended": z.object({ reason: z.string().optional() }),

  // agent lifecycle
  "agent.spawned": AgentInfo,
  "agent.status": z.object({ status: AgentStatus, detail: z.string().optional() }),
  "agent.updated": AgentInfo.partial(),
  /** Watchdog findings: an agent may need a nudge. Cleared by its next turn/tool activity. */
  "agent.attention": z.object({ reason: z.enum(["stalled", "looping", "scope", "clear"]), detail: z.string().optional() }),
  "agent.exited": z.object({ code: z.number().nullable().optional(), reason: z.string().optional() }),
  "agent.session": z.object({ sessionId: z.string() }), // native resume id

  // turns
  "turn.started": z.object({ turnId: z.string(), prompt: z.string().optional() }),
  "turn.completed": z.object({ turnId: z.string(), stopReason: z.string().optional() }),
  "turn.interrupted": z.object({ turnId: z.string().optional() }),

  // content
  "message.delta": z.object({
    messageId: z.string(),
    role: z.enum(["assistant", "user", "thought"]),
    text: z.string(),
  }),
  "message.completed": z.object({
    messageId: z.string(),
    role: z.enum(["assistant", "user", "thought"]),
    text: z.string(),
  }),

  // tools
  "tool.call": z.object({
    toolCallId: z.string(),
    parentToolCallId: z.string().optional(),
    kind: ToolKind,
    /** Tool name as the agent calls it ("Read", "Bash", "apply_patch"). */
    name: z.string(),
    /** One-line human title ("Read(src/app.ts)", "Ran git diff --stat"). */
    title: z.string(),
    status: ToolStatus.default("pending"),
    locations: z.array(Location).optional(),
    rawInput: z.unknown().optional(),
  }),
  "tool.update": z.object({
    toolCallId: z.string(),
    status: ToolStatus.optional(),
    title: z.string().optional(),
    content: z.array(ToolContent).optional(),
    /** Short result summary shown under the call ("Read 314 lines"). */
    summary: z.string().optional(),
    rawOutput: z.unknown().optional(),
  }),

  // agent's own todo list
  "plan.updated": z.object({
    entries: z.array(
      z.object({
        content: z.string(),
        status: z.enum(["pending", "in_progress", "completed"]),
        priority: z.enum(["high", "medium", "low"]).optional(),
      }),
    ),
  }),

  "usage.updated": Usage,

  // permissions
  "permission.requested": z.object({
    requestId: z.string(),
    toolCallId: z.string().optional(),
    title: z.string(),
    kind: ToolKind.optional(),
    detail: z.string().optional(),
    options: z.array(PermissionOption),
  }),
  "permission.resolved": z.object({
    requestId: z.string(),
    optionId: z.string().nullable(),
    kind: PermissionOptionKind.nullable(),
    by: z.enum(["user", "policy", "timeout", "cancelled"]),
  }),

  // inter-agent bus
  "bus.message": z.object({
    messageId: z.string(),
    from: z.string(), // agentId | "user" | "baton"
    to: z.string(), // agentId | "*" | "#topic" | "role:<name>"
    kind: BusKind,
    body: z.string(),
    threadId: z.string().optional(),
    replyTo: z.string().optional(),
    delivery: Delivery.default("queue"),
    priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"),
  }),
  "bus.delivered": z.object({ messageId: z.string(), to: z.string(), via: z.string() }),

  // tasks (A2A states)
  "task.created": z.object({
    taskId: z.string(),
    title: z.string(),
    description: z.string().optional(),
    deps: z.array(z.string()).default([]),
    files: z.array(z.string()).optional(),
    acceptance: z.string().optional(),
    owner: z.string().optional(),
  }),
  "task.state": z.object({
    taskId: z.string(),
    state: TaskState,
    owner: z.string().optional(),
    note: z.string().optional(),
  }),

  "task.updated": z.object({ taskId: z.string(), title: z.string().optional(), description: z.string().optional() }),
  "task.plan": z.object({
    planId: z.string(),
    status: z.enum(["proposed", "approved", "rejected"]),
    notes: z.string().optional(),
  }),

  // workspaces (git worktree per agent)
  "workspace.created": z.object({
    path: z.string(),
    branch: z.string().optional(),
    base: z.string().optional(),
    mode: z.enum(["worktree", "shared"]),
    ports: z.array(z.number()).optional(),
  }),
  "workspace.changed": z.object({
    files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })),
    added: z.number(),
    removed: z.number(),
  }),
  "workspace.conflict": z.object({
    with: z.string(), // other agentId
    files: z.array(z.string()),
    kind: z.enum(["merge", "lease"]),
  }),
  "workspace.merge": z.object({
    status: z.enum(["queued", "verifying", "merged", "failed", "conflict", "undone"]),
    commit: z.string().optional(),
    files: z.array(z.string()).optional(),
    added: z.number().optional(),
    removed: z.number().optional(),
    detail: z.string().optional(),
  }),
  "workspace.removed": z.object({ kept: z.boolean(), reason: z.string().optional() }),

  // file leases
  "lease.claimed": z.object({ leaseId: z.string(), globs: z.array(z.string()), exclusive: z.boolean(), expiresAt: z.number() }),
  "lease.released": z.object({ leaseId: z.string() }),

  // reviews
  "review.requested": z.object({ reviewId: z.string(), author: z.string(), reviewer: z.string() }),
  "review.verdict": z.object({
    reviewId: z.string(),
    author: z.string(),
    reviewer: z.string(),
    verdict: z.enum(["approve", "changes_requested"]),
    notes: z.string(),
  }),

  // budget
  "budget.warn": z.object({ scope: z.string(), usedUsd: z.number(), limitUsd: z.number() }),
  "budget.exceeded": z.object({ scope: z.string(), usedUsd: z.number(), limitUsd: z.number() }),

  // orchestrator / misc
  "orch.mode": z.object({ mode: z.string() }),
  /** Run-wide autonomy level (applies to every agent, including ones already running). */
  "run.autonomy": z.object({ mode: z.enum(["normal", "ask", "auto", "yolo"]) }),
  "orch.note": z.object({ text: z.string(), level: z.enum(["info", "warn", "error"]).default("info") }),
  error: z.object({ message: z.string(), detail: z.string().optional(), fatal: z.boolean().optional() }),
  log: z.object({ level: z.enum(["debug", "info", "warn", "error"]), message: z.string() }),
} as const

export type EventType = keyof typeof EventSchemas
export type EventData<T extends EventType> = z.infer<(typeof EventSchemas)[T]>
/** Input form (defaults optional) — what producers emit. */
export type EventInput<T extends EventType> = z.input<(typeof EventSchemas)[T]>

/** An event as produced by an adapter (no envelope yet). */
export type AgentEvent = { [K in EventType]: { type: K; data: EventInput<K>; raw?: unknown } }[EventType]

/** A stored, enveloped event. */
export type BatonEvent<T extends EventType = EventType> = {
  [K in T]: {
    id: string
    seq: number
    ts: number
    runId: string
    agentId?: string
    taskId?: string
    type: K
    data: EventData<K>
    raw?: unknown
  }
}[T]

export const EVENT_TYPES = Object.keys(EventSchemas) as EventType[]

export function parseEventData<T extends EventType>(type: T, data: unknown): EventData<T> {
  const schema = EventSchemas[type]
  if (!schema) throw new Error(`unknown event type: ${type}`)
  return schema.parse(data) as EventData<T>
}

/** Glob-ish matcher for event type filters: "tool.*", "bus.message", "*". */
export function matchesType(type: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true
  for (const p of patterns) {
    if (p === "*" || p === type) return true
    if (p.endsWith(".*") && type.startsWith(p.slice(0, -1))) return true
  }
  return false
}

/** JSON Schema export of every event payload (for non-TS SDKs and docs). */
export function eventJsonSchema(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, s] of Object.entries(EventSchemas)) out[k] = z.toJSONSchema(s, { io: "input" })
  return out
}
