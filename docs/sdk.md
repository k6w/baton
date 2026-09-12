# SDK & protocol

The TUI is built only on the public client in `@batonsh/sdk`. Anything it can do, your scripts can do too.

```ts
import { connect } from "@batonsh/sdk"

const baton = await connect({ cwd: process.cwd() })     // starts the project daemon if needed
const run = await baton.live()                            // self-updating RunState
run.onEvent((e) => {
  if (e.type === "tool.call") console.log(run.state.agents.get(e.agentId!)?.name, e.data.title)
  if (e.type === "permission.requested" && e.data.kind === "read") {
    const allow = e.data.options.find((o) => o.kind === "allow_once")
    void baton.respond(e.agentId!, e.data.requestId, allow?.optionId ?? null)
  }
})

await baton.submit("migrate the tests to vitest")       // same as typing it in the TUI
const reviewer = await baton.spawn({ adapter: "codex", label: "review", approval: "auto-edit" })
await baton.prompt(reviewer.agentId, "review the latest diff", "steer")
await baton.send("*", "freeze: release in 10 minutes", { delivery: "interrupt" })
for await (const e of baton.events({ types: ["bus.*"] })) console.log(e.data)
```

**`run.state`** is the same fold the daemon runs: `agents` (status, usage, cost, diff stats, progress),
`feed(agentId)` (that agent's messages, tool calls, diffs and bus traffic), `bus`, `tasks`, `approvals`, `totals`.

## Control protocol

The protocol is JSON-RPC 2.0 over a Unix socket at `<project>/.baton/run/baton.sock` (or a path in `/tmp` for
deeply nested projects; see `.baton/run/socket-path`), one JSON message per line. Methods:

`hello` · `state.snapshot` · `events.subscribe {fromSeq?, types?, agentId?}` · `events.unsubscribe` ·
`events.query` · `input.submit {text}` · `agent.spawn` · `agent.prompt {agentId, text, delivery?}` ·
`agent.interrupt` · `agent.kill` · `agent.rename` · `agents.detect` · `bus.send` · `permission.respond` ·
`run.mode` · `config.get` · `daemon.shutdown`. Events arrive as `event` notifications. The types are in
`packages/protocol/src/control.ts`.

## Baton Event Protocol (BEP)

Every event is an envelope `{ id, seq, ts, runId, agentId?, taskId?, type, data }`, appended to SQLite
(`.baton/state.db`) and streamed to clients. The payload types are defined with zod in
`packages/protocol/src/events.ts`, and JSON Schema is available through `eventJsonSchema()`.

| Family | Types |
|---|---|
| run | `run.started` `run.ended` |
| agent | `agent.spawned` `agent.status` `agent.updated` `agent.session` `agent.exited` |
| turn | `turn.started` `turn.completed` `turn.interrupted` |
| content | `message.delta` `message.completed` (assistant / thought) |
| tools | `tool.call` `tool.update` (content: `text`, `diff` with numbered lines, `terminal`) |
| plan / usage | `plan.updated` `usage.updated` (cumulative or delta; `costUsd`) |
| permissions | `permission.requested` (ACP option kinds) `permission.resolved` (by user, policy, timeout or cancelled) |
| bus | `bus.message` (chat, request, reply, result, heartbeat, progress, …) `bus.delivered` |
| tasks | `task.created` `task.state` (A2A states) |
| budget / misc | `budget.warn` `budget.exceeded` `orch.mode` `orch.note` `error` `log` |

Set `BATON_KEEP_RAW=1` to also store each adapter's raw native events, which helps when debugging adapters.

## Headless

`baton run "<task>" --json` prints the BEP stream as one JSON object per line on stdout, which is handy for CI:

```sh
baton run "update the changelog for v2.3" --approve all --json | jq -c 'select(.type=="tool.call") | .data.title'
```
