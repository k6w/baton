/**
 * `baton run "<task>"` — drive a run without the TUI. Streams a readable log (or raw BEP
 * JSON with --json) until the orchestrator and every worker are idle.
 *
 * Approvals: --approve all|none answers them automatically; the default (ask) prompts on a
 * terminal and denies when there is nobody to ask (CI), so a run never hangs on a question.
 * Exit codes: 0 done · 1 the run failed (fatal error, failed turn, daemon gone) · 124 timeout.
 */
import { createInterface } from "node:readline/promises"

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
  let failed = false
  let daemonGone = false
  client.onClose(() => {
    daemonGone = true
  })
  // one question at a time on the terminal
  let asking: Promise<unknown> = Promise.resolve()
  const answer = (agentId: string, requestId: string, optionId: string | null) =>
    client.respond(agentId, requestId, optionId).catch((err: unknown) => {
      if (!opts.json) console.log(c.red(`  could not answer: ${err instanceof Error ? err.message : err}`))
    })
  live.onEvent((e: BatonEvent) => {
    lastActivity = Date.now()
    if (e.type === "turn.started") started = true
    if (e.type === "error" && e.data.fatal) failed = true
    if (e.type === "turn.completed" && e.data.stopReason === "error" && live.state.agents.get(e.agentId ?? "")?.isOrchestrator) failed = true
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
    if (e.type === "permission.requested" && e.agentId) {
      const agentId = e.agentId
      const { requestId, options, title } = e.data
      const pick = (allow: boolean) =>
        (allow
          ? (options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind.startsWith("allow")))
          : (options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind.startsWith("reject")))
        )?.optionId ?? null
      // the daemon's policy may settle it a moment later — only act on questions still open
      const open = () => live.state.approvals.has(requestId)
      if (opts.approve === "all" || opts.approve === "none") setTimeout(() => open() && void answer(agentId, requestId, pick(opts.approve === "all")), 200)
      else if (process.stdin.isTTY && !opts.json) {
        asking = asking.then(async () => {
          await Bun.sleep(200)
          if (!open()) return // answered elsewhere (TUI, policy, timeout)
          const rl = createInterface({ input: process.stdin, output: process.stdout })
          const a = (await rl.question(`  ${c.yellow("?")} allow ${c.bold(name(agentId))}: ${title} [y/N] `)).trim().toLowerCase()
          rl.close()
          if (live.state.approvals.has(requestId)) await answer(agentId, requestId, pick(a.startsWith("y")))
        })
      } else
        setTimeout(() => {
          if (!open()) return
          if (!opts.json) console.log(c.yellow("  denied (no terminal to ask) — pass --approve all to allow, or add a [[policy.rules]] allow rule"))
          void answer(agentId, requestId, pick(false))
        }, 200)
    }
  })
  await client.submit(task)
  const deadline = Date.now() + (opts.timeoutS ?? 3600) * 1000
  let timedOut = true
  while (Date.now() < deadline) {
    await Bun.sleep(500)
    if (daemonGone) {
      failed = true
      timedOut = false
      if (!opts.json) console.log(c.red("baton daemon went away"))
      break
    }
    const agents = [...live.state.agents.values()].filter((a) => a.status !== "exited")
    const busy = agents.some((a) => a.status === "busy" || a.status === "starting" || a.status === "awaiting_approval")
    if (started && !busy && Date.now() - lastActivity > 2500) {
      timedOut = false
      break
    }
  }
  const t = live.state.totals
  if (!opts.json) {
    console.log(c.dim(`\n${t.toolCalls} tool calls · +${t.added} -${t.removed} · ${formatCost(t.costUsd)}`))
    if (timedOut) console.log(c.yellow(`timed out after ${opts.timeoutS ?? 3600}s — agents keep running in the daemon (baton ps / baton stop)`))
  }
  if (!daemonGone) await live.stop().catch(() => {})
  return timedOut ? 124 : failed ? 1 : 0
}
