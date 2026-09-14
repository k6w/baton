/**
 * Built-in stream-json presets: Claude Code CLI, Amp, Qwen Code.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { McpServerSpec, SessionConfig } from "../../../protocol/src/index.ts"
import { runCapture } from "../../../protocol/src/index.ts"
import { buildEnv as claudeEnv, permissionModeFor } from "../../claude/src/options.ts"
import type { AuthResult, StreamJsonPreset } from "./types.ts"

const opt = <T>(cfg: SessionConfig, key: string, guard: (v: unknown) => v is T): T | undefined => {
  const v = cfg.options?.[key]
  return guard(v) ? v : undefined
}
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isTrue = (v: unknown): v is true => v === true

function mcpMap(servers: McpServerSpec[], shape: (s: McpServerSpec) => Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const s of servers) out[s.name] = shape(s)
  return out
}

// ───────────────────────────── Claude Code CLI ─────────────────────────────

async function claudeAuth(path: string): Promise<AuthResult> {
  const envCreds = [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].some((k) => process.env[k])
  const hint = "run `claude` and use /login, or set ANTHROPIC_API_KEY"
  const s = await runCapture([path, "auth", "status"], { timeoutMs: 10_000, env: claudeEnv({}) }).catch(() => undefined)
  try {
    const j = JSON.parse(s?.stdout ?? "") as { loggedIn?: unknown }
    if (j.loggedIn === true) return { auth: "ok" }
    if (j.loggedIn === false) return envCreds ? { auth: "ok" } : { auth: "missing", authHint: hint }
  } catch {}
  return envCreds ? { auth: "ok" } : { auth: "unknown", authHint: hint }
}

/**
 * Claude Code through `claude -p` stream-json (no Agent SDK). Uses the same control protocol the
 * SDK speaks: `initialize`/`interrupt`/`set_model` requests, and `can_use_tool` permission
 * requests routed to baton via `--permission-prompt-tool stdio`.
 */
export const claudeCliPreset: StreamJsonPreset = {
  id: "claude-cli",
  displayName: "Claude Code (CLI)",
  binaries: ["claude"],
  dialect: "claude",
  buildArgs(cfg, launch) {
    const mode = permissionModeFor(cfg.approval)
    const args: string[] = []
    if (cfg.mcpServers.length)
      args.push(
        "--mcp-config",
        JSON.stringify({ mcpServers: mcpMap(cfg.mcpServers, (s) => ({ type: "http", url: s.url, ...(s.headers ? { headers: s.headers } : {}) })) }),
      )
    args.push(
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      mode,
    )
    if (mode === "bypassPermissions") args.push("--allow-dangerously-skip-permissions")
    if (cfg.model) args.push("--model", cfg.model)
    if (cfg.systemPrompt) args.push("--append-system-prompt", cfg.systemPrompt)
    if (launch.resumeId) args.push("--resume", launch.resumeId)
    const effort = opt(cfg, "effort", isStr)
    if (effort) args.push("--effort", effort)
    const maxTurns = opt(cfg, "maxTurns", isNum)
    if (maxTurns) args.push("--max-turns", String(maxTurns))
    const budget = opt(cfg, "maxBudgetUsd", isNum)
    if (budget) args.push("--max-budget-usd", String(budget))
    if (launch.resumeId && launch.resumeId === cfg.resumeId && opt(cfg, "forkSession", isTrue)) args.push("--fork-session")
    if (opt(cfg, "strictMcpConfig", isTrue)) args.push("--strict-mcp-config")
    return args
  },
  buildEnv: (cfg) => claudeEnv(cfg),
  encodeUser: (text, o) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: o.sessionId ?? "", uuid: o.uuid }),
  steer: "native",
  queue: "cli",
  interrupt: "control",
  control: true,
  initialize: () => ({}),
  systemPrompt: "args",
  capabilities: {
    steer: true,
    interrupt: true,
    resume: true,
    fork: false,
    diff: true,
    usage: true,
    cost: true,
    permissions: true,
    mcp: true,
    models: ["sonnet", "opus", "haiku"],
  },
  detectAuth: claudeAuth,
  installHint: "install Claude Code: https://claude.com/claude-code",
  protocols: ["stream-json"],
}

// ───────────────────────────── Amp ─────────────────────────────

const AMP_MODES = ["smart", "rush", "deep", "large", "free"]

async function ampAuth(): Promise<AuthResult> {
  if (process.env.AMP_API_KEY) return { auth: "ok" }
  const xdg = process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share")
  if (existsSync(join(xdg, "amp", "secrets.json"))) return { auth: "ok" }
  return { auth: "unknown", authHint: "run `amp login`, or set AMP_API_KEY for headless use" }
}

/**
 * Amp execute mode with streaming JSON input. Amp has no control protocol: interrupt is SIGINT
 * (baton respawns with `amp threads continue <id>` if the process exits) and approvals follow
 * Amp's own permission settings (`yolo` → --dangerously-allow-all).
 */
export const ampPreset: StreamJsonPreset = {
  id: "amp",
  displayName: "Amp",
  binaries: ["amp"],
  dialect: "amp",
  buildArgs(cfg, launch) {
    const args = launch.resumeId ? ["threads", "continue", launch.resumeId] : []
    args.push("--execute", "--stream-json", "--stream-json-input")
    if (cfg.approval === "yolo") args.push("--dangerously-allow-all")
    const mode = opt(cfg, "mode", isStr) ?? (cfg.model && AMP_MODES.includes(cfg.model) ? cfg.model : undefined)
    if (mode) args.push("--mode", mode)
    if (cfg.mcpServers.length)
      args.push("--mcp-config", JSON.stringify(mcpMap(cfg.mcpServers, (s) => ({ url: s.url, ...(s.headers ? { headers: s.headers } : {}) }))))
    if (opt(cfg, "thinking", isTrue)) args.push("--stream-json-thinking")
    return args
  },
  buildEnv: (cfg) => ({
    ...process.env,
    AMP_SKIP_UPDATE_CHECK: "1",
    ...(cfg.provider?.apiKey && cfg.provider.kind === "amp" ? { AMP_API_KEY: cfg.provider.apiKey } : {}),
  }),
  encodeUser: (text, o) => ({ type: "user", ...(o.steer ? { steer: true } : {}), message: { role: "user", content: [{ type: "text", text }] } }),
  steer: "native",
  queue: "host",
  interrupt: "signal",
  control: false,
  systemPrompt: "first-message",
  capabilities: {
    steer: true,
    interrupt: true,
    resume: true,
    fork: false,
    diff: true,
    usage: true,
    cost: false,
    permissions: false,
    mcp: true,
    models: AMP_MODES,
  },
  detectAuth: ampAuth,
  installHint: "install Amp: https://ampcode.com",
  protocols: ["stream-json"],
}

// ───────────────────────────── Qwen Code ─────────────────────────────

async function qwenAuth(): Promise<AuthResult> {
  if (process.env.OPENAI_API_KEY || process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY) return { auth: "ok" }
  const dir = join(homedir(), ".qwen")
  if (existsSync(join(dir, "oauth_creds.json"))) return { auth: "ok" }
  return { auth: "unknown", authHint: "run `qwen` and sign in, or set OPENAI_API_KEY/OPENAI_BASE_URL" }
}

function qwenApproval(cfg: SessionConfig): string {
  switch (cfg.approval) {
    case "ask":
      return "default"
    case "auto-edit":
      return "auto-edit"
    case "auto":
      return "auto"
    case "yolo":
      return "yolo"
  }
}

/**
 * Qwen Code headless (`--input-format stream-json`): Claude-compatible frames plus the same
 * control protocol (initialize carries MCP servers; can_use_tool asks baton for approvals).
 */
export const qwenStreamPreset: StreamJsonPreset = {
  id: "qwen-stream",
  displayName: "Qwen Code",
  binaries: ["qwen"],
  dialect: "qwen",
  buildArgs(cfg, launch) {
    const args = ["--output-format", "stream-json", "--input-format", "stream-json", "--include-partial-messages", "--approval-mode", qwenApproval(cfg)]
    if (cfg.model) args.push("--model", cfg.model)
    if (cfg.systemPrompt) args.push("--append-system-prompt", cfg.systemPrompt)
    if (launch.resumeId) args.push("--resume", launch.resumeId)
    const maxTurns = opt(cfg, "maxTurns", isNum)
    if (maxTurns) args.push("--max-session-turns", String(maxTurns))
    return args
  },
  buildEnv(cfg) {
    const env: Record<string, string | undefined> = { ...process.env }
    const p = cfg.provider
    if (p && (p.kind === "openai" || p.kind === "openai-compatible" || p.kind === "ollama" || p.kind === "lmstudio")) {
      if (p.apiKey) env.OPENAI_API_KEY = p.apiKey
      if (p.baseUrl) env.OPENAI_BASE_URL = p.baseUrl
      if (cfg.model) env.OPENAI_MODEL = cfg.model
    }
    return env
  },
  encodeUser: (text, o) => ({ type: "user", session_id: o.sessionId ?? "", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: o.uuid }),
  steer: "none",
  queue: "host",
  interrupt: "control",
  control: true,
  initialize: (cfg) =>
    cfg.mcpServers.length
      ? { hooks: null, mcpServers: mcpMap(cfg.mcpServers, (s) => ({ httpUrl: s.url, ...(s.headers ? { headers: s.headers } : {}), trust: true })) }
      : { hooks: null },
  systemPrompt: "args",
  capabilities: {
    steer: false,
    interrupt: true,
    resume: true,
    fork: false,
    diff: true,
    usage: true,
    cost: false,
    permissions: true,
    mcp: true,
    models: [],
  },
  detectAuth: qwenAuth,
  installHint: "install Qwen Code: npm i -g @qwen-code/qwen-code",
  protocols: ["stream-json"],
}

export const builtinPresets: StreamJsonPreset[] = [claudeCliPreset, ampPreset, qwenStreamPreset]
