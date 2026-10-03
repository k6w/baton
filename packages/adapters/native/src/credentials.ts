/**
 * Credential auto-detection for when no provider is configured.
 *
 * POLICY: only credentials the user provisioned themselves for API use are picked up — API keys
 * in the environment or in another tool's key store, and local model servers. Consumer
 * subscription logins (OAuth / session tokens) are never read:
 *   - not the Claude Code keychain item, ~/.claude/.credentials.json or CLAUDE_CODE_OAUTH_TOKEN —
 *     Anthropic's terms do not allow third-party apps to use Claude subscription credentials
 *     (https://code.claude.com/docs/en/legal-and-compliance). Use the `claude` agent for that;
 *   - not Codex's ChatGPT `tokens` (only its `OPENAI_API_KEY` field);
 *   - not OpenCode `"type": "oauth"` entries (only `"type": "api"`).
 *
 * Order: env keys (ENV_ORDER in providers.ts) → ~/.codex/auth.json OPENAI_API_KEY →
 * OpenCode auth.json api entries → local Ollama → LM Studio.
 * Secret values are never logged; `source` only names where a key came from.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { ProviderSpec } from "@batonsh/protocol"
import { COMPATIBLE_PRESETS, ENV_ORDER, envKeyFor } from "./providers.ts"

export interface DetectedCredential {
  kind: string
  /** Human-readable origin, never the secret ("env ANTHROPIC_API_KEY", "~/.codex/auth.json (OPENAI_API_KEY)"). */
  source: string
  apiKey?: string
  baseUrl?: string
  /** Suggested model (local servers: a model that is actually installed). */
  model?: string
  /** Models available on a local server. */
  models?: string[]
}

type Env = Record<string, string | undefined>
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

export const CLAUDE_SUBSCRIPTION_NOTE =
  "Claude subscriptions (Pro/Max) cannot be used by the Baton agent: Anthropic's terms do not allow third-party apps to use Claude subscription credentials. " +
  "To use your Claude subscription, use the `claude` agent, which runs Claude Code with your own login."

export const AUTH_HINT =
  "set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY or GEMINI_API_KEY (or GROQ/DEEPSEEK/MISTRAL/XAI_API_KEY), " +
  "add an API key to OpenCode or Codex, run Ollama or LM Studio locally, or give the agent a [providers.<name>] entry. " +
  "To use your Claude subscription, use the `claude` agent instead."

function homeOf(env: Env): string {
  return env.HOME?.trim() || homedir()
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

export function detectFromEnv(env: Env): DetectedCredential | undefined {
  for (const e of ENV_ORDER) {
    const key = env[e.env]?.trim()
    if (key) return { kind: e.kind, source: `env ${e.env}`, apiKey: envKeyFor(e.kind, env) ?? key }
  }
  return undefined
}

/** Codex: only the API-key login (`codex login --with-api-key`), never the ChatGPT tokens. */
export function detectCodex(env: Env): DetectedCredential | undefined {
  const dir = env.CODEX_HOME?.trim() || join(homeOf(env), ".codex")
  const j = readJson(join(dir, "auth.json")) as { OPENAI_API_KEY?: unknown } | undefined
  const key = typeof j?.OPENAI_API_KEY === "string" ? j.OPENAI_API_KEY.trim() : ""
  if (!key) return undefined
  return { kind: "openai", source: "~/.codex/auth.json (OPENAI_API_KEY)", apiKey: key }
}

/** OpenCode provider id → Baton provider kind, in preference order. */
const OPENCODE_KINDS: [string, string][] = [
  ["anthropic", "anthropic"],
  ["openai", "openai"],
  ["openrouter", "openrouter"],
  ["google", "gemini"],
  ["groq", "groq"],
  ["deepseek", "deepseek"],
  ["mistral", "mistral"],
  ["xai", "xai"],
  ["togetherai", "together"],
  ["fireworks-ai", "fireworks"],
  ["deepinfra", "deepinfra"],
  ["moonshotai", "moonshot"],
]

/** OpenCode: `"type": "api"` entries only — `"oauth"` entries (subscription logins) are ignored. */
export function detectOpencode(env: Env): DetectedCredential | undefined {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homeOf(env), ".local", "share")
  const j = readJson(join(dataHome, "opencode", "auth.json"))
  if (!j || typeof j !== "object") return undefined
  const entries = j as Record<string, { type?: unknown; key?: unknown }>
  for (const [id, kind] of OPENCODE_KINDS) {
    const e = entries[id]
    if (e?.type !== "api" || typeof e.key !== "string" || !e.key.trim()) continue
    return { kind, source: `OpenCode auth.json (${id}, API key)`, apiKey: e.key.trim() }
  }
  return undefined
}

const CODER = /coder|code|devstral|codestral|qwen3|deepseek|gpt-oss|kimi|glm/i

/** Prefer a coding model; skip embedding models. */
export function pickLocalModel(names: string[]): string | undefined {
  const usable = names.filter((n) => !/embed|whisper|rerank/i.test(n))
  return usable.find((n) => /coder/i.test(n)) ?? usable.find((n) => CODER.test(n)) ?? usable[0]
}

async function getJson(fetcher: Fetcher, url: string, timeoutMs: number): Promise<unknown> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    return await res.json()
  } catch {
    return undefined
  }
}

function ollamaBase(env: Env): string {
  const h = env.OLLAMA_HOST?.trim()
  if (!h) return "http://127.0.0.1:11434"
  const withScheme = /^https?:\/\//.test(h) ? h : `http://${h}`
  return withScheme.replace(/\/+$/, "")
}

export async function detectOllama(env: Env, fetcher: Fetcher = fetch, timeoutMs = 300): Promise<DetectedCredential | undefined> {
  const base = ollamaBase(env)
  const j = (await getJson(fetcher, `${base}/api/tags`, timeoutMs)) as { models?: { name?: unknown; model?: unknown }[] } | undefined
  const names = (j?.models ?? []).map((m) => (typeof m.name === "string" ? m.name : typeof m.model === "string" ? m.model : "")).filter(Boolean)
  const model = pickLocalModel(names)
  if (!model) return undefined
  return { kind: "ollama", source: `local Ollama (${base})`, baseUrl: `${base}/v1`, model, models: names }
}

export async function detectLmStudio(env: Env, fetcher: Fetcher = fetch, timeoutMs = 300): Promise<DetectedCredential | undefined> {
  const base = (env.LMSTUDIO_BASE_URL?.trim() || COMPATIBLE_PRESETS.lmstudio?.baseUrl || "http://127.0.0.1:1234/v1").replace(/\/+$/, "")
  const j = (await getJson(fetcher, `${base}/models`, timeoutMs)) as { data?: { id?: unknown }[] } | undefined
  const names = (j?.data ?? []).map((m) => (typeof m.id === "string" ? m.id : "")).filter(Boolean)
  const model = pickLocalModel(names)
  if (!model) return undefined
  return { kind: "lmstudio", source: `local LM Studio (${base})`, baseUrl: base, model, models: names }
}

/** Synchronous part (env + key files). */
export function detectCredentialsSync(env: Env): DetectedCredential | undefined {
  return detectFromEnv(env) ?? detectCodex(env) ?? detectOpencode(env)
}

export async function detectCredentials(
  opts: { env?: Env; fetch?: Fetcher; timeoutMs?: number; local?: boolean } = {},
): Promise<DetectedCredential | undefined> {
  const env = opts.env ?? process.env
  const sync = detectCredentialsSync(env)
  if (sync || opts.local === false) return sync
  const fetcher = opts.fetch ?? fetch
  return (await detectOllama(env, fetcher, opts.timeoutMs)) ?? (await detectLmStudio(env, fetcher, opts.timeoutMs))
}

export function credentialToProvider(c: DetectedCredential): ProviderSpec {
  return { id: c.kind, kind: c.kind, ...(c.apiKey ? { apiKey: c.apiKey } : {}), ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}) }
}
