/**
 * Pure helpers that turn a baton SessionConfig into `codex app-server` spawn arguments and
 * thread settings. Kept separate from the session so they can be unit-tested.
 */
import type { ApprovalMode, McpServerSpec, ProviderSpec, SessionConfig } from "@batonsh/protocol"
import type { AskForApproval } from "./generated/v2/AskForApproval.ts"
import type { SandboxMode } from "./generated/v2/SandboxMode.ts"

export interface ApprovalSettings {
  approvalPolicy: AskForApproval
  sandbox: SandboxMode
}

/**
 * Baton approval mode → Codex approval policy + sandbox.
 *
 * Codex never decides silently on our behalf when it *does* ask: every approval request it
 * sends is surfaced as a BEP `permission.requested`. The mode only chooses how often Codex asks.
 *
 * - ask       → `untrusted` + workspace-write: Codex asks before anything that is not a known
 *               read-only command, including file edits.
 * - auto-edit → `on-request` + workspace-write: edits and commands inside the workspace sandbox
 *               run unprompted; anything needing to escape the sandbox (network, outside writes)
 *               asks.
 * - auto      → `never` + workspace-write: never asks; the sandbox is the only guard rail.
 * - yolo      → `never` + danger-full-access: no sandbox, no prompts.
 *
 * `options.approvalPolicy` / `options.sandbox` override the mapping verbatim.
 */
export function approvalSettings(mode: ApprovalMode, options?: Record<string, unknown>): ApprovalSettings {
  let s: ApprovalSettings
  switch (mode) {
    case "ask":
      s = { approvalPolicy: "untrusted", sandbox: "workspace-write" }
      break
    case "auto-edit":
      s = { approvalPolicy: "on-request", sandbox: "workspace-write" }
      break
    case "auto":
      s = { approvalPolicy: "never", sandbox: "workspace-write" }
      break
    case "yolo":
      s = { approvalPolicy: "never", sandbox: "danger-full-access" }
      break
    default:
      s = { approvalPolicy: "untrusted", sandbox: "workspace-write" }
  }
  const ap = options?.approvalPolicy
  if (ap === "untrusted" || ap === "on-request" || ap === "never") s.approvalPolicy = ap
  const sb = options?.sandbox
  if (sb === "read-only" || sb === "workspace-write" || sb === "danger-full-access") s.sandbox = sb
  return s
}

/** TOML basic string. JSON string escaping is a valid subset of TOML basic-string escaping. */
export function tomlString(s: string): string {
  return JSON.stringify(s)
}

/** TOML inline table of string values: `{"A"="x","B"="y"}`. */
export function tomlStringTable(rec: Record<string, string>): string {
  return `{${Object.entries(rec)
    .map(([k, v]) => `${tomlString(k)}=${tomlString(v)}`)
    .join(",")}}`
}

/** Codex config keys are dotted paths, so server names must be bare TOML keys. */
export function sanitizeKey(name: string): string {
  const k = name.replace(/[^A-Za-z0-9_-]/g, "_")
  return k.length ? k : "server"
}

/**
 * `-c` overrides registering each baton MCP server as a streamable-HTTP server:
 *   -c mcp_servers.<name>.url="https://…"
 *   -c mcp_servers.<name>.http_headers={"Authorization"="Bearer …"}
 * (verified against `codex mcp get <name> --json` for codex 0.162.1).
 */
export function mcpConfigArgs(servers: McpServerSpec[]): string[] {
  const args: string[] = []
  for (const s of servers) {
    const key = `mcp_servers.${sanitizeKey(s.name)}`
    args.push("-c", `${key}.url=${tomlString(s.url)}`)
    if (s.headers && Object.keys(s.headers).length) args.push("-c", `${key}.http_headers=${tomlStringTable(s.headers)}`)
  }
  return args
}

/** Env var through which a provider API key is handed to codex (never put on the command line). */
export const PROVIDER_KEY_ENV = "BATON_CODEX_PROVIDER_API_KEY"

/**
 * Model provider overrides. Codex ships built-in `openai`, `ollama` and `lmstudio` providers;
 * anything with a custom base URL is registered as `model_providers.<id>` (Responses wire API).
 */
export function providerSettings(p: ProviderSpec | undefined): { args: string[]; env: Record<string, string>; modelProvider?: string } {
  if (!p) return { args: [], env: {} }
  const env: Record<string, string> = {}
  if (!p.baseUrl && (p.kind === "ollama" || p.kind === "lmstudio" || p.kind === "openai")) {
    if (p.apiKey && p.kind === "openai") env.OPENAI_API_KEY = p.apiKey
    return { args: [], env, modelProvider: p.kind }
  }
  if (!p.baseUrl) return { args: [], env }
  const id = sanitizeKey(p.id)
  const key = `model_providers.${id}`
  const args = ["-c", `${key}.name=${tomlString(p.id)}`, "-c", `${key}.base_url=${tomlString(p.baseUrl)}`]
  args.push("-c", `${key}.wire_api="responses"`)
  if (p.apiKey) {
    env[PROVIDER_KEY_ENV] = p.apiKey
    args.push("-c", `${key}.env_key=${tomlString(PROVIDER_KEY_ENV)}`)
  }
  if (p.headers && Object.keys(p.headers).length) args.push("-c", `${key}.http_headers=${tomlStringTable(p.headers)}`)
  return { args, env, modelProvider: id }
}

/** Full argv (after the binary) for `codex app-server`. */
export function appServerArgs(cfg: SessionConfig): { args: string[]; env: Record<string, string>; modelProvider?: string } {
  const prov = providerSettings(cfg.provider)
  const args = ["app-server", ...mcpConfigArgs(cfg.mcpServers ?? []), ...prov.args, ...(cfg.args ?? [])]
  return { args, env: prov.env, modelProvider: prov.modelProvider }
}

/** Render a prompt for the thread, attributing non-user senders. */
export function promptText(input: { text: string; from?: string }): string {
  if (!input.from || input.from === "user") return input.text
  return `[message from ${input.from}]\n${input.text}`
}
