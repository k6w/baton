/**
 * `baton run "<task>"` — drive a run without the TUI. Streams a readable log (or raw BEP
 * JSON with --json) until the orchestrator and every worker are idle.
 */

import { formatCost } from "@batonsh/kernel"
import type { BatonEvent } from "@batonsh/protocol"
import type { BatonClient } from "@batonsh/sdk"
import { c } from "./style.ts"

export async function runHeadless(
  client: BatonClient,
  task: string,
  opts: { json?: boolean; timeoutS?: number; approve?: "ask" | "all" | "none" },
): Promise<number> {
  const live = await client.live()
  const name = (id?: string) => (id ? (live.state.agents.get(id)?.name ?? id) : "baton")
  let lastActivity = Date.now()
  let started = false
  live.onEvent((e: BatonEvent) => {
    lastActivity = Date.now()
    if (e.type === "turn.started") started = true
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(e)}\n`)
    } else {
      const who = c.bold(name(e.agentId))
      switch (e.type) {
        case "agent.spawned":
          console.log(`${c.green("+")} ${c.bold(e.data.name)} ${c.dim(`${e.data.adapter}${e.data.label ? ` · ${e.data.label}` : ""}`)}`)
          break
        case "tool.call":
          console.log(`${who} ${c.dim("●")} ${e.data.title}`)
          break
        case "tool.update":
          if (e.data.status === "failed") console.log(`${who}   ${c.red("✗")} ${e.data.summary ?? "failed"}`)
          break
        case "message.completed":
          if (e.data.role === "assistant") console.log(`${who} ${e.data.text}`)
          break
        case "bus.message":
          if (e.data.kind !== "heartbeat" && e.data.kind !== "progress")
            console.log(`${c.cyan("⇄")} ${name(e.data.from)} → ${name(e.data.to)} ${c.dim(e.data.body.split("\n")[0] ?? "")}`)
          break
        case "permission.requested":
          console.log(`${who} ${c.yellow("?")} ${e.data.title}`)
          break
        case "error":
          console.log(`${who} ${c.red("✗")} ${e.data.message}`)
          break
      }
    }
    if (e.type === "permission.requested" && opts.approve && opts.approve !== "ask") {
      const want = opts.approve === "all" ? "allow_once" : "reject_once"
      const opt = e.data.options.find((o) => o.kind === want)
      void client.respond(e.agentId!, e.data.requestId, opt?.optionId ?? null)
    }
  })
  await client.submit(task)
  const deadline = Date.now() + (opts.timeoutS ?? 3600) * 1000
  while (Date.now() < deadline) {
    await Bun.sleep(500)
    const agents = [...live.state.agents.values()].filter((a) => a.status !== "exited")
    const busy = agents.some((a) => a.status === "busy" || a.status === "starting" || a.status === "awaiting_approval")
    if (started && !busy && Date.now() - lastActivity > 2500) break
  }
  const t = live.state.totals
  if (!opts.json) console.log(c.dim(`\n${t.toolCalls} tool calls · +${t.added} -${t.removed} · ${formatCost(t.costUsd)}`))
  await live.stop()
  return 0
}
