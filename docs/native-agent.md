# Baton agent (built-in, any model provider)

`adapter = "baton"` runs Baton's own coding agent in-process. Nothing needs to be installed: it talks to a model
provider directly (through the Vercel AI SDK), runs its own tool loop and reports everything as normal Baton
events: streamed text and thinking, tool calls with diffs and terminal output, permission requests, usage and cost.

Use it to put models without their own coding CLI on your team (local Ollama / LM Studio models, OpenRouter, Groq,
DeepSeek, any OpenAI-compatible endpoint), or to run a light worker on a cheap model next to Claude Code and Codex.

## Quick start

With `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` or `OPENROUTER_API_KEY` set, it works without any config:

```toml
[agents.helper]
adapter = "baton"
model = "claude-sonnet-4-5"      # optional; defaults: anthropic → claude-sonnet-4-5, openai → gpt-5
```

If no provider is configured, it checks the environment in this order: `ANTHROPIC_API_KEY` → Anthropic,
`OPENAI_API_KEY` → OpenAI, `OPENROUTER_API_KEY` → OpenRouter. If none is set, the agent fails to start and the error
explains what to set. When no provider is configured, a `kind/` prefix on the model also picks the provider, but only
if that provider can be used (it is local, or its key is set). For example, `model = "ollama/qwen2.5-coder"` selects
Ollama.

## Providers

Point the agent at a `[providers.<name>]` entry:

```toml
[agents.local]
adapter = "baton"
provider = "ollama"
model = "qwen2.5-coder:14b"

[providers.ollama]
kind = "ollama"                      # base_url defaults to http://localhost:11434/v1

[agents.kimi]
adapter = "baton"
provider = "openrouter"
model = "moonshotai/kimi-k2"

[providers.openrouter]
kind = "openrouter"                  # base_url defaults to https://openrouter.ai/api/v1
api_key = "env:OPENROUTER_API_KEY"

[providers.work-gateway]
kind = "openai-compatible"
base_url = "https://llm.internal.example.com/v1"
api_key = "keychain:llm-gateway"
headers = { "X-Team" = "platform" }
```

| `kind` | Backend | Default `base_url` | Key fallback |
|---|---|---|---|
| `anthropic` | `@ai-sdk/anthropic` | Anthropic API | `ANTHROPIC_API_KEY` |
| `openai` | `@ai-sdk/openai` (Responses API) | OpenAI API | `OPENAI_API_KEY` |
| `openai-compatible` | `@ai-sdk/openai-compatible` | none (required) | none |
| `ollama` | openai-compatible | `http://localhost:11434/v1` | none |
| `lmstudio` | openai-compatible | `http://localhost:1234/v1` | none |
| `openrouter` | openai-compatible | `https://openrouter.ai/api/v1` | `OPENROUTER_API_KEY` |
| `groq`, `deepseek`, `together`, `fireworks`, `mistral`, `xai` | openai-compatible | the vendor's API | `<VENDOR>_API_KEY` |

`base_url`, `api_key` and `headers` from the provider entry always win. `bedrock`, `vertex` and `azure` are only
supported through an OpenAI-compatible gateway: give them a `base_url`.

## Approval modes

| `approval` | What asks first |
|---|---|
| `ask` | file edits and commands |
| `auto-edit` | commands |
| `auto` | only obviously destructive commands (`rm -rf`, `git push --force`, `git reset --hard`, `sudo`, `curl … \| sh`, …) |
| `yolo` | nothing |

To ask, the agent sends a `permission.requested` with the standard options. Baton's policy engine or the user
answers it. **Always allow** and **Always deny** are remembered for the rest of the session, per tool and command
(for commands) or per tool and path (for edits). Reads, searches and MCP tools never ask. Changing autonomy while the
agent is running (`setApproval`) applies from the agent's next action.

## Tools

| Tool | Kind | Notes |
|---|---|---|
| `read_file` | read | numbered lines, `offset` / `limit` ranges, binary files are detected |
| `list_dir` | search | |
| `glob` | search | skips `node_modules`, `.git` and build directories |
| `grep` | search | uses `rg` if it is installed (respects `.gitignore`), otherwise a JS fallback |
| `write_file` | edit | creates parent directories; emits a diff |
| `edit_file` | edit | exact string replacement; must match exactly once unless `replace_all`; emits a diff |
| `run_command` | execute | `bash -lc` in the workspace root, no stdin, timeout (default 120 s), capped output, live terminal updates; on timeout or interrupt the whole process group is killed |

Every path is confined to the agent's working directory. Paths are resolved through symlinks, including dangling
ones, before the check, and anything outside the working directory is refused. Shell commands are not sandboxed.
They run with the user's permissions, which is why the approval modes above gate them.

## MCP and the bus

Every server in the session's `mcpServers` list is connected over Streamable HTTP with its headers. Baton's own bus
server is always in that list. Each server's tools are offered to the model under their plain names
(`send_message`, `list_agents`, …). If two tools have the same name, the second one gets a server prefix. In the UI
they appear as `mcp__<server>__<tool>`, the same names Baton's policy rules match. Server instructions are added to
the system prompt. The clients are closed when the agent exits.

## Options (`[agents.<name>.options]`)

| Option | Default | |
|---|---|---|
| `maxSteps` | `40` | model steps per turn; the turn then ends with `stopReason = "max_steps"` |
| `contextTokens` | `120000` | transcript budget (about 4 chars per token). When it is exceeded, old tool outputs are replaced with a stub, then the oldest exchanges are dropped |
| `commandTimeoutMs` | `120000` | default `run_command` timeout (the model can pass its own, up to 30 min) |
| `maxOutputChars` | `30000` | cap on each tool output sent to the model (keeps the head and tail) |
| `temperature`, `maxOutputTokens` | provider default | |
| `providerOptions` | — | passed to the AI SDK as is, e.g. `{ anthropic = { thinking = { type = "enabled", budgetTokens = 8000 } } }` |
| `pricing` | built-in table | `{ input = 0.5, output = 1.5, cachedInput = 0.05 }` USD per million tokens |

## Behaviour

- **Streaming:** text and reasoning arrive as `message.delta` events (reasoning has role `thought`). Usage is reported
  after every model step as cumulative `usage.updated`. Cost comes from token counts and a small price table of
  common Anthropic, OpenAI, Google, DeepSeek, Kimi, Qwen and Grok models. Unknown models and local providers cost
  `0`.
- **Steering:** a steer message waits until the current model step or tool finishes. It is then added as a user
  message before the next model call. If it arrives while the model is writing its final answer, the agent takes one
  more step so the model sees it.
- **Queueing:** a `prompt()` sent while a turn is running starts its own turn after the current one ends.
- **Interrupt:** stops the model stream or the running tool (killing its process group) and emits
  `turn.interrupted`. Tool calls that were interrupted or never started are recorded as interrupted, so the
  conversation can continue.
- **Resume:** conversations are kept **in memory, keyed by the session id**, for as long as the daemon is running.
  Restarting the daemon loses them. An unknown `resumeId` starts a fresh conversation and logs a warning.

## Known gaps

- Resume does not survive a daemon restart, and sessions cannot be forked.
- No sandbox for `run_command` beyond the working directory and approvals.
- No image input, no web fetch or search tool, no sub-agents. Delegation goes through the bus (`spawn_agent`,
  `send_message`).
- Context trimming estimates size from characters, not real token counts. It does not summarise.
- Anthropic prompt caching is not enabled automatically. Use `providerOptions` if you need it.
