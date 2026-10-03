# A2A: Baton and other agents

Baton speaks [Agent2Agent (A2A)](https://a2a-protocol.org) in both directions:

- **Client.** The `a2a` adapter drives any remote A2A agent as a Baton agent. You can spawn it, give it tasks,
  interrupt it, and the lead can delegate to it like any other worker.
- **Server.** The daemon can expose the whole team (the lead plus its workers) as **one** A2A agent. Other
  agents, other orchestrators or another Baton can then send it coding tasks.

Both sides follow **A2A v1.0** (the current stable spec: `SendMessage`, `SendStreamingMessage`, `GetTask`,
`ListTasks`, `CancelTask`, `SubscribeToTask`, the push-notification config methods, ProtoJSON payloads,
`A2A-Version: 1.0`). They also speak **v0.3** (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`,
`tasks/resubscribe`, `tasks/pushNotificationConfig/*`, `kind`-tagged objects), which most agents deployed
today still use.

| binding | client | server |
| --- | --- | --- |
| JSON-RPC 2.0 (v1.0 and v0.3) | yes | yes, `POST /` (or `/a2a`) |
| HTTP+JSON / REST (v1.0) | yes | yes, `/message:send`, `/tasks/{id}`, … (also under `/v1/…`) |
| gRPC | no | no |

gRPC is left out on purpose. It needs HTTP/2 trailers and a protobuf codec, and Bun's `fetch` and `Bun.serve`
offer neither, so it would mean `@grpc/grpc-js` + `protobufjs` (a second HTTP stack and a generated codec).
gRPC-web would need a proxy in front of every agent. The spec requires an agent to offer the same operations
on every binding it lists, so an agent that offers gRPC almost always offers JSON-RPC or REST too.

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

Any string option can be an `env:NAME` reference, for example `clientSecret = "env:RESEARCH_SECRET"`. The
agent's `env` is checked first, then the daemon's environment.

| option | meaning |
| --- | --- |
| `url` | Agent base URL or agent-card URL. `args[0]` works too. |
| `endpoint` | Endpoint override. Skips the card's interface choice, and the card becomes optional. JSON-RPC unless `transport = "rest"`. |
| `transport` | `"auto"` (default), `"jsonrpc"` or `"rest"`. Auto takes the first v1.0 interface the card lists, because the card lists its preferred one first. It falls back to v0.3 JSON-RPC. |
| `token` / `tokenEnv` | Bearer token, or the name of the env var that holds it. |
| `apiKey` | API key for an `apiKey` security scheme. It goes where the card says: header, query or cookie. |
| `basic` | `"user:password"` for an HTTP basic scheme. |
| `clientId`, `clientSecret` | OAuth2 client credentials, for `oauth2` and `openIdConnect` schemes. |
| `tokenUrl`, `oidcUrl`, `scopes`, `audience`, `clientAuth` | Overrides for the token endpoint and the OIDC discovery URL, extra scopes, an audience, and `clientAuth = "post"` to send the client secret in the form body instead of HTTP basic. |
| `securityScheme` | Use this scheme from the card (by name) instead of picking one. |
| `headers` | Extra HTTP headers. An `Authorization` header here wins over the schemes. |
| `protocolVersion` | `"1.0"` or `"0.3"` to force a dialect. By default the adapter uses what the card offers, preferring 1.0. |
| `streaming` | `false` turns streaming off even when the card supports it. |
| `blocking` | Non-streaming only. `true` sends one blocking `SendMessage`. The default returns right away and polls `GetTask`, so an interrupt can always cancel. |
| `pollIntervalMs` | Polling interval for `GetTask` (default 1000). |
| `reconnectAttempts`, `reconnectDelayMs` | Resubscribe attempts after a dropped stream (default 3), and the first backoff delay, which then doubles (default 500 ms). |
| `cancelOnClose` | Cancel the running remote task when the agent is closed (default `true`). |
| `requireSignedCard` | Refuse an agent whose card has no valid signature. Without it, an invalid signature only logs a warning. |
| `cardJwks` | Trusted signing keys, as a JWKS object or a URL. Pins the key instead of trusting the card's `jku`. |
| `pushUrl`, `pushToken`, `pushAuth` | Register this webhook with every message, if the card supports push. `pushAuth = { scheme = "Bearer", credentials = "…" }`. |
| `sendContext` | `false` stops the adapter from sending the session's system prompt as context (default `true`). |
| `steer` | `false` queues mid-turn input instead of sending it to the running task. |
| `permissions` | `false` shows yes/no questions as plain `input-required` turns instead of approval prompts. |

How it maps:

- **Discovery.** The adapter fetches `/.well-known/agent-card.json` (path-relative first, then at the origin),
  falling back to the older `/.well-known/agent.json`. The card's name shows as the agent's model, and its
  version as the agent's version.
- **Signed cards.** When a card has `signatures`, the adapter checks them. Each signature is a JWS over the
  RFC 8785 canonical JSON of the card without `signatures`. Verification supports EdDSA, ES256/384/512,
  RS256/384/512 and PS256/384/512. The key comes from the `jku` in the protected header, matched by `kid`, or
  from `cardJwks` if you set it. A `jku` key only proves the card wasn't changed relative to the host that
  serves the JWKS. Pin the key with `cardJwks` when you need to know who signed it.
- **Auth.** The adapter reads the card's `securitySchemes` and security requirements (v1.0 and v0.3
  shapes) and uses the first requirement it has credentials for:
  - HTTP bearer or basic.
  - API key, in a header, query parameter or cookie.
  - OAuth2 client credentials. The token URL comes from the card, from the server's RFC 8414 metadata, or
    from `tokenUrl`.
  - OpenID Connect. The token endpoint is discovered from `openIdConnectUrl`, then client credentials are
    used.

  Access tokens are cached until shortly before they expire. After a `401` the adapter gets a new token and
  retries once. A card with no schemes gets the plain `token` as a bearer token.
- **Prompts.** Each prompt is one A2A message. It is streamed over SSE when `capabilities.streaming` is true.
- **Context.** The session's system prompt (role, Baton instructions, at most 16k characters) is sent once,
  as a leading text part `Context from Baton …` of the first message of a new conversation. The part is
  tagged `metadata.baton.kind = "context"`. A2A has no system-prompt field, and most agents ignore unknown
  metadata, so a text part is the only place a remote model reliably sees it. Keeping it as a separate part
  leaves the user's text intact. Resumed sessions don't send it again.
- **Conversation.** The `contextId` is kept for the whole session, so later prompts continue the
  conversation. It is also the resume id.
- **Dropped streams.** If an SSE stream ends before the task reaches a final state, the adapter
  resubscribes (`SubscribeToTask`, `tasks/resubscribe` or REST `:subscribe`) with exponential backoff, up to
  `reconnectAttempts` times. After that it polls `GetTask`. Messages are deduplicated by id, and a snapshot of
  an artifact that was being streamed only adds the text that is new, so nothing is shown twice.
- **Steering.** Mid-turn input (steer) is sent as a follow-up message on the running task, with the same
  `taskId` and `contextId`. If the remote agent refuses messages on a working task, the input is queued as
  the next prompt instead, and later steers go straight to the queue.
- **Push.** With `pushUrl`, each message carries a push-notification config, so a webhook of yours gets the
  task's updates. The adapter itself still streams or polls.
- **Replies.** Text parts, status messages and text artifacts become assistant messages. Streamed artifact
  chunks (`append` / `lastChunk`) become message deltas. File and data parts appear as tool output.
- **Confirmations.** An `input-required` question that asks for a yes/no confirmation becomes a Baton
  approval prompt with Allow and Deny. Examples: "Do you approve…?", "Shall I proceed?", "(y/n)", `Reply
  "allow" or "deny"`. Your answer is sent as "yes" or "no" on the same task, and the turn goes on. A denial
  by timeout counts as "no".
- **Input needed.** Any other `input-required`, and every `auth-required`, ends the Baton turn with the
  agent's question. Your next prompt continues the same task.
- **Outcomes.**

  | remote state | in Baton |
  | --- | --- |
  | `completed` | `turn.completed` |
  | `failed` / `rejected` | error and `turn.completed(error)` |
  | `canceled` | `turn.interrupted` |

- **Interrupt.** Interrupting the agent sends `CancelTask`.
- **Not supported.** Diffs and MCP. A remote agent works on its own machine, so Baton's worktrees and the bus
  tools don't reach it. Talk to it with messages.

## Exposing your team as an A2A agent

```
baton a2a                 # serve on 127.0.0.1, random port; prints the URL and token
baton a2a --port 4780     # fixed port
baton a2a --stop
```

Or set `[a2a] autostart = true`.

- **Agent card.** `GET /.well-known/agent-card.json` (also `/.well-known/agent.json`) is public. It names the
  project, lists the skills `code`, `review` and `investigate`, and sets `capabilities.streaming` and
  `pushNotifications` to true. Its `supportedInterfaces` lists v1.0 JSON-RPC (`<base>/`), v1.0 HTTP+JSON
  (`<base>`) and v0.3 JSON-RPC. It also carries the v0.3 fields `url` and `protocolVersion`, so older clients
  work too.
- **Signed card.** The card is signed with an Ed25519 key that is generated once per project and kept at
  `<state dir>/a2a/<project hash>.ed25519.pem` (mode 0600). The signature is a JWS with protected header
  `{alg: "EdDSA", typ: "JOSE", kid, jku}`, computed over the RFC 8785 canonical JSON of the card without
  `signatures`. `kid` is the key's RFC 7638 thumbprint. The public key is a JWK at
  `GET /.well-known/jwks.json`, which `jku` points to.
- **JSON-RPC.** `POST /` (or `/a2a`). Each response uses the dialect of the method name in its request.
- **REST (HTTP+JSON, v1.0).** These routes also work under `/v1/…`:

  | route | operation |
  | --- | --- |
  | `POST /message:send` | send a message |
  | `POST /message:stream` | send a message, answered as an SSE stream of `StreamResponse` objects |
  | `GET /tasks?contextId=…&status=…&pageSize=…&pageToken=…&historyLength=…` | list tasks |
  | `GET /tasks/{id}?historyLength=…` | get a task |
  | `POST /tasks/{id}:cancel` | cancel a task |
  | `GET` or `POST /tasks/{id}:subscribe` | subscribe to a task as SSE. The spec's proto says GET, its prose says POST, so both work. |
  | `POST /tasks/{id}/pushNotificationConfigs` | create a push config |
  | `GET /tasks/{id}/pushNotificationConfigs` | list push configs |
  | `GET` or `DELETE /tasks/{id}/pushNotificationConfigs/{configId}` | get or delete a push config |
  | `GET /extendedAgentCard` | get the extended card |

  Errors are `google.rpc.Status` JSON, with the HTTP status from the spec's mapping and an `ErrorInfo`
  detail. For example, a missing task is `404` with reason `TASK_NOT_FOUND`.
- **Auth.** With a token, every JSON-RPC and REST call needs `Authorization: Bearer <token>`. The card,
  `jwks.json` and the CORS preflight are public. The card advertises an HTTP bearer security scheme.
- **Extended card.** With a token, `GetExtendedAgentCard` (REST: `GET /extendedAgentCard`) returns the card
  plus one skill per live agent (name, adapter, model, label), signed as well. Without a token,
  `capabilities.extendedAgentCard` is false and the call returns `UnsupportedOperation` (`-32004`), as the
  spec requires.
- **New task.** The message text, plus any data parts as JSON, goes to the lead. The task is `working` while
  the team works. Each of the lead's messages is streamed as a status update.
- **Whose output counts.** A task only collects the lead's turns that it started: the turn whose prompt is
  the text the task sent. It also collects later turns that carry `[baton]` results, but only when one of
  the task's own turns delegated work (spawned or messaged an agent). If someone types into the TUI while a
  task runs, that turn's messages don't go into the task's history or answer. The task still waits for the
  team to go quiet before it completes.
- **Completion.** The task completes once the lead's turn is over and every agent has been idle for about 2
  seconds. Workers' results flow back to the lead first. A completed task carries:
  - the lead's final message, as the status message and as a `response` artifact;
  - a `changes` artifact listing each agent's unmerged changes (text plus a data part).
- **Questions back.** Sometimes the lead's final message is a question to the requester: its last line ends
  with `?`, and no files changed and nothing was merged during the task. Then the task becomes
  `input-required` with that question, not `completed`. It stops holding the team, so queued tasks can run.
  A message with the same `taskId` is the answer: it goes to the lead and the task is `working` again. If
  another task is running, the answer waits in `submitted` until the team is free.
- **Approvals.** If any agent waits for a human approval, the task becomes `input-required` and the question
  is its status message. Send a message on that task (same `taskId`) saying `allow` or `deny` to answer the
  oldest pending approval. Anything else leaves the task waiting. Approving in the TUI or the web view works
  too, and the task goes back to `working`.
- **More input.** A message with the `taskId` of a running task is passed to the lead. A finished task can't
  be continued: send a new message with the same `contextId`. All tasks reach the same lead, so the
  conversation carries over.
- **One at a time.** The team has one lead, so tasks run one after another. Later ones wait in `submitted`.
- **Cancel.** `CancelTask` denies every pending approval in the team (resolved `by: "cancelled"`), then
  interrupts the lead and every busy worker. The task becomes `canceled`.
- **Reading tasks.** `GetTask` returns the task with its history (honouring `historyLength`). `ListTasks`
  filters by `contextId`, status and `statusTimestampAfter`. `SubscribeToTask` re-attaches to a running task.
- **Push notifications.** You can register webhooks per task in three ways:
  - `CreateTaskPushNotificationConfig` (v0.3: `tasks/pushNotificationConfig/set`) or its REST route.
  - Inline in `SendMessage`, as `configuration.taskPushNotificationConfig` (v0.3: `pushNotificationConfig`).
  - Get, list and delete work too.

  Each task allows up to 10 webhooks. How deliveries work:
  - **Payload.** v1.0 webhooks get every `StreamResponse` (status and artifact updates) as
    `application/a2a+json`. v0.3 webhooks get the task snapshot on each status change.
  - **Headers.** `Authorization: <scheme> <credentials>` from the config's `authentication`, and
    `X-A2A-Notification-Token: <token>`.
  - **Order and retries.** Deliveries to one webhook are sent in order. Each has a 10 s timeout. Network
    errors, `5xx`, `408` and `429` are retried with exponential backoff, 5 attempts in all starting at
    500 ms. Redirects are not followed.
  - **SSRF guard.** Only http(s) URLs without credentials are accepted. Loopback, private (RFC 1918, ULA),
    link-local (including `169.254.169.254`), CGNAT, multicast and unspecified addresses are refused, and so
    are `localhost`, `*.local` and `*.internal` names. Host names are resolved, and every resolved address
    is checked. The check runs when a webhook is registered and again before each delivery. Set
    `a2a.allow_private_push = true` to allow private targets (local testing, LAN setups).
- **Persistence.** Tasks are saved to `<state dir>/a2a/tasks-<project hash>.json` (mode 0600, written
  atomically at most every 250 ms) and reloaded when the endpoint starts. A saved task keeps its status,
  history, artifacts, `contextId` and push configs. The newest 500 tasks are kept. A task that was `working`,
  `submitted` or waiting on an approval when the daemon stopped comes back as `failed`, with a note to send a
  new message on the same `contextId`. Its webhooks are told. A task waiting on a question from the lead is
  still waiting after the restart.

**Security.**

- Bound to 127.0.0.1 unless you choose a host.
- Use a token whenever anything other than this machine can reach the port. The project's token, signing key
  and task store live in `<state dir>/a2a/` with mode 0600, and the task store includes webhook credentials. The connection is plain HTTP, so
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

## Known gaps

- **gRPC binding.** Not implemented on either side, for the reasons given above. Cards that only offer gRPC
  can't be used.
- **v0.3 HTTP+JSON.** v0.3's REST binding used `/v1/…` paths with a different JSON shape. The client
  doesn't speak it and picks the agent's JSON-RPC interface instead. The server's `/v1/…` routes take v1.0
  ProtoJSON.
- **Multi-tenant routing.** The client sends a card's `tenant` (as a path prefix for REST, and as
  `params.tenant` for JSON-RPC). The server serves one team and ignores tenants.
- **Push receiving.** The client registers webhooks (`pushUrl`) but doesn't run a webhook receiver of its
  own. It always streams or polls.
- **DNS rebinding.** The SSRF guard resolves the host name before each delivery, but `fetch` resolves it
  again. A hostile DNS server could answer differently in between. Use `a2a.allow_private_push = false`
  (the default) and HTTPS webhooks.
- **Card key trust.** A `jku` from the card proves the card wasn't changed relative to the host that
  serves the JWKS, not who signed it. Pin keys with `cardJwks` for that. The server doesn't rotate its key.
  Delete the `.ed25519.pem` file to get a new one.
- **Question detection is a heuristic.** A final message counts as a question when its last line ends with
  `?` and nothing changed during the task. Confirmation detection on the client works from phrasing. Both
  can be turned off: `permissions = false` on the client, and the server option `questionsAsInput: false`
  (not a config key yet).
- **Concurrent human input.** Attribution relies on the prompt each adapter reports in `turn.started`.
  For adapters that don't report it, the task claims the lead's next turns in order.
- **Diffs and MCP for remote agents.** These don't apply: a remote agent's files and tools are on its own
  machine.
