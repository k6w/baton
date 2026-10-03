/**
 * Baton Control Protocol — JSON-RPC 2.0 between clients (TUI, CLI, SDK users) and batond,
 * newline-delimited over a Unix domain socket (or WebSocket).
 */
import type { DetectResult } from "./adapter.ts"
import type { AgentInfo, AgentStatus, BatonEvent, BusKind, Delivery, PermissionOption, TaskState, ToolKind } from "./events.ts"

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
  /** Timestamp of the agent's latest event (for stall detection / "last active"). */
  lastEventAt?: number
  /** Watchdog flag (stalled / looping). */
  attention?: { reason: "stalled" | "looping" | "scope"; detail?: string; ts: number }
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
  note?: string
  files?: string[]
  acceptance?: string
  /** Preferred agent (adapter or profile) set by the user. */
  agent?: string
  /** Position in the plan; tasks without one keep creation order. */
  order?: number
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
  autonomy?: "normal" | "ask" | "auto" | "yolo"
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
  /** Per-agent workspace state (worktree, unmerged files, merge / review status). */
  workspaces?: Record<string, unknown>
  viewers?: { name: string; via: string }[]
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
  /** worktree (own git worktree) | shared (work in `cwd` / the project directly). */
  isolation?: "worktree" | "shared"
  /** Plan task this agent is assigned to. */
  taskId?: string
  /** Difficulty tier → model via [routing] (ignored when model is set). */
  tier?: "small" | "medium" | "large"
}

export interface ControlMethods {
  hello: {
    /** `user`: the human behind this client (shared runs show who is watching and who did what). */
    params: { client: string; version: number; user?: string }
    result: { daemonVersion: string; protocol: number; runId: string; projectRoot: string; pid: number }
  }
  "state.snapshot": { params: Record<string, never> | undefined; result: Snapshot }
  "events.subscribe": {
    params: { fromSeq?: number; types?: string[]; agentId?: string }
    result: { subscriptionId: string; lastSeq: number }
  }
  "events.unsubscribe": { params: { subscriptionId: string }; result: { ok: true } }
  "events.query": {
    /** `runId`: any run of this project (default: the current one). */
    params: { runId?: string; fromSeq?: number; toSeq?: number; types?: string[]; agentId?: string; limit?: number }
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
  /** Start (or report) the web view. `qr` is the open URL as a QR code drawn in text. */
  "remote.start": {
    params: { lan?: boolean; port?: number; rotate?: boolean } | undefined
    result: { url: string; openUrl: string; lanUrls: string[]; lan: boolean; qr: string[] }
  }
  "remote.stop": { params: Record<string, never> | undefined; result: { ok: true } }
  /** Serve this Baton team as an A2A agent (other agents send it tasks). */
  "a2a.start": {
    params: { port?: number; host?: string; publicUrl?: string; noToken?: boolean; rotate?: boolean } | undefined
    result: { url: string; port: number; token?: string }
  }
  "a2a.stop": { params: Record<string, never> | undefined; result: { ok: true } }
  /** Track record per agent (adapter · model) and task kind, from this project's runs. */
  "scorecards.get": {
    params: Record<string, never> | undefined
    result: {
      rows: {
        key: string
        adapter: string
        model?: string
        kind: string
        agents: number
        merged: number
        mergeFailed: number
        approved: number
        changesRequested: number
        failedTurns: number
        interrupted: number
        costUsd: number
        score: number
        costPerSuccess?: number
      }[]
    }
  }
  "agents.pick": {
    params: { task: string; candidates?: string[] }
    result: { kind: string; picks: { adapter: string; model?: string; tier?: string; score: number; costPerSuccess?: number; why: string }[] }
  }
  /** Set the run-wide autonomy level. `live` = agents switched in place; `pending` = agents that keep their sandbox until restarted. */
  "run.autonomy": { params: { mode: "normal" | "ask" | "auto" | "yolo" }; result: { mode: string; live: string[]; pending: string[] } }
  "workspace.merge": { params: { agentId: string }; result: { status: string; files: string[]; detail?: string } }
  "workspace.sync": { params: { agentId: string }; result: { clean: boolean; conflicts: string[] } }
  "workspace.diff": { params: { agentId: string; paths?: string[] }; result: { patch: string } }
  "review.request": { params: { agentId: string; reviewer?: string }; result: { reviewer: string } }
  "recipes.list": {
    params: Record<string, never> | undefined
    /** `steps`: the numbered steps of the recipe's template, for previews. */
    result: { recipes: { name: string; title: string; description: string; agents: string; source: string; steps: string[] }[] }
  }
  "runs.list": {
    params: { limit?: number } | undefined
    result: {
      runs: {
        runId: string
        startedAt: number
        endedAt?: number
        title: string
        agents: number
        adapters: string[]
        costUsd: number
        toolCalls: number
        added: number
        removed: number
        merged: number
        current: boolean
      }[]
    }
  }
  "run.export": { params: { runId: string; format: "md" | "jsonl" | "html" }; result: { text: string } }
  "run.resume": { params: { runId: string }; result: { agents: string[] } }
  "plan.decide": { params: { approved: boolean; notes?: string }; result: { ok: boolean } }
  "task.edit": {
    params: {
      taskId: string
      title?: string
      description?: string
      acceptance?: string
      deps?: string[]
      agent?: string
      /** Move the task one place up / down in the plan. */
      move?: "up" | "down"
      cancel?: boolean
    }
    result: { ok: true }
  }
  /** Add a task to the plan (the user's own step). */
  "task.add": { params: { title: string; description?: string; deps?: string[]; agent?: string; acceptance?: string }; result: { taskId: string } }
  "config.get": { params: { key?: string } | undefined; result: { config: unknown; provenance?: Record<string, string> } }
  /** Re-read config files (after the settings screen wrote them). */
  "config.reload": { params: Record<string, never> | undefined; result: { errors: string[] } }
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
