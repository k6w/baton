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

## Python

`sdk-python/` is a client for the same protocol that uses only the standard library (Python 3.9+, `import baton`).
It discovers the project and starts the daemon the same way `connect()` does, and it can fold the event stream into a live run state:

```python
import baton

with baton.connect() as client:                        # autostarts `baton daemon` ($BATON_BIN or PATH)
    run = client.run_state()                           # replay + live: agents, approvals, autonomy, totals

    def approve_reads(e):                              # runs on a worker thread; may call the client
        d = e["data"]
        if d.get("kind") == "read":
            allow = next(o["optionId"] for o in d["options"] if o["kind"] == "allow_once")
            client.respond(e["agentId"], d["requestId"], allow)

    client.on_event(approve_reads, types=["permission.requested"])
    seq = run.last_seq
    client.submit("migrate the tests to pytest")
    run.wait_idle(timeout=900, since_seq=seq)
    for a in run.agents.values():
        print(a.name, a.status, a.diff, f"${a.cost:.3f}")
    for e in client.events(types=["bus.*"], timeout=5):   # iterator; break to unsubscribe
        print(e["data"]["body"])
```

Each control method has a wrapper (`submit`, `spawn`, `prompt`, `respond`, `send`, `set_autonomy`, `merge`, `diff`, `shutdown`, …), and `call(method, params)` reaches the rest.
Errors raise `baton.BatonError(code, message, data)`.
See `sdk-python/README.md` and `sdk-python/examples/`.
