/**
 * Small USD price table (per million tokens) for common hosted models. Unknown and local models
 * cost 0. Override per agent with `options.pricing = { input, output, cachedInput }`.
 */

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

export function priceFor(modelId: string, kind?: string, override?: unknown): Price | undefined {
  if (override && typeof override === "object") {
    const o = override as Record<string, unknown>
    if (typeof o.input === "number" && typeof o.output === "number")
      return { input: o.input, output: o.output, cachedInput: typeof o.cachedInput === "number" ? o.cachedInput : undefined }
  }
  if (kind && FREE_KINDS.has(kind)) return undefined
  const id = modelId.toLowerCase().replace(/\./g, "-")
  for (const [re, price] of TABLE) if (re.test(id)) return price
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
