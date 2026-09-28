/**
 * `baton watch` — linear, screen-reader-friendly mode: every event as one labelled line, and a
 * plain prompt that accepts the same input as the TUI (@mentions, /commands, !interrupt).
 * Approvals are listed with numbers; answer with /approve or /deny.
 */
import { createInterface } from "node:readline"
import type { BatonEvent } from "@batonsh/protocol"
import type { BatonClient } from "@batonsh/sdk"

export function describeEvent(e: BatonEvent, name: (id?: string) => string): string | undefined {
  const who = `[${name(e.agentId)}]`
  switch (e.type) {
    case "agent.spawned":
      return `[baton] started ${e.data.name} (${e.data.adapter}${e.data.label ? `, ${e.data.label}` : ""})`
    case "agent.exited":
      return `[baton] ${name(e.agentId)} stopped${e.data.reason ? `: ${e.data.reason}` : ""}`
    case "turn.started":
      return e.data.prompt ? `${who} task: ${e.data.prompt.split("\n")[0]}` : undefined
    case "turn.completed":
      return `${who} finished${e.data.stopReason && e.data.stopReason !== "end_turn" ? ` (${e.data.stopReason})` : ""}`
    case "message.completed":
      return e.data.role === "assistant" && e.data.text.trim() ? `${who} says: ${e.data.text.trim()}` : undefined
    case "tool.call":
      return `${who} tool: ${e.data.title}`
    case "tool.update":
      return e.data.status === "failed" ? `${who} tool failed: ${e.data.summary ?? ""}` : undefined
    case "permission.requested":
      return `${who} NEEDS APPROVAL: ${e.data.title} — type /approve or /deny`
    case "bus.message":
      return e.data.kind === "heartbeat" || e.data.kind === "progress"
        ? undefined
        : `[bus] ${name(e.data.from)} to ${name(e.data.to)}: ${e.data.body.split("\n")[0]}`
    case "workspace.merge":
      return e.data.status === "merged" || e.data.status === "failed" || e.data.status === "conflict"
        ? `${who} merge ${e.data.status}${e.data.detail ? `: ${e.data.detail}` : ""}`
        : undefined
    case "review.verdict":
      return `[review] ${name(e.data.reviewer)} on ${name(e.data.author)}: ${e.data.verdict} — ${e.data.notes.split("\n")[0]}`
    case "agent.attention":
      return e.data.reason === "clear" ? undefined : `${who} attention: ${e.data.reason}${e.data.detail ? ` (${e.data.detail})` : ""}`
    case "error":
      return `${who} error: ${e.data.message}`
    case "task.plan":
      return `[plan] ${e.data.status}${e.data.status === "proposed" ? " — type /plan approve or /plan reject <why>" : ""}`
    default:
      return undefined
  }
}

export async function runWatch(client: BatonClient): Promise<void> {
  const live = await client.live()
  const name = (id?: string) => (id ? (live.state.agents.get(id)?.name ?? (id === "user" ? "you" : id)) : "baton")
  const startSeq = live.state.lastSeq
  live.onEvent((e) => {
    if (e.seq <= startSeq) return
    const line = describeEvent(e, name)
    if (line) process.stdout.write(`${line}\n`)
  })
  const agents = [...live.state.agents.values()].filter((a) => a.status !== "exited")
  console.log(`[baton] watching ${live.state.projectName}: ${agents.length} agent(s) running. Type a task, @name message, /command, or /quit.`)
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false })
  for await (const raw of rl) {
    const text = raw.trim()
    if (!text) continue
    if (text === "/quit" || text === "/exit") break
    try {
      const r = await client.submit(text)
      if (r.output) console.log(`[baton] ${r.output}`)
      else if (r.routedTo.length) console.log(`[baton] sent to ${r.routedTo.join(", ")}`)
    } catch (e) {
      console.log(`[baton] error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  await live.stop()
}
