/**
 * Presets for agents that speak the Agent Client Protocol over stdio.
 *
 * Command lines are cross-checked against the official ACP registry
 * (https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json) where the
 * agent is listed there; `notes` flags the ones that are not.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface AcpAuthStatus {
  auth: "ok" | "missing" | "unknown"
  hint?: string
}

/**
 * Declarative auth probe: auth is "ok" when any env var is set or any file exists,
 * otherwise "missing". A function can be supplied for anything smarter.
 */
export type AcpAuthCheck = { env?: string[]; files?: string[]; hint?: string } | (() => Promise<AcpAuthStatus> | AcpAuthStatus)

export interface AcpPreset {
  id: string
  displayName: string
  /** Executable names looked up on PATH (first hit wins). */
  binaries: string[]
  /** Arguments that put the agent into ACP stdio mode. */
  args: string[]
  /** Arguments printing the version (default ["--version"]). */
  versionArgs?: string[]
  authCheck?: AcpAuthCheck
  /** Shown when the agent needs a login Baton can't perform (e.g. "run `gemini` once to log in"). */
  authHint?: string
  env?: Record<string, string>
  models?: string[]
  notes?: string[]
}

const home = (...p: string[]) => join(homedir(), ...p)

export async function runAuthCheck(check: AcpAuthCheck | undefined): Promise<AcpAuthStatus> {
  if (!check) return { auth: "unknown" }
  if (typeof check === "function") {
    try {
      return await check()
    } catch {
      return { auth: "unknown" }
    }
  }
  const envHit = (check.env ?? []).some((k) => !!process.env[k])
  const fileHit = (check.files ?? []).some((f) => existsSync(f.startsWith("~/") ? home(f.slice(2)) : f))
  if (envHit || fileHit) return { auth: "ok" }
  if (!check.env?.length && !check.files?.length) return { auth: "unknown", hint: check.hint }
  return { auth: "missing", hint: check.hint }
}

export const ACP_PRESETS: AcpPreset[] = [
  {
    id: "gemini",
    displayName: "Gemini CLI",
    binaries: ["gemini"],
    args: ["--acp"],
    authCheck: {
      env: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI"],
      files: ["~/.gemini/oauth_creds.json", "~/.gemini/google_accounts.json"],
      hint: "run `gemini` once to log in (or set GEMINI_API_KEY)",
    },
    authHint: "run `gemini` once to log in (or set GEMINI_API_KEY)",
    notes: ["Registry (gemini-cli 0.63) uses `--acp`; releases before ~0.30 only accept `--experimental-acp` — override args for old installs."],
  },
  {
    id: "cursor",
    displayName: "Cursor Agent",
    binaries: ["cursor-agent", "agent"],
    args: ["acp"],
    authCheck: { env: ["CURSOR_API_KEY"], files: ["~/.cursor/cli-config.json"], hint: "run `cursor-agent login`" },
    authHint: "run `cursor-agent login`",
  },
  {
    id: "copilot",
    displayName: "GitHub Copilot CLI",
    binaries: ["copilot"],
    args: ["--acp", "--stdio"],
    authCheck: { env: ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"], files: ["~/.copilot/config.json"], hint: "run `copilot` and `/login`" },
    authHint: "run `copilot` once and use /login",
    notes: ["Registry lists `copilot --acp` (stdio is the default transport); `--stdio` is accepted by current releases."],
  },
  {
    id: "kiro",
    displayName: "Kiro CLI",
    binaries: ["kiro-cli"],
    args: ["acp"],
    authHint: "run `kiro-cli login`",
    notes: ["Not in the ACP registry; `kiro-cli acp` from Kiro docs — medium confidence."],
  },
  {
    id: "goose",
    displayName: "Goose",
    binaries: ["goose"],
    args: ["acp"],
    authCheck: { files: ["~/.config/goose/config.yaml"], hint: "run `goose configure`" },
    authHint: "run `goose configure` to pick a provider",
  },
  {
    id: "qwen",
    displayName: "Qwen Code",
    binaries: ["qwen"],
    args: ["--acp"],
    authCheck: { env: ["OPENAI_API_KEY", "DASHSCOPE_API_KEY"], files: ["~/.qwen/oauth_creds.json"], hint: "run `qwen` once to log in" },
    authHint: "run `qwen` once to log in",
    notes: ["Registry: `qwen --acp` (older builds used `--experimental-acp`)."],
  },
  {
    id: "droid",
    displayName: "Factory Droid",
    binaries: ["droid"],
    args: ["exec", "--output-format", "acp-daemon"],
    env: { DROID_DISABLE_AUTO_UPDATE: "true", FACTORY_DROID_AUTO_UPDATE_ENABLED: "false" },
    authCheck: { env: ["FACTORY_API_KEY"], hint: "run `droid` once to log in or set FACTORY_API_KEY" },
    authHint: "run `droid` once to log in (or set FACTORY_API_KEY)",
    notes: [
      "From the ACP registry (droid 0.238): `droid exec --output-format acp-daemon`. Older releases used `--output-format acp` — override args for those.",
    ],
  },
  {
    id: "opencode-acp",
    displayName: "OpenCode (ACP)",
    binaries: ["opencode"],
    args: ["acp"],
    authHint: "run `opencode auth login`",
  },
  {
    id: "claude-acp",
    displayName: "Claude Code (ACP)",
    binaries: ["claude-agent-acp", "claude-code-acp"],
    args: [],
    versionArgs: ["--version"],
    authCheck: {
      env: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
      files: ["~/.claude/.credentials.json", "~/.claude.json"],
      hint: "run `claude` and /login",
    },
    authHint: "run `claude` once and use /login",
    notes: ["npm `@agentclientprotocol/claude-agent-acp` (formerly `@zed-industries/claude-code-acp`); speaks ACP on stdio without arguments."],
  },
  {
    id: "codex-acp",
    displayName: "Codex (ACP)",
    binaries: ["codex-acp"],
    args: [],
    authCheck: { env: ["OPENAI_API_KEY", "CODEX_API_KEY"], files: ["~/.codex/auth.json"], hint: "run `codex login`" },
    authHint: "run `codex login`",
    notes: ["npm `@agentclientprotocol/codex-acp`; speaks ACP on stdio without arguments."],
  },
  {
    id: "cline",
    displayName: "Cline",
    binaries: ["cline"],
    args: ["--acp"],
    authHint: "run `cline auth`",
    notes: ["Registry: `cline --acp` (cline CLI 3.x)."],
  },
  {
    id: "auggie",
    displayName: "Auggie",
    binaries: ["auggie"],
    args: ["--acp"],
    env: { AUGMENT_DISABLE_AUTO_UPDATE: "1" },
    authHint: "run `auggie login`",
  },
  {
    id: "kimi",
    displayName: "Kimi CLI",
    binaries: ["kimi"],
    args: ["acp"],
    authHint: "run `kimi` once to log in",
  },
  {
    id: "kilo",
    displayName: "Kilo Code",
    binaries: ["kilo"],
    args: ["acp"],
  },
  {
    id: "mistral-vibe",
    displayName: "Mistral Vibe",
    binaries: ["vibe-acp"],
    args: [],
    authCheck: { env: ["MISTRAL_API_KEY"], files: ["~/.vibe/.env"], hint: "run `vibe` once to configure" },
  },
  {
    id: "junie",
    displayName: "Junie",
    binaries: ["junie"],
    args: ["--acp=true"],
  },
]

/** The generic preset: command/args come from SessionConfig (custom user agents). */
export const GENERIC_ACP_PRESET: AcpPreset = {
  id: "acp",
  displayName: "ACP agent",
  binaries: [],
  args: [],
  notes: ["Generic ACP stdio agent: set `command` (and `args`) in the agent config."],
}
