/**
 * Models each agent offers, asked once from the daemon (`agents.models`) and kept for the session.
 * Reactive: a picker or completion list that reads `modelsFor` redraws when the list arrives.
 */
import type { BatonClient } from "@batonsh/sdk"
import { createStore } from "solid-js/store"

const [cache, setCache] = createStore<Record<string, string[]>>({})
const asked = new Set<string>()

/** The models for an adapter (or profile): [] until the daemon answers, or when the agent can't say. */
export function modelsFor(client: BatonClient | undefined, adapter: string | undefined): string[] {
  if (!adapter) return []
  if (!asked.has(adapter) && client) {
    asked.add(adapter)
    client
      .call("agents.models", { adapter })
      .then((r) => setCache(adapter, r.models))
      .catch(() => setCache(adapter, []))
  }
  return cache[adapter] ?? []
}
