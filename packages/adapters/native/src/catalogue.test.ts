import "./testing/env.ts"
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cataloguePath, loadCatalogue, lookupModel, refreshCatalogue, resetCatalogueState, slimCatalogue, topModels } from "./catalogue.ts"
import { nativeAdapter } from "./index.ts"
import { contextLimitFor, costUsd, priceFor, supportsVision } from "./pricing.ts"
import { TEST_STATE_DIR } from "./testing/env.ts"

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "testing", "models-dev.fixture.json"), "utf8"))
const DAY = 24 * 60 * 60 * 1000

function fixtureFetch(counter: { n: number }, body: unknown = FIXTURE, status = 200) {
  return async (url: string) => {
    counter.n++
    expect(url).toBe("https://models.dev/api.json")
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
  }
}

afterEach(() => resetCatalogueState())

describe("models.dev catalogue", () => {
  test("slim projection keeps cost, context, vision, tool_call and status", () => {
    const cat = slimCatalogue(FIXTURE, 1)
    expect(cat.providers.anthropic?.["claude-sonnet-4-5"]).toEqual({
      id: "claude-sonnet-4-5",
      cost: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 },
      context: 222000,
      vision: true,
      toolCall: true,
      updated: "2025-09-29",
    })
    expect(cat.providers.anthropic?.["claude-fixture-old"]?.status).toBe("deprecated")
    expect(slimCatalogue("garbage").providers).toEqual({})
  })

  test("fetched at most once a day into the cache file; stale data used when the fetch fails", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "baton-cat-")), "models-dev.json")
    const c = { n: 0 }
    const t0 = Date.parse("2026-10-01T00:00:00Z")
    const first = await refreshCatalogue({ path, fetch: fixtureFetch(c), now: t0 })
    expect(c.n).toBe(1)
    expect(first?.providers.openai?.["gpt-5"]?.context).toBe(400000)
    expect(existsSync(path)).toBe(true)
    // within a day: cached, no request
    await refreshCatalogue({ path, fetch: fixtureFetch(c), now: t0 + DAY / 2 })
    expect(c.n).toBe(1)
    // a day later: refreshed
    await refreshCatalogue({ path, fetch: fixtureFetch(c), now: t0 + DAY + 1 })
    expect(c.n).toBe(2)
    // failing fetch (HTTP error or throw) → stale cache returned, file untouched
    const stale = await refreshCatalogue({ path, fetch: fixtureFetch(c, {}, 500), now: t0 + 3 * DAY })
    expect(stale?.providers.anthropic).toBeDefined()
    const thrown = await refreshCatalogue({
      path,
      fetch: async () => {
        throw new Error("offline")
      },
      now: t0 + 4 * DAY,
    })
    expect(thrown?.providers.anthropic).toBeDefined()
    // nothing cached + no network → undefined (callers fall back to the built-in table)
    const none = await refreshCatalogue({
      path: join(mkdtempSync(join(tmpdir(), "baton-cat-")), "m.json"),
      fetch: async () => {
        throw new Error("offline")
      },
    })
    expect(none).toBeUndefined()
  })

  test("prices, context limits and vision come from the catalogue, with fallbacks", () => {
    const cat = slimCatalogue(FIXTURE, Date.now())
    expect(priceFor("claude-sonnet-4-5", "anthropic", undefined, cat)).toEqual({ input: 3.3, output: 16.5, cachedInput: 0.33, cacheWrite: 4.125 })
    // gateway id, normalised (4.5 → 4-5) and bare id lookups
    expect(lookupModel(cat, "openrouter", "moonshotai/kimi-k2")?.cost?.input).toBe(0.55)
    expect(lookupModel(cat, "openai-compatible", "anthropic/claude-sonnet-4.5")?.context).toBe(222000)
    // not in the catalogue → built-in table / defaults
    expect(priceFor("gpt-5-mini", "openai", undefined, cat)?.input).toBe(0.25)
    expect(priceFor("llama3.2", "ollama", undefined, cat)).toBeUndefined()
    expect(priceFor("x", "anthropic", { input: 1, output: 2, cacheWrite: 3 }, cat)).toEqual({ input: 1, output: 2, cachedInput: undefined, cacheWrite: 3 })
    expect(contextLimitFor("claude-fixture-new", "anthropic", cat)).toBe(500000)
    expect(contextLimitFor("claude-sonnet-4-5", "anthropic", undefined)).toBe(200000)
    expect(contextLimitFor("mystery-model", "ollama", undefined)).toBe(128000)
    expect(supportsVision("gpt-5", "openai", cat)).toBe(true)
    expect(supportsVision("moonshotai/kimi-k2", "openrouter", cat)).toBe(false)
    expect(supportsVision("mystery", "ollama", undefined)).toBeUndefined()
    // cache reads and writes are priced separately
    const p = priceFor("claude-sonnet-4-5", "anthropic", undefined, cat)
    expect(costUsd(p, { input: 1000, cacheRead: 600, cacheWrite: 300, output: 10 })).toBeCloseTo((100 * 3.3 + 600 * 0.33 + 300 * 4.125 + 10 * 16.5) / 1e6, 12)
  })

  test("topModels: newest tool-calling models first; deprecated and embeddings excluded", () => {
    const cat = slimCatalogue(FIXTURE, Date.now())
    expect(topModels(cat, "anthropic")).toEqual(["claude-fixture-new", "claude-sonnet-4-5"])
    expect(topModels(cat, "openai")).toEqual(["gpt-5"])
    expect(topModels(cat, "ollama")).toEqual([])
  })

  test("capabilities().models lists the detected provider's models from the cached catalogue", async () => {
    const path = cataloguePath()
    expect(path.startsWith(TEST_STATE_DIR)).toBe(true)
    const saved = { ...process.env }
    try {
      await refreshCatalogue({ path, fetch: fixtureFetch({ n: 0 }) })
      expect(loadCatalogue(path)).toBeDefined()
      process.env.ANTHROPIC_API_KEY = "test"
      await nativeAdapter.detect()
      expect(nativeAdapter.capabilities().models).toEqual(["claude-fixture-new", "claude-sonnet-4-5"])
    } finally {
      Object.assign(process.env, saved)
      if (!("ANTHROPIC_API_KEY" in saved)) delete process.env.ANTHROPIC_API_KEY
      rmSync(path, { force: true })
      await nativeAdapter.detect()
    }
  })
})
