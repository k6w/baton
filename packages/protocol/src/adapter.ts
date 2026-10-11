/**
 * Adapter contract. An adapter knows how to detect, launch and drive one kind of agent
 * (Claude Code, Codex, an ACP agent, …) and translates its native protocol into BEP events.
 */
import type { AgentEvent, Delivery, PermissionOptionKind } from "./events.ts"

export type AdapterFamily = "claude" | "codex" | "opencode" | "acp" | "stream-json" | "pty" | "mock" | (string & {})

export interface DetectResult {
  installed: boolean
  version?: string
  path?: string
  /** "ok" = credentials found, "missing" = definitely not logged in, "unknown" = can't tell. */
  auth: "ok" | "missing" | "unknown"
  authHint?: string // e.g. "run `codex login`"
  /** The agent's own interactive sign-in command (`baton login <agent>` runs it). */
  login?: string[]
  /** How the agent is signed in, when it says (e.g. "Claude subscription", "API key"). */
  authMethod?: string
  protocols: string[] // e.g. ["app-server", "exec-json", "acp"]
  notes?: string[]
}

export interface AdapterCapabilities {
  /** Can inject a message into a running turn without cancelling it. */
  steer: boolean
  interrupt: boolean
  resume: boolean
  fork: boolean
  /** Emits diffs for file edits. */
  diff: boolean
  usage: boolean
  cost: boolean
  /** Surfaces permission requests to baton (instead of deciding internally). */
  permissions: boolean
  /** Accepts extra MCP servers (needed for the bus). */
  mcp: boolean
  models: string[]
}

export interface McpServerSpec {
  name: string
  /** Streamable HTTP endpoint. */
  url: string
  headers?: Record<string, string>
}

export interface ProviderSpec {
  id: string
  kind: "anthropic" | "openai" | "openai-compatible" | "bedrock" | "vertex" | "azure" | "ollama" | "lmstudio" | (string & {})
  baseUrl?: string
  apiKey?: string // already resolved secret
  headers?: Record<string, string>
}

export type ApprovalMode = "ask" | "auto-edit" | "auto" | "yolo"

export interface SessionConfig {
  agentId: string
  name: string
  cwd: string
  model?: string
  provider?: ProviderSpec
  /** Extra system prompt appended to the agent's own (role, baton instructions). */
  systemPrompt?: string
  mcpServers: McpServerSpec[]
  /** How eagerly the agent itself may act; baton's policy engine still sees requests. */
  approval: ApprovalMode
  env?: Record<string, string>
  /** Path to the binary, if overridden by config. */
  command?: string
  args?: string[]
  /** Native session id to resume. */
  resumeId?: string
  /** Adapter-specific options from config (`[agents.<name>.options]`). */
  options?: Record<string, unknown>
}

export interface AdapterContext {
  emit(event: AgentEvent): void
  log(level: "debug" | "info" | "warn" | "error", message: string): void
  signal: AbortSignal
}

export interface PromptInput {
  text: string
  /** Who sent it — rendered as a user message in the agent's thread. */
  from?: string
}

export interface AgentSession {
  /** Start a new turn (or queue it if one is running and the agent can't steer). */
  prompt(input: PromptInput): Promise<void>
  /** Inject into the running turn. Only called when capabilities.steer is true. */
  steer?(input: PromptInput): Promise<void>
  interrupt(): Promise<void>
  respondPermission(requestId: string, optionId: string | null): Promise<void>
  setModel?(model: string): Promise<void>
  /**
   * Change how freely the agent acts, mid-session (autonomy switches). Takes effect for the
   * agent's next action/turn. Adapters without it keep their start-up mode; Baton's policy
   * still decides every permission request they surface.
   */
  setApproval?(mode: ApprovalMode): Promise<void>
  /** Native id usable with SessionConfig.resumeId. */
  resumeId(): string | undefined
  close(): Promise<void>
}

export interface AgentAdapter {
  id: string
  displayName: string
  family: AdapterFamily
  /** Default executable name(s) looked up on PATH. */
  binaries: string[]
  detect(opts?: { command?: string }): Promise<DetectResult>
  capabilities(detected?: DetectResult): AdapterCapabilities
  /** Models the agent can use, asked from the agent itself (e.g. `opencode models`). Falls back to capabilities().models. */
  listModels?(detected?: DetectResult): Promise<string[]>
  start(cfg: SessionConfig, ctx: AdapterContext): Promise<AgentSession>
}

export function defineAdapter<T extends AgentAdapter>(a: T): T {
  return a
}

export interface DeliverOptions {
  delivery: Delivery
}

export const DEFAULT_PERMISSION_OPTIONS: { optionId: string; name: string; kind: PermissionOptionKind }[] = [
  { optionId: "allow_once", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
  { optionId: "reject_once", name: "Deny", kind: "reject_once" },
  { optionId: "reject_always", name: "Always deny", kind: "reject_always" },
]

export interface BatonPlugin {
  name?: string
  adapters?: AgentAdapter[]
}

/** Helper for plugin modules: `export default definePlugin({ name, adapters: [...] })`. */
export function definePlugin<T extends BatonPlugin>(p: T): T {
  return p
}
