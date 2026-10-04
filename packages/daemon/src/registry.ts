/**
 * Adapter registry. Built-in adapters are loaded lazily and defensively: a broken or
 * missing adapter must never take the daemon down.
 */

import { mockAdapter } from "@batonsh/adapter-mock"
import type { AgentAdapter, DetectResult } from "@batonsh/protocol"

type Loader = () => Promise<AgentAdapter[]>

const BUILTIN: Loader[] = [
  async () => [(await import("@batonsh/adapter-claude")).claudeAdapter],
  async () => [(await import("@batonsh/adapter-codex")).codexAdapter],
  async () => [(await import("@batonsh/adapter-opencode")).opencodeAdapter],
  async () => (await import("@batonsh/adapter-acp")).acpAdapters,
  async () => (await import("@batonsh/adapter-stream-json")).streamJsonAdapters,
  async () => (await import("@batonsh/adapter-exec")).execAdapters,
  async () => [(await import("@batonsh/adapter-native")).nativeAdapter],
  async () => [(await import("@batonsh/adapter-a2a")).a2aAdapter],
]

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>()
  private detected = new Map<string, DetectResult>()
  readonly loadErrors: string[] = []

  constructor() {
    this.register(mockAdapter)
  }

  register(a: AgentAdapter) {
    this.adapters.set(a.id, a)
  }

  async loadBuiltins(): Promise<void> {
    await Promise.all(
      BUILTIN.map(async (load) => {
        try {
          for (const a of await load()) if (a && !this.adapters.has(a.id)) this.register(a)
        } catch (e) {
          this.loadErrors.push(e instanceof Error ? e.message : String(e))
        }
      }),
    )
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()]
  }

  async detect(id: string, refresh = false): Promise<DetectResult | undefined> {
    if (!refresh && this.detected.has(id)) return this.detected.get(id)
    const a = this.adapters.get(id)
    if (!a) return undefined
    try {
      const d = await Promise.race([
        a.detect(),
        new Promise<DetectResult>((r) => setTimeout(() => r({ installed: false, auth: "unknown", protocols: [], notes: ["detect timed out"] }), 8000)),
      ])
      this.detected.set(id, d)
      return d
    } catch (e) {
      const d: DetectResult = { installed: false, auth: "unknown", protocols: [], notes: [String(e)] }
      this.detected.set(id, d)
      return d
    }
  }

  /** The adapter definitely can't run: not installed, or its CLI says it isn't signed in. Re-checks before saying so. */
  async unusable(id: string): Promise<string | undefined> {
    let d = await this.detect(id)
    if (d && (d.auth === "missing" || !d.installed)) d = await this.detect(id, true)
    if (!d) return undefined
    if (!d.installed && !d.notes?.includes("detect timed out")) return `${id} is not installed${d.authHint ? ` — ${d.authHint}` : ""}`
    if (d.auth === "missing") return `${id} is not signed in${d.authHint ? ` — ${d.authHint}` : ""}`
    return undefined
  }

  /** Forget what detect() found (after a login, or when a run reports an auth failure). */
  forget(id: string) {
    this.detected.delete(id)
  }

  async detectAll(refresh = false): Promise<(DetectResult & { id: string; displayName: string })[]> {
    return Promise.all(this.list().map(async (a) => ({ id: a.id, displayName: a.displayName, ...((await this.detect(a.id, refresh)) as DetectResult) })))
  }
}
