/**
 * SessionConfig → Claude Agent SDK options (binary, env, permission mode, MCP, provider).
 */
import type { McpHttpServerConfig, Options, PermissionMode } from "@anthropic-ai/claude-agent-sdk"
import type { ApprovalMode, SessionConfig } from "@batonsh/protocol"
import { augmentedPath, which } from "@batonsh/protocol"

/**
 * Variables Claude Code sets for its own child processes. If baton itself runs inside a
 * Claude Code session (e.g. a developer launching it from a Bash tool), inheriting these makes
 * the nested CLI believe it is a child of that session (session id, IPC socket, entrypoint),
 * so they are stripped from the spawned environment.
 */
const NESTED_SESSION_VARS = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
]

/** Real Claude Code binary (never the shell alias). */
export function resolveBinary(command?: string): string | undefined {
  return which(command ?? "claude")
}

export function permissionModeFor(approval: ApprovalMode): PermissionMode {
  switch (approval) {
    case "ask":
      return "default"
    case "auto-edit":
      return "acceptEdits"
    case "auto":
      // Claude Code's classifier-backed mode; it still routes undecidable calls to canUseTool.
      return "auto"
    case "yolo":
      return "bypassPermissions"
  }
}

export function buildEnv(cfg: Pick<SessionConfig, "env" | "provider">, base: Record<string, string | undefined> = process.env): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base }
  for (const k of NESTED_SESSION_VARS) delete env[k]
  env.PATH = augmentedPath()
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "baton"
  const p = cfg.provider
  if (p) {
    if (p.kind === "bedrock") {
      env.CLAUDE_CODE_USE_BEDROCK = "1"
      if (p.baseUrl) env.ANTHROPIC_BEDROCK_BASE_URL = p.baseUrl
      if (p.apiKey) env.AWS_BEARER_TOKEN_BEDROCK = p.apiKey
    } else if (p.kind === "vertex") {
      env.CLAUDE_CODE_USE_VERTEX = "1"
      if (p.baseUrl) env.ANTHROPIC_VERTEX_BASE_URL = p.baseUrl
    } else if (p.kind === "azure") {
      // Microsoft Foundry hosting of Claude models.
      env.CLAUDE_CODE_USE_FOUNDRY = "1"
      if (p.baseUrl) env.ANTHROPIC_FOUNDRY_BASE_URL = p.baseUrl
      if (p.apiKey) env.ANTHROPIC_FOUNDRY_API_KEY = p.apiKey
    } else if (p.kind === "anthropic" || p.baseUrl) {
      // anthropic, openai-compatible gateways speaking the Anthropic Messages API, ollama, lmstudio…
      if (p.baseUrl) env.ANTHROPIC_BASE_URL = p.baseUrl
      if (p.apiKey) {
        if (p.kind === "anthropic" && !p.baseUrl) env.ANTHROPIC_API_KEY = p.apiKey
        else env.ANTHROPIC_AUTH_TOKEN = p.apiKey
      }
    }
    if (p.headers && Object.keys(p.headers).length)
      env.ANTHROPIC_CUSTOM_HEADERS = Object.entries(p.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
  }
  Object.assign(env, cfg.env ?? {})
  return env
}

export function buildMcpServers(cfg: Pick<SessionConfig, "mcpServers">): Record<string, McpHttpServerConfig> | undefined {
  if (!cfg.mcpServers?.length) return undefined
  const out: Record<string, McpHttpServerConfig> = {}
  for (const s of cfg.mcpServers) out[s.name] = { type: "http", url: s.url, ...(s.headers ? { headers: s.headers } : {}) }
  return out
}

/** Options shared by the live session and the fixture recorder (no callbacks). */
export function baseOptions(cfg: SessionConfig, binary: string): Options {
  const mode = permissionModeFor(cfg.approval)
  const extra = (cfg.options ?? {}) as Partial<Options>
  return {
    cwd: cfg.cwd,
    pathToClaudeCodeExecutable: binary,
    env: buildEnv(cfg),
    ...(cfg.model ? { model: cfg.model } : {}),
    permissionMode: mode,
    ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
    systemPrompt: { type: "preset", preset: "claude_code", ...(cfg.systemPrompt ? { append: cfg.systemPrompt } : {}) },
    ...(buildMcpServers(cfg) ? { mcpServers: buildMcpServers(cfg) } : {}),
    ...(cfg.resumeId ? { resume: cfg.resumeId } : {}),
    ...(cfg.args?.length ? { extraArgs: Object.fromEntries(argsToExtra(cfg.args)) } : {}),
    includePartialMessages: true,
    // `[agents.<name>.options]` passthrough: e.g. { forkSession: true, maxTurns: 50, effort: "high" }
    ...extra,
  }
}

/** ["--foo", "bar", "--flag"] → [["foo","bar"],["flag",null]] for Options.extraArgs. */
function argsToExtra(args: string[]): [string, string | null][] {
  const out: [string, string | null][] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string
    if (!a.startsWith("--")) continue
    const eq = a.indexOf("=")
    if (eq > 0) out.push([a.slice(2, eq), a.slice(eq + 1)])
    else if (args[i + 1] !== undefined && !(args[i + 1] as string).startsWith("--")) out.push([a.slice(2), args[++i] as string])
    else out.push([a.slice(2), null])
  }
  return out
}
