/**
 * Model catalogue from models.dev (https://models.dev/api.json): prices, context limits and
 * vision support per provider/model.
 *
 * models.dev shape (abridged):
 *   { "<providerId>": { id, name, env: string[], api?: string, npm, doc,
 *       models: { "<modelId>": { id, name, attachment, reasoning, tool_call, release_date, last_updated,
 *         status?: "alpha" | "beta" | "deprecated", modalities: { input: string[], output: string[] },
 *         cost?: { input, output, cache_read?, cache_write? }   // USD per 1M tokens
 *         limit: { context, input?, output } } } } }
 *
 * The full file is ~5 MB, so a slim projection is cached at <stateDir>/models-dev.json, refreshed at
 * most once a day in the background. Nothing here ever blocks a session start: callers read whatever
 * is cached (possibly stale) and fall back to the built-in tables when there is nothing.
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { stateDir } from "@batonsh/kernel"

export const MODELS_DEV_URL = "https://models.dev/api.json"
const DAY_MS = 24 * 60 * 60 * 1000

export interface CatalogueModel {
  id: string
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  context?: number
  vision?: boolean
  toolCall?: boolean
  updated?: string
  status?: string
}

export interface Catalogue {
  fetchedAt: number
  providers: Record<string, Record<string, CatalogueModel>>
}

/** Baton provider kind → models.dev provider id. */
const PROVIDER_IDS: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  openrouter: "openrouter",
  gemini: "google",
  google: "google",
  groq: "groq",
  deepseek: "deepseek",
  mistral: "mistral",
  xai: "xai",
  together: "togetherai",
  fireworks: "fireworks-ai",
  deepinfra: "deepinfra",
  moonshot: "moonshotai",
  lmstudio: "lmstudio",
}

export function catalogueProviderId(kind: string): string | undefined {
  return PROVIDER_IDS[kind]
}

export function cataloguePath(dir: string = stateDir()): string {
  return join(dir, "models-dev.json")
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined)

/** Reduce the raw models.dev document to what Baton uses. Tolerates missing / odd fields. */
export function slimCatalogue(raw: unknown, fetchedAt = Date.now()): Catalogue {
  const providers: Catalogue["providers"] = {}
  if (!raw || typeof raw !== "object") return { fetchedAt, providers }
  for (const [pid, p] of Object.entries(raw as Record<string, unknown>)) {
    const models = (p as { models?: unknown })?.models
    if (!models || typeof models !== "object") continue
    const out: Record<string, CatalogueModel> = {}
    for (const [mid, m] of Object.entries(models as Record<string, Record<string, unknown>>)) {
      if (!m || typeof m !== "object") continue
      const cost = m.cost as Record<string, unknown> | undefined
      const limit = m.limit as Record<string, unknown> | undefined
      const input = (m.modalities as { input?: unknown } | undefined)?.input
      const entry: CatalogueModel = { id: typeof m.id === "string" ? m.id : mid }
      const ci = num(cost?.input)
      const co = num(cost?.output)
      if (ci !== undefined && co !== undefined) {
        entry.cost = { input: ci, output: co }
        const cr = num(cost?.cache_read)
        const cw = num(cost?.cache_write)
        if (cr !== undefined) entry.cost.cacheRead = cr
        if (cw !== undefined) entry.cost.cacheWrite = cw
      }
      const ctx = num(limit?.context)
      if (ctx) entry.context = ctx
      if (Array.isArray(input)) entry.vision = input.includes("image")
      if (typeof m.tool_call === "boolean") entry.toolCall = m.tool_call
      const updated = typeof m.last_updated === "string" ? m.last_updated : typeof m.release_date === "string" ? m.release_date : undefined
      if (updated) entry.updated = updated
      if (typeof m.status === "string") entry.status = m.status
      out[mid] = entry
    }
    providers[pid] = out
  }
  return { fetchedAt, providers }
}

// ───────────────────────────── cache file ─────────────────────────────

let memo: { path: string; mtimeMs: number; cat: Catalogue } | undefined

/** Read the cached catalogue (sync; memoised by mtime). Undefined when absent or unreadable. */
export function loadCatalogue(path: string = cataloguePath()): Catalogue | undefined {
  try {
    const st = statSync(path)
    if (memo && memo.path === path && memo.mtimeMs === st.mtimeMs) return memo.cat
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Catalogue
    if (!parsed || typeof parsed !== "object" || !parsed.providers || typeof parsed.fetchedAt !== "number") return undefined
    memo = { path, mtimeMs: st.mtimeMs, cat: parsed }
    return parsed
  } catch {
    return undefined
  }
}

export function writeFileAtomic(path: string, data: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, data, { mode })
  renameSync(tmp, path)
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

const lastAttempt = new Map<string, number>()
const inflight = new Map<string, Promise<Catalogue | undefined>>()

/**
 * Refresh the cache when it is older than a day (or missing). Never throws; resolves to the
 * freshest catalogue available (the cached one when the fetch fails). Failed attempts are not
 * retried for an hour within this process.
 */
export function refreshCatalogue(
  opts: { path?: string; fetch?: Fetcher; now?: number; timeoutMs?: number; maxAgeMs?: number; url?: string } = {},
): Promise<Catalogue | undefined> {
  const path = opts.path ?? cataloguePath()
  const now = opts.now ?? Date.now()
  const cached = loadCatalogue(path)
  if (cached && now - cached.fetchedAt < (opts.maxAgeMs ?? DAY_MS)) return Promise.resolve(cached)
  const last = lastAttempt.get(path)
  if (last !== undefined && now - last < 60 * 60 * 1000 && !opts.fetch) return Promise.resolve(cached)
  const running = inflight.get(path)
  if (running) return running
  lastAttempt.set(path, now)
  const doFetch = opts.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i))
  const p = (async () => {
    try {
      const res = await doFetch(opts.url ?? MODELS_DEV_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? 5000), headers: { accept: "application/json" } })
      if (!res.ok) return cached
      const cat = slimCatalogue(await res.json(), now)
      if (!Object.keys(cat.providers).length) return cached
      writeFileAtomic(path, JSON.stringify(cat), 0o644)
      return cat
    } catch {
      return cached
    } finally {
      inflight.delete(path)
    }
  })()
  inflight.set(path, p)
  return p
}

/** Background refresh used by the adapter: off when BATON_OFFLINE=1 or BATON_MODELS_DEV=off. */
export function ensureCatalogueFresh(): void {
  if (process.env.BATON_OFFLINE === "1" || process.env.BATON_MODELS_DEV === "off") return
  void refreshCatalogue({ url: process.env.BATON_MODELS_DEV_URL || MODELS_DEV_URL }).catch(() => {})
}

/** Exposed for tests. */
export function resetCatalogueState(): void {
  memo = undefined
  lastAttempt.clear()
  inflight.clear()
}

// ───────────────────────────── lookups ─────────────────────────────

const norm = (id: string) => id.toLowerCase().replace(/\./g, "-")

/**
 * Find a model: in the provider's own list first (exact, then normalised `4.5` ≈ `4-5`, then
 * without a `vendor/` prefix), then — for gateways and custom endpoints — across the first-party
 * providers by bare model id.
 */
export function lookupModel(cat: Catalogue | undefined, kind: string, modelId: string): CatalogueModel | undefined {
  if (!cat) return undefined
  const find = (pid: string | undefined, id: string): CatalogueModel | undefined => {
    const models = pid ? cat.providers[pid] : undefined
    if (!models) return undefined
    if (models[id]) return models[id]
    const n = norm(id)
    for (const [k, m] of Object.entries(models)) if (norm(k) === n) return m
    return undefined
  }
  const pid = catalogueProviderId(kind)
  const own = find(pid, modelId)
  if (own) return own
  const bare = modelId.includes("/") ? (modelId.split("/").at(-1) ?? modelId) : modelId
  if (bare !== modelId) {
    const b = find(pid, bare)
    if (b) return b
  }
  for (const first of ["anthropic", "openai", "google", "deepseek", "mistral", "xai", "moonshotai"]) {
    const m = find(first, bare)
    if (m) return m
  }
  return undefined
}

/** Newest tool-calling, non-deprecated models of a provider (ids), newest first. */
export function topModels(cat: Catalogue | undefined, kind: string, n = 20): string[] {
  const pid = catalogueProviderId(kind)
  const models = cat && pid ? cat.providers[pid] : undefined
  if (!models) return []
  return Object.entries(models)
    .filter(([, m]) => m.toolCall !== false && m.status !== "deprecated" && !/embed|whisper|tts|image|guard|audio|realtime|transcri/i.test(m.id))
    .sort((a, b) => (b[1].updated ?? "").localeCompare(a[1].updated ?? "") || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([id]) => id)
}
