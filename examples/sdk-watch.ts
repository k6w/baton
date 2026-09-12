/**
 * Example: follow a Baton run from a script — prints tool calls and bus traffic,
 * auto-approves read-only requests. Run inside a project: `bun examples/sdk-watch.ts`
 */
import { connect } from "@batonsh/sdk"

const baton = await connect({ cwd: process.cwd(), clientName: "sdk-watch" })
const run = await baton.live()
const name = (id?: string) => (id ? (run.state.agents.get(id)?.name ?? id) : "baton")

run.onEvent((e) => {
  switch (e.type) {
    case "tool.call":
      console.log(`${name(e.agentId).padEnd(14)} ${e.data.title}`)
      break
    case "bus.message":
      if (e.data.kind !== "heartbeat") console.log(`${"⇄".padEnd(14)} ${name(e.data.from)} → ${name(e.data.to)}: ${e.data.body.split("\n")[0]}`)
      break
    case "permission.requested":
      if (e.data.kind === "read" || e.data.kind === "search") {
        const allow = e.data.options.find((o) => o.kind === "allow_once")
        void baton.respond(e.agentId!, e.data.requestId, allow?.optionId ?? null)
      }
      break
  }
})

const task = process.argv.slice(2).join(" ")
if (task) await baton.submit(task)
console.log(`watching ${run.state.projectName} — ctrl+c to stop (agents keep running)`)
