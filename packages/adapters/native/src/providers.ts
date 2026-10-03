/**
 * ProviderSpec → AI SDK language model.
 *
 *   anthropic          → @ai-sdk/anthropic
 *   openai             → @ai-sdk/openai (Responses API)
 *   openai-compatible  → @ai-sdk/openai-compatible (needs base_url)
 *   ollama / lmstudio / openrouter / groq / deepseek / together / fireworks / mistral / xai
 *                      → @ai-sdk/openai-compatible with a well-known base URL
 *
 * With no provider configured, one is picked from the environment (see ENV_ORDER), or from a
 * credential found by credentials.ts (passed in as `fallback`).
 */
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { ProviderSpec } from "@batonsh/protocol"
import type { LanguageModel } from "ai"
import { loadCatalogue, topModels } from "./catalogue.ts"

export interface ResolvedModel {
  model: LanguageModel
  /** Provider id as shown in the UI ("anthropic", "openrouter", or the [providers.<id>] key). */
  providerId: string
  /** Normalised provider kind. */
  kind: string
  modelId: string
}

/** OpenAI-compatible endpoints we know the base URL (and key variables) of. */
export const COMPATIBLE_PRESETS: Record<string, { baseUrl: string; keyEnvs?: string[]; defaultModel?: string }> = {
  ollama: { baseUrl: "http://localhost:11434/v1" },
  lmstudio: { baseUrl: "http://localhost:1234/v1" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", keyEnvs: ["OPENROUTER_API_KEY"], defaultModel: "anthropic/claude-sonnet-4.5" },
  // Gemini's OpenAI-compatible endpoint
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyEnvs: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    defaultModel: "gemini-2.5-pro",
  },
  groq: { baseUrl: "https://api.groq.com/openai/v1", keyEnvs: ["GROQ_API_KEY"], defaultModel: "openai/gpt-oss-120b" },
  deepseek: { baseUrl: "https://api.deepseek.com/v1", keyEnvs: ["DEEPSEEK_API_KEY"], defaultModel: "deepseek-chat" },
  together: { baseUrl: "https://api.together.xyz/v1", keyEnvs: ["TOGETHER_API_KEY"] },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", keyEnvs: ["FIREWORKS_API_KEY"] },
  mistral: { baseUrl: "https://api.mistral.ai/v1", keyEnvs: ["MISTRAL_API_KEY"], defaultModel: "mistral-large-latest" },
  xai: { baseUrl: "https://api.x.ai/v1", keyEnvs: ["XAI_API_KEY"], defaultModel: "grok-4" },
  deepinfra: { baseUrl: "https://api.deepinfra.com/v1/openai", keyEnvs: ["DEEPINFRA_API_KEY"] },
  moonshot: { baseUrl: "https://api.moonshot.ai/v1", keyEnvs: ["MOONSHOT_API_KEY"] },
}

export const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5",
  openai: "gpt-5",
}

/** Environment keys checked (in this order) when no provider is configured. */
export const ENV_ORDER: { env: string; kind: string }[] = [
  { env: "ANTHROPIC_API_KEY", kind: "anthropic" },
  { env: "OPENAI_API_KEY", kind: "openai" },
  { env: "OPENROUTER_API_KEY", kind: "openrouter" },
  { env: "GEMINI_API_KEY", kind: "gemini" },
  { env: "GOOGLE_GENERATIVE_AI_API_KEY", kind: "gemini" },
  { env: "GROQ_API_KEY", kind: "groq" },
  { env: "DEEPSEEK_API_KEY", kind: "deepseek" },
  { env: "MISTRAL_API_KEY", kind: "mistral" },
  { env: "XAI_API_KEY", kind: "xai" },
]

type Env = Record<string, string | undefined>

/** Which provider kind would be picked from the environment (undefined = none). */
export function envProviderKind(env: Env = process.env): string | undefined {
  return ENV_ORDER.find((e) => env[e.env]?.trim())?.kind
}

/** The key for a kind from the environment. */
export function envKeyFor(kind: string, env: Env): string | undefined {
  if (kind === "anthropic") return env.ANTHROPIC_API_KEY?.trim() || undefined
  if (kind === "openai") return env.OPENAI_API_KEY?.trim() || undefined
  for (const k of COMPATIBLE_PRESETS[kind]?.keyEnvs ?? []) if (env[k]?.trim()) return env[k]?.trim()
  return undefined
}

export function normaliseKind(kind: string): string {
  const k = kind.toLowerCase().replace(/[\s_]/g, "-")
  if (k === "lm-studio") return "lmstudio"
  if (k === "google") return "gemini"
  if (k === "openai-compat" || k === "compatible") return "openai-compatible"
  return k
}

/** A "kind/model" prefix selects that provider when it can actually be used (local, or its key is set). */
function prefixUsable(kind: string, env: Env): boolean {
  if (kind === "anthropic" || kind === "openai") return !!envKeyFor(kind, env)
  const preset = COMPATIBLE_PRESETS[kind]
  if (!preset) return false
  return preset.keyEnvs ? !!envKeyFor(kind, env) : true
}

export const NO_PROVIDER_MESSAGE =
  "baton agent: no model provider configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY " +
  "(or GROQ/DEEPSEEK/MISTRAL/XAI_API_KEY), run a local Ollama or LM Studio, " +
  'or point the agent at a [providers.<name>] entry (e.g. kind = "ollama" or kind = "openai-compatible" with base_url). ' +
  "Claude subscriptions cannot be used here: to use your Claude subscription, use the `claude` agent, which runs Claude Code with your own login."

/**
 * `fallback` is a provider found by credential detection (an API key from a file, a local
 * server); it is used only when nothing is configured and no environment key is set.
 */
export function resolveModel(spec: ProviderSpec | undefined, model: string | undefined, env: Env = process.env, fallback?: ProviderSpec): ResolvedModel {
  let p: ProviderSpec | undefined = spec
  let modelId = model?.trim() || undefined
  if (!p) {
    // "anthropic/claude-…" / "ollama/llama3.2" picks the provider when none is configured
    const slash = modelId?.indexOf("/") ?? -1
    const prefix = modelId && slash > 0 ? normaliseKind(modelId.slice(0, slash)) : undefined
    if (prefix && prefixUsable(prefix, env)) {
      p = { id: prefix, kind: prefix }
      modelId = modelId?.slice(slash + 1)
    } else {
      const kind = envProviderKind(env)
      if (kind) p = { id: kind, kind }
      else if (fallback) p = fallback
      else throw new Error(NO_PROVIDER_MESSAGE)
    }
  }
  const kind = normaliseKind(p.kind)
  const headers = p.headers && Object.keys(p.headers).length ? p.headers : undefined

  if (kind === "anthropic") {
    const apiKey = p.apiKey ?? envKeyFor("anthropic", env)
    if (!apiKey && !p.baseUrl) throw new Error(`baton agent: provider "${p.id}" (anthropic) has no API key — set api_key or ANTHROPIC_API_KEY`)
    const id = modelId ?? DEFAULT_MODELS.anthropic ?? "claude-sonnet-4-5"
    const provider = createAnthropic({ apiKey, baseURL: p.baseUrl, headers })
    return { model: provider(id), providerId: p.id, kind, modelId: id }
  }
  if (kind === "openai") {
    const apiKey = p.apiKey ?? envKeyFor("openai", env)
    if (!apiKey && !p.baseUrl) throw new Error(`baton agent: provider "${p.id}" (openai) has no API key — set api_key or OPENAI_API_KEY`)
    const id = modelId ?? DEFAULT_MODELS.openai ?? "gpt-5"
    const provider = createOpenAI({ apiKey, baseURL: p.baseUrl, headers })
    return { model: provider(id), providerId: p.id, kind, modelId: id }
  }
  if (kind === "bedrock" || kind === "vertex" || kind === "azure") {
    if (!p.baseUrl)
      throw new Error(
        `baton agent: provider kind "${kind}" is not supported natively — use an OpenAI-compatible gateway (kind = "openai-compatible" with base_url)`,
      )
  }
  const preset = COMPATIBLE_PRESETS[kind]
  const baseURL = (p.baseUrl ?? preset?.baseUrl)?.replace(/\/+$/, "")
  if (!baseURL) throw new Error(`baton agent: provider "${p.id}" (${kind}) needs a base_url`)
  const id = modelId ?? preset?.defaultModel ?? topModels(loadCatalogue(), kind, 1)[0]
  if (!id) throw new Error(`baton agent: provider "${p.id}" (${kind}) needs a model — set model = "…" on the agent`)
  const apiKey = p.apiKey ?? (preset?.keyEnvs ? envKeyFor(kind, env) : undefined)
  const provider = createOpenAICompatible({ name: p.id, baseURL, apiKey, headers, includeUsage: true })
  return { model: provider.chatModel(id), providerId: p.id, kind, modelId: id }
}
