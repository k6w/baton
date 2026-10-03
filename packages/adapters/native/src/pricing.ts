/**
 * USD prices (per million tokens) and context limits. Order: `options.pricing` override → the
 * models.dev catalogue (catalogue.ts) → a small built-in table. Unknown and local models cost 0.
 */
import { type Catalogue, loadCatalogue, lookupModel } from "./catalogue.ts"

export interface Price {
  input: number
  output: number
  /** Price of cache-read input tokens (defaults to `input`). */
  cachedInput?: number
  /** Price of cache-write input tokens (defaults to `input`). */
  cacheWrite?: number
}

/** First match wins — order specific patterns before general ones. */
const TABLE: [RegExp, Price][] = [
  // Anthropic
  [/claude-opus-4(-[01])?($|-\d{8})|claude-3-opus/, { input: 15, output: 75, cachedInput: 1.5, cacheWrite: 18.75 }],
  [/claude-opus/, { input: 5, output: 25, cachedInput: 0.5, cacheWrite: 6.25 }],
  [/claude-sonnet|claude-3-7-sonnet|claude-3-5-sonnet/, { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 }],
  [/claude-haiku-4|claude-4-5-haiku|claude-haiku/, { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 }],
  [/claude-3-5-haiku/, { input: 0.8, output: 4, cachedInput: 0.08, cacheWrite: 1 }],
  // OpenAI
  [/gpt-5[\w.-]*-nano/, { input: 0.05, output: 0.4, cachedInput: 0.005 }],
  [/gpt-5[\w.-]*-mini/, { input: 0.25, output: 2, cachedInput: 0.025 }],
  [/gpt-5/, { input: 1.25, output: 10, cachedInput: 0.125 }],
  [/gpt-4-1-nano|gpt-4\.1-nano/, { input: 0.1, output: 0.4, cachedInput: 0.025 }],
  [/gpt-4-1-mini|gpt-4\.1-mini/, { input: 0.4, output: 1.6, cachedInput: 0.1 }],
  [/gpt-4-1|gpt-4\.1/, { input: 2, output: 8, cachedInput: 0.5 }],
  [/gpt-4o-mini/, { input: 0.15, output: 0.6, cachedInput: 0.075 }],
  [/gpt-4o/, { input: 2.5, output: 10, cachedInput: 1.25 }],
  [/o4-mini|o3-mini/, { input: 1.1, output: 4.4, cachedInput: 0.275 }],
  [/(^|\/)o3/, { input: 2, output: 8, cachedInput: 0.5 }],
  // Google
  [/gemini-2[.-]5-pro/, { input: 1.25, output: 10, cachedInput: 0.31 }],
  [/gemini-2[.-]5-flash-lite/, { input: 0.1, output: 0.4, cachedInput: 0.025 }],
  [/gemini-2[.-]5-flash/, { input: 0.3, output: 2.5, cachedInput: 0.075 }],
  // Others (OpenRouter / native APIs)
  [/deepseek-reasoner|deepseek-r1/, { input: 0.55, output: 2.19, cachedInput: 0.14 }],
  [/deepseek/, { input: 0.27, output: 1.1, cachedInput: 0.07 }],
  [/kimi-k2/, { input: 0.6, output: 2.5, cachedInput: 0.15 }],
  [/qwen3-coder/, { input: 0.4, output: 1.6 }],
  [/grok-code-fast/, { input: 0.2, output: 1.5, cachedInput: 0.02 }],
  [/grok-4/, { input: 3, output: 15, cachedInput: 0.75 }],
]

const FREE_KINDS = new Set(["ollama", "lmstudio"])

export function priceFor(modelId: string, kind?: string, override?: unknown, cat: Catalogue | undefined = loadCatalogue()): Price | undefined {
  if (override && typeof override === "object") {
    const o = override as Record<string, unknown>
    if (typeof o.input === "number" && typeof o.output === "number")
      return {
        input: o.input,
        output: o.output,
        cachedInput: typeof o.cachedInput === "number" ? o.cachedInput : undefined,
        cacheWrite: typeof o.cacheWrite === "number" ? o.cacheWrite : undefined,
      }
  }
  if (kind && FREE_KINDS.has(kind)) return undefined
  const m = lookupModel(cat, kind ?? "", modelId)
  if (m?.cost) return { input: m.cost.input, output: m.cost.output, cachedInput: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite }
  const id = modelId.toLowerCase().replace(/\./g, "-")
  for (const [re, price] of TABLE) if (re.test(id)) return price
  return undefined
}

/** Context windows when the catalogue has nothing (first match wins). */
const CONTEXT_TABLE: [RegExp, number][] = [
  [/claude/, 200_000],
  [/gpt-5|gpt-4-1|gpt-4\.1/, 400_000],
  [/gpt-4o|o3|o4/, 128_000],
  [/gemini/, 1_000_000],
  [/deepseek/, 128_000],
  [/kimi-k2/, 256_000],
  [/qwen3-coder/, 256_000],
  [/grok-4|grok-code/, 256_000],
]

export const DEFAULT_CONTEXT_TOKENS = 128_000

/** Context window (tokens) for a model: catalogue → built-in table → 128k. */
export function contextLimitFor(modelId: string, kind?: string, cat: Catalogue | undefined = loadCatalogue()): number {
  const m = lookupModel(cat, kind ?? "", modelId)
  if (m?.context) return m.context
  const id = modelId.toLowerCase()
  for (const [re, n] of CONTEXT_TABLE) if (re.test(id)) return n
  return DEFAULT_CONTEXT_TOKENS
}

/** Does the model accept image input? `undefined` = unknown. */
export function supportsVision(modelId: string, kind?: string, cat: Catalogue | undefined = loadCatalogue()): boolean | undefined {
  const m = lookupModel(cat, kind ?? "", modelId)
  if (m?.vision !== undefined) return m.vision
  if (kind === "anthropic" && /claude-(3|sonnet|opus|haiku)/.test(modelId)) return true
  if (kind === "openai" && /gpt-4o|gpt-4\.1|gpt-4-1|gpt-5|o3|o4/.test(modelId)) return true
  return undefined
}

export interface TokenCounts {
  /** All input tokens, including cache reads/writes. */
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export function costUsd(price: Price | undefined, t: TokenCounts): number {
  if (!price) return 0
  const plain = Math.max(0, t.input - t.cacheRead - t.cacheWrite)
  return (
    (plain * price.input + t.cacheRead * (price.cachedInput ?? price.input) + t.cacheWrite * (price.cacheWrite ?? price.input) + t.output * price.output) /
    1_000_000
  )
}
