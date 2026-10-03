# Baton agent (built-in, any model provider)

`adapter = "baton"` runs Baton's own coding agent in-process. Nothing needs to be installed: it talks to a model
provider directly (through the Vercel AI SDK), runs its own tool loop and reports everything as normal Baton
events: streamed text and thinking, tool calls with diffs and terminal output, permission requests, usage and cost.

Use it to put models without their own coding CLI on your team (local Ollama / LM Studio models, OpenRouter, Groq,
DeepSeek, any OpenAI-compatible endpoint), or to run a light worker on a cheap model next to Claude Code and Codex.

## Quick start

With an API key in the environment (or one of the other credentials listed below), it works without any config:

```toml
[agents.helper]
adapter = "baton"
model = "claude-sonnet-4-5"      # optional; defaults: anthropic → claude-sonnet-4-5, openai → gpt-5
```

When no provider is configured, a `kind/` prefix on the model picks the provider, but only if that provider can be
used (it is local, or its key is set). For example, `model = "ollama/qwen2.5-coder"` selects Ollama.

## Credential detection

If no provider is configured, the agent looks for a credential in this order and uses the first one it finds:

1. Environment keys: `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `OPENROUTER_API_KEY` → `GEMINI_API_KEY` /
   `GOOGLE_GENERATIVE_AI_API_KEY` (through Gemini's OpenAI-compatible endpoint
   `https://generativelanguage.googleapis.com/v1beta/openai/`) → `GROQ_API_KEY` → `DEEPSEEK_API_KEY` →
   `MISTRAL_API_KEY` → `XAI_API_KEY`.
2. Codex's `~/.codex/auth.json` (or `$CODEX_HOME/auth.json`), **only** its `OPENAI_API_KEY` field, which is set when
   you log in to Codex with an API key. Codex's ChatGPT login tokens are never used.
3. OpenCode's `~/.local/share/opencode/auth.json` (or `$XDG_DATA_HOME/opencode/auth.json`), **only** entries with
   `"type": "api"`. Provider ids map to kinds: `anthropic`, `openai`, `openrouter`, `google` → `gemini`, `groq`,
   `deepseek`, `mistral`, `xai`, `togetherai` → `together`, `fireworks-ai` → `fireworks`, `deepinfra`,
   `moonshotai` → `moonshot`. `"oauth"` entries (subscription logins) are ignored.
4. A local Ollama (`GET http://127.0.0.1:11434/api/tags`, or `$OLLAMA_HOST`, 300 ms timeout). It picks an installed
   coding model if there is one (`*coder*`, then devstral / qwen3 / deepseek …), otherwise the first non-embedding
   model.
5. LM Studio (`GET http://127.0.0.1:1234/v1/models`, or `$LMSTUDIO_BASE_URL`).

`baton doctor` / `detect()` reports which source would be used (`auth = ok`, with a note naming the source but never
the key). If nothing is found, it reports `auth = missing` with a hint listing these options, and the agent fails to
start with the same explanation. Secret values are never logged.

### Claude subscriptions are not used

The Baton agent only uses credentials that you created for API use. It never reads the Claude Code keychain item,
`~/.claude/.credentials.json`, `CLAUDE_CODE_OAUTH_TOKEN` or any other OAuth or session token. Anthropic's terms do not
allow third-party apps to use Claude subscription (Pro/Max) credentials
([legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)). **To use your Claude subscription,
use the `claude` agent, which runs Claude Code with your own login.** For the same reason, Codex ChatGPT tokens and
OpenCode OAuth logins are skipped.

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
| `gemini` (alias `google`) | openai-compatible | `https://generativelanguage.googleapis.com/v1beta/openai` | `GEMINI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY` |
| `groq`, `deepseek`, `together`, `fireworks`, `mistral`, `xai`, `deepinfra`, `moonshot` | openai-compatible | the vendor's API | `<VENDOR>_API_KEY` |

`base_url`, `api_key` and `headers` from the provider entry always win. `bedrock`, `vertex` and `azure` are only
supported through an OpenAI-compatible gateway: give them a `base_url`.

## Approval modes

| `approval` | What asks first |
|---|---|
| `ask` | file edits and commands |
| `auto-edit` | commands |
| `auto` | only obviously destructive commands (`rm -rf`, `git push --force`, `git reset --hard`, `sudo`, `curl … \| sh`, …) |
| `yolo` | nothing |

`web_fetch` asks only in `ask` mode (permission kind `fetch`, remembered per host).

To ask, the agent sends a `permission.requested` with the standard options. Baton's policy engine or the user
answers it. The daemon emits `permission.resolved` itself when it answers, so the agent does not. **Always allow** and **Always deny** are remembered for the rest of the session, per tool and command
(for commands) or per tool and path (for edits). Reads, searches and MCP tools never ask. Changing autonomy while the
agent is running (`setApproval`) applies from the agent's next action.

## Tools

| Tool | Kind | Notes |
|---|---|---|
| `read_file` | read | numbered lines, `offset` / `limit` ranges, binary files are detected; png / jpg / gif / webp images are shown to vision models (see Images) |
| `list_dir` | search | |
| `glob` | search | skips `node_modules`, `.git` and build directories |
| `grep` | search | uses `rg` if it is installed (respects `.gitignore`), otherwise a JS fallback |
| `write_file` | edit | creates parent directories; emits a diff |
| `edit_file` | edit | exact string replacement; must match exactly once unless `replace_all`; emits a diff |
| `run_command` | execute | `bash -lc` in the workspace root, no stdin, timeout (default 120 s), capped output, live terminal updates; on timeout or interrupt the whole process group is killed; sandboxed (see below) |
| `web_fetch` | fetch | GET an http(s) URL; see below |

Every path is confined to the agent's working directory. Paths are resolved through symlinks, including dangling
ones, before the check, and anything outside the working directory is refused.

When one model step asks for several read-only tools in a row (`read_file`, `list_dir`, `glob`, `grep`,
`web_fetch`, and MCP tools whose server marks them `readOnlyHint`), they run at the same time. Edits, commands and
anything that needs approval run one by one, in order. `tool.call` events and the results the model sees always keep
the order of the request.

### Sandbox for `run_command`

`options.sandbox = "auto"` (the default) runs every command in an OS sandbox:

- **macOS:** `sandbox-exec` with a generated profile. Commands can read everywhere, but can write only to the working
  directory, the temp directories (`/private/tmp`, `/private/var/folders`, `$TMPDIR`), `~/.cache` and the paths in
  `sandboxWritable`. In a git worktree, the main repository's git directory is writable too, so `git commit` works.
  Writing anywhere else fails with "Operation not permitted".
- **Linux:** `bwrap` (bubblewrap) when it is installed: `/` is mounted read-only and the same writable paths are bound
  read-write. Without `bwrap`, commands are not sandboxed and the agent logs a warning once.
- Network access is allowed unless `sandboxNetwork = false` (macOS: `(deny network*)`; Linux: `--unshare-net`).
- The `yolo` approval mode and `sandbox = "off"` turn the sandbox off.

The effective sandbox is logged when the session starts and whenever the approval mode changes it
(`run_command sandbox: seatbelt (writes: …; network: allowed)`). The usual package-manager caches are writable too
(`~/.bun/install/cache`, `~/.npm`, `~/.pnpm-store`, `~/Library/Caches`, `~/.cargo/registry`, `~/go/pkg/mod`,
`~/.gradle/caches`, `~/.m2/repository`, …) so installs and builds work; add anything else to `sandboxWritable`:

```toml
[agents.helper.options]
sandboxWritable = ["~/my-tool-cache"]
```

### `web_fetch`

Fetches an http(s) URL with GET. It follows up to 5 redirects and has a 15 s timeout. It downloads at most 2 MB and
returns at most about 20 000 characters, with a note when it truncates. HTML is converted to readable text: scripts,
styles and navigation are dropped, and headings, links (as `[text](url)`), lists and code blocks are kept. Other
schemes (`file:`, `ftp:` …) are refused. So are loopback, private, link-local and CGNAT addresses, checked again on
every redirect, unless `allowPrivateFetch = true`. The check resolves the host before connecting, so DNS rebinding
between the check and the request is not covered.

### Images

`read_file` on a png, jpg, gif or webp file (the extension and the file's magic bytes must agree) sends the image to
the model when the model accepts images. Support comes from the models.dev catalogue, or from the provider for known
Anthropic and OpenAI models; `vision = true / false` overrides it. Anthropic and OpenAI get the image inside the tool
result. OpenAI-compatible providers get it as a user message right after the tool results, because their tool
messages are text only. Images over 5 MB, and any image when the model has no vision, are replaced by a short text
note. Prompts themselves (`PromptInput`) are text only.

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
| `contextTokens` | the model's context window from models.dev, else a built-in table, else `128000` | the context window used for compaction |
| `compactThreshold` | `0.75` | compact when the prompt reaches this share of `contextTokens` |
| `compactKeepMessages` | `8` | recent messages kept verbatim when compacting |
| `commandTimeoutMs` | `120000` | default `run_command` timeout (the model can pass its own, up to 30 min) |
| `maxOutputChars` | `30000` | cap on each tool output sent to the model (keeps the head and tail) |
| `temperature`, `maxOutputTokens` | provider default | |
| `providerOptions` | — | passed to the AI SDK as is, e.g. `{ anthropic = { thinking = { type = "enabled", budgetTokens = 8000 } } }` |
| `pricing` | models.dev, then a built-in table | `{ input = 0.5, output = 1.5, cachedInput = 0.05, cacheWrite = 0.6 }` USD per million tokens |
| `promptCaching` | `true` | Anthropic prompt caching (see Behaviour) |
| `sandbox` | `"auto"` | `"off"` runs commands unsandboxed |
| `sandboxWritable` | `[]` | extra writable paths for the sandbox (`~/` is expanded) |
| `sandboxNetwork` | `true` | `false` blocks network access from commands |
| `allowPrivateFetch` | `false` | let `web_fetch` reach loopback and private addresses |
| `vision` | from models.dev / provider | force image support on or off |
| `fork` | `false` | with `resumeId`: continue a copy of that conversation under a new session id |

## Behaviour

- **Streaming:** text and reasoning arrive as `message.delta` events (reasoning has role `thought`). Usage is reported
  after every model step as cumulative `usage.updated`. `cachedInput` counts prompt-cache reads.
- **Pricing and models:** prices (input, output, cache read, cache write per million tokens) and context windows come
  from the [models.dev](https://models.dev) catalogue. It is fetched at most once a day (5 s timeout) in the background
  into `<stateDir>/models-dev.json`, as a slim copy of the fields Baton uses. A start never waits for it: the agent
  uses the cached copy, even a stale one, or a small built-in table of common models. Unknown models and local
  providers cost `0`. Set `BATON_OFFLINE=1` or `BATON_MODELS_DEV=off` to skip the download. The adapter's
  `capabilities().models` lists the newest tool-calling models (up to 20) of the detected provider from that cache,
  or the installed models of a local Ollama / LM Studio.
- **Anthropic prompt caching:** for `anthropic` providers, each request marks the system prompt (which also covers the
  tool definitions) and the last user or tool message with `cacheControl: ephemeral`. Cache reads and writes are
  reported in `usage.updated` and priced at the cache rates. Turn it off with `promptCaching = false`.
- **Compaction:** the agent tracks the prompt size the provider reports for each step, plus an estimate of what was
  added since. When the next prompt would exceed `compactThreshold` (75 %) of the context window, it makes one extra
  model call that summarises the middle of the conversation. The system prompt, the original task and the last
  `compactKeepMessages` messages stay verbatim. Tool results in the summarised part are dropped (the summary call
  sees the tool calls, not their output). The summary call's tokens count towards usage. The agent logs
  `orch.note: context compacted …` and emits a `(context compacted)` thought. If the summary call fails, it falls back
  to trimming: old tool outputs are replaced with a stub, then the oldest exchanges are dropped. It only tries again
  after the context grows by another 10 %. Character-based trimming at the full window size also stays on as a last
  guard.
- **Steering:** a steer message waits until the current model step or tool finishes. It is then added as a user
  message before the next model call. If it arrives while the model is writing its final answer, the agent takes one
  more step so the model sees it.
- **Queueing:** a `prompt()` sent while a turn is running starts its own turn after the current one ends.
- **Interrupt:** stops the model stream or the running tool (killing its process group) and emits
  `turn.interrupted`. Tool calls that were interrupted or never started are recorded as interrupted, so the
  conversation can continue.
- **Sessions, resume and fork:** after every turn and on close, the conversation is saved to
  `<stateDir>/native-sessions/<sessionId>.json`. The file is written atomically with mode `0600`, and the directory
  is `0700`. It holds the messages, the model, the provider id and kind, and the working directory, never API keys,
  headers or base URLs. `resumeId` therefore works across daemon restarts. A resumed session keeps its model unless
  the agent config pins one. `options.fork = true` together with a `resumeId` copies that conversation into a new
  session id and leaves the original untouched. Sessions not updated for 30 days are deleted (checked at most once a
  day). An unknown `resumeId` starts a fresh conversation and logs a warning.

## Known gaps

- No web search tool and no sub-agents. Delegation goes through the bus (`spawn_agent`, `send_message`).
- Prompts cannot carry images (`PromptInput` is text only). The model sees images only through `read_file`.
- On Linux without `bwrap`, and on other platforms, `run_command` is not sandboxed. The sandbox restricts writes and,
  optionally, network access. It does not restrict reads.
- `web_fetch`'s private-address guard does not cover DNS rebinding.
- Before the first reported usage (for example right after a resume or a compaction), the prompt size is estimated
  from characters.
