/**
 * Baton Control Protocol — JSON-RPC 2.0 between clients (TUI, CLI, SDK users) and batond,
 * newline-delimited over a Unix domain socket (or WebSocket).
 */
import type { DetectResult } from "./adapter.ts"
import type {
  AgentInfo,
  AgentStatus,
  BatonEvent,
  Delivery,
  PermissionOption,
  TaskState,
  ToolKind,
  BusKind,
} from "./events.ts"

export const CONTROL_PROTOCOL_VERSION = 1

export interface AgentView extends AgentInfo {
  status: AgentStatus
  statusDetail?: string
  startedAt: number
  /** When the current turn started (for the elapsed timer). */
  turnStartedAt?: number
  usage: { input: number; cachedInput: number; output: number; reasoning: number; costUsd: number }
  toolCalls: number
  diff: { added: number; removed: number }
  sessionId?: string
  /** 0..1 from the agent's plan, if any. */
  progress?: number
  lastActivity?: string
}

export interface PendingApproval {
  agentId: string
  requestId: string
  title: string
  kind?: ToolKind
  detail?: string
  options: PermissionOption[]
  ts: number
}

export interface TaskView {
  taskId: string
  title: string
  state: TaskState
  owner?: string
  deps: string[]
}

export interface BusMessageView {
  messageId: string
  ts: number
  from: string
  to: string
  kind: BusKind
  body: string
  delivery: Delivery
  delivered?: boolean
}

export interface Snapshot {
  runId: string
  projectRoot: string
  projectName: string
  branch?: string
  mode: string
  orchestratorId?: string
  agents: AgentView[]
  tasks: TaskView[]
  approvals: PendingApproval[]
  bus: BusMessageView[]
  totals: {
    toolCalls: number
    messages: number
    added: number
    removed: number
    costUsd: number
    input: number
    output: number
  }
  lastSeq: number
}

export interface SpawnParams {
  adapter: string
  name?: string
  model?: string
  role?: string
  label?: string
  prompt?: string
  cwd?: string
  parentId?: string
  approval?: "ask" | "auto-edit" | "auto" | "yolo"
  options?: Record<string, unknown>
}

export interface ControlMethods {
  hello: {
    params: { client: string; version: number }
    result: { daemonVersion: string; protocol: number; runId: string; projectRoot: string; pid: number }
  }
  "state.snapshot": { params: Record<string, never> | undefined; result: Snapshot }
  "events.subscribe": {
    params: { fromSeq?: number; types?: string[]; agentId?: string }
    result: { subscriptionId: string; lastSeq: number }
  }
  "events.unsubscribe": { params: { subscriptionId: string }; result: { ok: true } }
  "events.query": {
    params: { fromSeq?: number; toSeq?: number; types?: string[]; agentId?: string; limit?: number }
    result: { events: BatonEvent[] }
  }
  /** Submit a line from the main input; handles @mentions, /commands and orchestrator routing. */
  "input.submit": { params: { text: string }; result: { routedTo: string[]; command?: string; output?: string } }
  "agent.spawn": { params: SpawnParams; result: AgentInfo }
  "agent.prompt": { params: { agentId: string; text: string; delivery?: Delivery; from?: string }; result: { ok: true } }
  "agent.interrupt": { params: { agentId: string }; result: { ok: true } }
  "agent.kill": { params: { agentId: string }; result: { ok: true } }
  "agent.rename": { params: { agentId: string; name?: string; label?: string }; result: { ok: true } }
  "agents.detect": { params: { refresh?: boolean } | undefined; result: { adapters: (DetectResult & { id: string; displayName: string })[] } }
  "bus.send": {
    params: { from?: string; to: string; body: string; kind?: BusKind; delivery?: Delivery }
    result: { messageId: string }
  }
  "permission.respond": { params: { agentId: string; requestId: string; optionId: string | null }; result: { ok: true } }
  "run.mode": { params: { mode: string }; result: { ok: true } }
  "config.get": { params: { key?: string } | undefined; result: { config: unknown; provenance?: Record<string, string> } }
  "daemon.shutdown": { params: Record<string, never> | undefined; result: { ok: true } }
}

export type ControlMethod = keyof ControlMethods
export type ControlParams<M extends ControlMethod> = ControlMethods[M]["params"]
export type ControlResult<M extends ControlMethod> = ControlMethods[M]["result"]

/** Daemon → client notifications. */
export interface ControlNotifications {
  event: { subscriptionId: string; event: BatonEvent }
  "daemon.closing": { reason: string }
}
