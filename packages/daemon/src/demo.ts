/**
 * Demo director: when the orchestrator is the mock adapter, turn each user request into a
 * convincing multi-agent run (spawn workers, dispatch, cross-agent chatter) with no real
 * agents and no tokens. Powers `baton demo` and the TUI screenshots/tests.
 */
import type { Runtime } from "./runtime.ts"

const LABELS = ["find typo", "verify fix", "typo tests", "changelog", "benchmark", "persona", "voice", "memory", "humor", "deploy"]
const CHATTER = [
  "tailwind landed · re-snap",
  "38 snaps drifted 1px",
  "need tokens as configmap",
  "#3b82f6 used 824×",
  "rebased on main, no conflicts",
  "tests green on my side",
  "can you take the CSS? I'm on the API",
  "found it: README.md:14",
]

export function attachDemoDirector(rt: Runtime, opts: { workers?: number; speed?: number } = {}): () => void {
  const speed = opts.speed ?? 1
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.delete(t)
      fn()
    }, ms * speed)
    timers.add(t)
  }
  const nextName = (vendor: string) => {
    let k = 1
    while (rt.findAgent(`${vendor}-${k}`)) k++
    return `${vendor}-${k}`
  }
  const unsubscribe = rt.store.subscribe((e) => {
    if (e.type !== "turn.started" || !e.agentId) return
    const orch = rt.orchestrator()
    if (!orch || orch.info.agentId !== e.agentId || orch.info.adapter !== "mock") return
    const prompt = e.data.prompt ?? ""
    if (prompt.startsWith("[baton]")) return // results coming back, not a new request
    const m = /(\d+)\s*(?:agents?|workers?|x|×)/i.exec(prompt)
    const n = Math.min(10, Math.max(1, m ? Number(m[1]) : (opts.workers ?? 5)))
    // a mixed team by default (what Baton is for); "claude" / "codex" in the prompt pins one vendor
    const adapterPersona = /\bclaude\b/i.test(prompt) ? "claude" : /\bcodex\b/i.test(prompt) ? "codex" : "mixed"
    const TEAM = ["claude", "codex", "gemini", "opencode"] as const
    rt.emit({ type: "orch.note", data: { text: `Dispatching to ${n} agents in parallel.` } }, orch.info.agentId)
    void (async () => {
      const spawned: string[] = []
      for (let i = 0; i < n; i++) {
        const vendor: string = adapterPersona === "mixed" ? (TEAM[i % TEAM.length] ?? "claude") : adapterPersona
        // the mock speaks claude or codex dialect; others use the generic one
        const persona = vendor === "claude" || vendor === "codex" ? vendor : "generic"
        try {
          const info = await rt.spawn({
            adapter: "mock",
            name: nextName(vendor),
            label: LABELS[i % LABELS.length],
            parentId: orch.info.agentId,
            approval: i === 1 ? "ask" : "auto",
            options: { persona, speed, seed: i * 7919 + 1 },
          })
          spawned.push(info.agentId)
          await rt.promptAgent(info.agentId, `${LABELS[i % LABELS.length]}: ${prompt}`, { from: orch.info.agentId })
        } catch {}
      }
      const chat = () => {
        if (spawned.length < 2) return
        const live = spawned.filter((id) => rt.agents.get(id)?.busy)
        if (live.length >= 2) {
          const a = live[Math.floor(Math.random() * live.length)] as string
          let b = live[Math.floor(Math.random() * live.length)] as string
          if (a === b) b = live[(live.indexOf(a) + 1) % live.length] as string
          try {
            rt.send({ from: a, to: b, body: CHATTER[Math.floor(Math.random() * CHATTER.length)] as string, kind: "chat", delivery: "steer" })
          } catch {}
        }
        if (spawned.some((id) => rt.agents.get(id)?.busy)) later(2500 + Math.random() * 3000, chat)
      }
      later(2000, chat)
    })()
  })
  return () => {
    unsubscribe()
    for (const t of timers) clearTimeout(t)
  }
}
