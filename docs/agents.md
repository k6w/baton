# Agents, providers & plugins

## Supported agents

Run `baton agents` to see what's installed and logged in on your machine (and how: "Claude subscription",
"API key", …). `baton login [agent]` runs that agent's own sign-in (`claude auth login`, `codex login`,
`opencode auth login`, …); Baton never sees the credentials.

### Signing in, and your Claude subscription

Baton runs each agent's own, unmodified CLI with **your own login** — exactly how you'd use it in a terminal.
Logged in to Claude Code with a Claude Pro/Max/Team plan? The `claude` agent uses it; nothing else to set up.

What Baton deliberately does **not** do: read Claude Code's OAuth token (from the Keychain, `~/.claude`, or
`CLAUDE_CODE_OAUTH_TOKEN`) to call Anthropic's API from anything else — including Baton's own `baton` agent.
Anthropic's terms reserve subscription credentials for Claude Code and Anthropic's apps and forbid third-party
tools from routing requests through them or collecting the tokens
([Legal and compliance → Authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance)).
The same applies to ChatGPT logins in Codex. The `baton` agent instead finds credentials you provisioned for API
use: API keys in your environment, API-key entries in Codex's or OpenCode's auth files, or a local Ollama /
LM Studio — see [native-agent.md](native-agent.md).

| Adapter id | Agent | How Baton drives it | Mid-turn steering | Approvals in Baton |
|---|---|---|---|---|
| `claude` | Claude Code | Claude Agent SDK, streaming input + `canUseTool` | ✓ | ✓ |
| `codex` | OpenAI Codex | `codex app-server` (JSON-RPC, types generated from the installed version) | ✓ `turn/steer` | ✓ |
| `opencode` | OpenCode | `opencode serve` (HTTP + server-sent events) + `@opencode-ai/sdk` | queued | ✓ |
| `gemini`, `cursor`, `copilot`, `goose`, `qwen`, `kiro`, `droid`, `cline`, `auggie`, `kimi`, `kilo`, `mistral-vibe`, `junie`, `opencode-acp`, `claude-acp`, `codex-acp` | ACP agents | Agent Client Protocol over stdio (Baton is the client and provides `fs/*` and `terminal/*`) | queued | ✓ |
| `claude-cli`, `amp`, `qwen-stream` | stream-json CLIs | NDJSON in and out | ✓ where the CLI supports it | decided by the CLI's own permission mode |
| `aider`, `crush`, `agy` | prompt-taking CLIs | one process per turn in a pseudo-terminal; changes detected with a git snapshot and shown as diffs | queued | decided by the CLI |
| `exec` | any CLI | `command` + `args` with `{prompt}` / `{model}` placeholders | queued | decided by the CLI |
| `acp` | any ACP agent | `command` / `args` from config | queued | ✓ |
| `baton` | Baton's own agent, on **any model provider** (Anthropic, OpenAI, OpenRouter, Ollama, LM Studio, any OpenAI-compatible) | in-process agent loop (AI SDK) with file, search, edit and shell tools + Baton's bus over MCP — see [native-agent.md](native-agent.md) | ✓ | ✓ |
| `a2a` | any [A2A](https://a2a-protocol.org) agent | Agent2Agent JSON-RPC (v1.0 and v0.3), streaming or polling — see [a2a.md](a2a.md) | queued | decided by the remote agent |
| `mock` | simulated (no tokens) — with `options = { delegate = true }` a mock lead really runs the team through the bus: spawns workers, waits, summarises (offline tests and SDK scripts) | in-process | ✓ | ✓ |

"Queued" means a message sent while the agent is busy is delivered as soon as its current turn ends, or
immediately if you ask for `interrupt` delivery.

### What each adapter maps

All adapters emit the same events:
- streamed text and reasoning
- tool calls, titled the way the agent's own UI titles them (`Read(src/app.ts)`, `Ran git diff --stat`)
- edit diffs with real line numbers, and terminal output with exit codes
- the agent's plan or todo list, which drives the progress % on its card
- token usage and cost where the agent reports it
- permission requests

Codex sometimes edits files with shell commands (`sed -i`) instead of patches. The Codex adapter snapshots the
workspace with a private git index after such commands, so those edits still show up as diffs.

## Adding agents without code

Any ACP agent works through config:

```toml
[agents.my-agent]
adapter = "acp"
command = "my-agent"
args = ["--acp"]
env = { MY_AGENT_TELEMETRY = "0" }
```

Then `/spawn my-agent`, or let the orchestrator use it with `spawn_agent(adapter: "my-agent")`.
Profiles can wrap built-in adapters too (`adapter = "codex"` with a different model, role, approval mode
or provider).

Any CLI that takes a prompt as an argument works the same way:

```toml
[agents.mytool]
adapter = "exec"
command = "mytool"
args = ["run", "--quiet", "{prompt}"]     # {prompt} {model} {cwd}
```

## Model providers

A provider describes where a model comes from. It's separate from the adapter, which is the agent harness that runs it.

```toml
[providers.openrouter]
kind = "openai-compatible"
base_url = "https://openrouter.ai/api/v1"
api_key = "env:OPENROUTER_API_KEY"
models = { kimi = "moonshotai/kimi-k2" }

[agents.cheap-coder]
adapter = "opencode"
provider = "openrouter"
model = "kimi"
```

Each adapter translates the provider into whatever its agent understands:
- **Claude:** `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN` (Anthropic-compatible endpoints), or Bedrock/Vertex variables.
- **Codex:** `-c model_providers.*`.
- **OpenCode:** an injected provider config.
- **ACP agents:** the model is set through `session/set_model` or config options; ACP has no way to pass provider credentials.

Secrets can be `env:VAR`, `cmd:pass show openrouter`, `keychain:<service>` (macOS), or a literal value. They're
resolved when the agent starts and never written to the event log.

## Recipes

Recipes are reusable orchestration workflows: `/recipe <name> <task>`, the gallery (`/recipes`), or `baton run "/recipe best-of-3 …"`.
Built in: `best-of-3`, `plan-execute`, `research-implement`, `implement-review`, `debug-hypotheses`, `test-first`, `shard`.
Add your own as Markdown in `.baton/recipes/` or `~/.config/baton/recipes/`:

```md
---
name: release
description: Our release checklist
agents: 2 workers
---
Prepare release {task}: bump versions, update CHANGELOG.md, run the full test suite, and have a second agent review.
```

## Writing an adapter plugin

```ts
// .baton/plugins/echo.ts — plugins need no runtime imports (types are erased), so they run
// from any folder and from the compiled `baton` binary.
import type { AgentAdapter, BatonPlugin } from "@batonsh/sdk"

const id = () => crypto.randomUUID()

const echo: AgentAdapter = {
  id: "echo",
  displayName: "Echo",
  family: "custom",
  binaries: [],
  async detect() {
    return { installed: true, auth: "ok", protocols: ["in-process"] }
  },
  capabilities() {
    return { steer: false, interrupt: true, resume: false, fork: false, diff: false, usage: false, cost: false, permissions: false, mcp: false, models: [] }
  },
  async start(cfg, ctx) {
    ctx.emit({ type: "agent.status", data: { status: "ready" } })
    return {
      async prompt({ text }) {
        const turnId = id()
        ctx.emit({ type: "turn.started", data: { turnId, prompt: text } })
        ctx.emit({ type: "message.completed", data: { messageId: id(), role: "assistant", text: `echo: ${text}` } })
        ctx.emit({ type: "turn.completed", data: { turnId, stopReason: "end_turn" } })
      },
      async interrupt() {},
      async respondPermission() {},
      resumeId: () => undefined,
      async close() {
        ctx.emit({ type: "agent.exited", data: { code: 0 } })
      },
    }
  },
}

export default { name: "echo", adapters: [echo] } satisfies BatonPlugin
```

```toml
# .baton/config.toml
plugins = ["./.baton/plugins/echo.ts"]
```

Plugins listed in the global config load automatically. Plugins listed in a **project** config run code that
came with the repository, so they only load after you run `baton trust` in that project. Trust is pinned to the
plugin file's content: if it (or the list) changes, you have to trust it again. `baton trust --revoke` undoes it.
See [configuration.md](configuration.md#trusting-a-project) for the other settings that need trust.

Adapter checklist (`packages/adapters/testkit` has `startHarness` and a shared `contractSuite`):
- emit `turn.started`/`turn.completed` around every prompt, and `agent.status` `busy`/`ready`
- emit `tool.call` then `tool.update`, with `kind`, a human-readable `title`, and `diff` / `terminal` content
- emit `permission.requested` and wait for `respondPermission(requestId, optionId)`; when interrupted, answer `null`
- accept `cfg.mcpServers` (streamable HTTP). That's how your agent gets the `baton` bus tools
- never kill the agent mid-turn when `interrupt()` is available

## The bus tools every agent gets

| Tool | Who | What |
|---|---|---|
| `send_message(to, body, delivery?, kind?)` | everyone | `to` is a name, `orchestrator`, `*` or `role:<r>`; delivery is `queue`, `steer` or `interrupt`; `kind: "request"` means a result is expected |
| `read_inbox(wait_s?)` | everyone | consume messages addressed to you |
| `list_agents()` | everyone | names, adapters, status, label, progress and cost of every agent |
| `report_progress(percent, note?)` | everyone | shown on the agent's card and in the bus |
| `spawn_agent(adapter, task?, label?, model?, role?, count?)` | orchestrator (and workers if `budget.max_depth > 0`) | its results flow back to the spawner |
| `wait_for_results(agents?, timeout_s?)` | orchestrator | blocks until the given workers report |
| `plan_tasks(tasks)`, `update_task(id, state)` | orchestrator | the task plan (waits for approval when `plan_approval` is set) |
| `pick_agent(task, candidates?)` | orchestrator | ranks installed agents by their track record in this project on that kind of task and by cost per success; suggests a model tier |
| `get_diff(agent)`, `merge(agent)`, `sync(agent)`, `request_review(agent, reviewer?)` | orchestrator | review and land worker branches |
| `claim_files(paths)`, `release_files()`, `my_changes()` | everyone | file claims and your own unmerged changes |
| `submit_review(verdict, notes)` | reviewers | approve or request changes |
| `interrupt_agent`, `kill_agent`, `set_label` | orchestrator | |

Calls to these tools are approved automatically. Baton's own coordination never waits for a human.
