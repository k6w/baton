# A2A: Baton and other agents

Baton speaks [Agent2Agent (A2A)](https://a2a-protocol.org) in both directions:

- **Client.** The `a2a` adapter drives any remote A2A agent as a Baton agent. You can spawn it, give it tasks,
  interrupt it, and the lead can delegate to it like any other worker.
- **Server.** The daemon can expose the whole team (the lead plus its workers) as **one** A2A agent. Other
  agents, other orchestrators or another Baton can then send it coding tasks.

Both sides follow **A2A v1.0** (the current stable spec: JSON-RPC methods `SendMessage`,
`SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`, `ListTasks`, ProtoJSON payloads,
`A2A-Version: 1.0`). They also speak **v0.3** (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`,
`tasks/resubscribe`, `kind`-tagged objects), which most agents deployed today still use. Only the JSON-RPC
binding is implemented; gRPC and HTTP+JSON/REST are not.

## Using a remote A2A agent

```toml
# .baton/config.toml
[agents.researcher]
adapter = "a2a"

[agents.researcher.options]
url = "https://research-agent.example.com"   # base URL or the agent-card URL
tokenEnv = "RESEARCH_AGENT_TOKEN"            # or token = "…" (bearer), or headers = { "x-api-key" = "…" }
```

Then `/spawn researcher` (or let the lead spawn it).

| option | meaning |
| --- | --- |
| `url` | Agent base URL or agent-card URL. `args[0]` works too. |
| `endpoint` | JSON-RPC endpoint override. Skips the card's interface choice; the card becomes optional. |
| `token` / `tokenEnv` | Bearer token, or the name of the env var that holds it. |
| `headers` | Extra HTTP headers. |
| `protocolVersion` | `"1.0"` or `"0.3"` to force a dialect. By default the adapter uses what the card offers, preferring 1.0. |
| `streaming` | `false` turns streaming off even when the card supports it. |
| `blocking` | Non-streaming only. `true` sends one blocking `SendMessage`. The default returns right away and polls `GetTask`, so an interrupt can always cancel. |
| `pollIntervalMs` | Polling interval for `GetTask` (default 1000). |
| `cancelOnClose` | Cancel the running remote task when the agent is closed (default `true`). |

How it maps:

- **Discovery.** The adapter fetches `/.well-known/agent-card.json` (path-relative first, then at the origin),
  falling back to the older `/.well-known/agent.json`. The card's name shows as the agent's model, and its
  version as the agent's version.
- **Prompts.** Each prompt is one A2A message. It is streamed over SSE when `capabilities.streaming` is true.
- **Conversation.** The `contextId` is kept for the whole session, so later prompts continue the
  conversation. It is also the resume id.
- **Replies.** Text parts, status messages and text artifacts become assistant messages. Streamed artifact
  chunks (`append` / `lastChunk`) become message deltas. File and data parts appear as tool output.
- **Input needed.** `input-required` and `auth-required` end the Baton turn with the agent's question. Your
  next prompt continues the same task.
- **Outcomes.**

  | remote state | in Baton |
  | --- | --- |
  | `completed` | `turn.completed` |
  | `failed` / `rejected` | error and `turn.completed(error)` |
  | `canceled` | `turn.interrupted` |

- **Interrupt.** Interrupting the agent sends `CancelTask`.
- **Not supported.** Steering, diffs, permission prompts and MCP. A remote agent works on its own machine, so
  Baton's worktrees and the bus tools don't reach it. Talk to it with messages.

## Exposing your team as an A2A agent

```
baton a2a                 # serve on 127.0.0.1, random port; prints the URL and token
baton a2a --port 4780     # fixed port
baton a2a --stop
```

Or set `[a2a] autostart = true`.

- **Agent card.** `GET /.well-known/agent-card.json` (also `/.well-known/agent.json`) is public. It names the
  project, lists the skills `code`, `review` and `investigate`, sets `capabilities.streaming: true`, and lists
  both a v1.0 and a v0.3 JSON-RPC interface on the same endpoint. It also carries the v0.3 fields `url` and
  `protocolVersion`, so older clients work too.
- **Endpoint.** `POST /` (or `/a2a`). Each response uses the dialect of the method name in its request.
- **Auth.** With a token, every JSON-RPC call needs `Authorization: Bearer <token>`. The card advertises an
  HTTP bearer security scheme.
- **New task.** The message text, plus any data parts as JSON, goes to the lead. The task is `working` while
  the team works. Each of the lead's messages is streamed as a status update.
- **Completion.** The task completes once the lead's turn is over and every agent has been idle for about 2
  seconds. Workers' results flow back to the lead first. A completed task carries:
  - the lead's final message, as the status message and as a `response` artifact;
  - a `changes` artifact listing each agent's unmerged changes (text plus a data part).
- **Approvals.** If any agent waits for a human approval, the task becomes `input-required` and the question
  is its status message. Send a message on that task (same `taskId`) saying `allow` or `deny` to answer the
  oldest pending approval. Anything else leaves the task waiting. Approving in the TUI or the web view works
  too, and the task goes back to `working`.
- **More input.** A message with the `taskId` of a running task is passed to the lead. A finished task can't
  be continued: send a new message with the same `contextId`. All tasks reach the same lead, so the
  conversation carries over.
- **One at a time.** The team has one lead, so tasks run one after another. Later ones wait in `submitted`.
- **Cancel.** `CancelTask` interrupts the lead and every busy worker, and the task becomes `canceled`.
- **Reading tasks.** `GetTask` returns the task with its history (honouring `historyLength`). `ListTasks`
  filters by `contextId` and status. `SubscribeToTask` re-attaches to a running task.
- **Unsupported.** Push notifications return `-32003`, and the extended card returns `-32007`.

**Security.**

- Bound to 127.0.0.1 unless you choose a host.
- Use a token whenever anything other than this machine can reach the port. The connection is plain HTTP, so
  for remote callers put it behind Tailscale or a TLS tunnel and set `public_url`, which the card advertises.
- An A2A caller can make your agents act in this repository with your autonomy settings. Approvals still
  stop the task and need an answer.

## Example: Baton → Baton

```toml
# project B: use project A's team as one worker
[agents.team-a]
adapter = "a2a"
options = { url = "http://127.0.0.1:4780", tokenEnv = "TEAM_A_TOKEN" }
```
