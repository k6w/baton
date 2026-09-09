/**
 * Record a real Claude Code session to a JSONL fixture for replay tests.
 *
 *   bun packages/adapters/claude/scripts/record.ts [scenario]
 *
 * Each line is either a raw SDKMessage or a baton marker: `{"_baton":"prompt",uuid,text}` when a
 * user message was sent, `{"_baton":"permission",…}` when canUseTool fired (auto-allowed).
 * Uses the cheap "haiku" model. Costs real tokens.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { AsyncQueue } from "@batonsh/protocol"
import { tempWorkspace } from "../../testkit/src/index.ts"
import { baseOptions, resolveBinary } from "../src/options.ts"

const scenarios: Record<string, { files: Record<string, string>; prompts: string[] }> = {
  hello: {
    files: { "README.md": "# hello\n" },
    prompts: ["Reply with exactly the word PONG and nothing else. Do not use tools."],
  },
  tools: {
    files: {
      "notes.txt": "line one\nline two\nteh quick brown fox\nline four\nline five\n",
      "app.ts": "export function add(a: number, b: number) {\n  return a + b\n}\n",
    },
    prompts: [
      [
        "Do these steps in order, using exactly the named tools, then reply with DONE:",
        "1. TodoWrite with three todos: 'read notes', 'fix typo', 'write hello'.",
        "2. Read notes.txt.",
        "3. Edit notes.txt to fix the typo 'teh' -> 'the' (Edit tool).",
        "4. Write a new file hello.ts containing exactly two lines: `export const hello = \"hi\"` and `export const n = 1`.",
        "5. Bash: run `wc -l notes.txt`.",
        "6. Use the Agent/Task tool (subagent_type general-purpose) with the prompt 'Read app.ts with the Read tool and reply with the function name only.'",
        "7. TodoWrite marking all three todos completed.",
      ].join("\n"),
    ],
  },
}

const name = process.argv[2] ?? "tools"
const sc = scenarios[name]
if (!sc) throw new Error(`unknown scenario ${name}`)
const binary = resolveBinary()
if (!binary) throw new Error("claude not found")
const cwd = tempWorkspace(sc.files)
const lines: string[] = []
const input = new AsyncQueue<SDKUserMessage>()
const q = query({
  prompt: input,
  options: {
    ...baseOptions({ agentId: "rec", name: "rec", cwd, model: "haiku", approval: "ask", mcpServers: [] }, binary),
    stderr: (d) => process.stderr.write(d),
    canUseTool: async (toolName, toolInput, opts) => {
      lines.push(JSON.stringify({ _baton: "permission", toolName, input: toolInput, toolUseID: opts.toolUseID }))
      return { behavior: "allow", updatedInput: toolInput }
    },
  },
})
const pending = [...sc.prompts]
const send = () => {
  const text = pending.shift()
  if (text === undefined) return input.close()
  const uuid = crypto.randomUUID()
  lines.push(JSON.stringify({ _baton: "prompt", uuid, text }))
  input.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid: uuid as never })
}
send()
try {
  for await (const m of q) {
    const raw = m as Record<string, unknown>
    // Hook frames echo the recording user's local plugins/hooks; not needed for replay.
    if (raw.type === "system" && String(raw.subtype).startsWith("hook_")) continue
    if (raw.type === "system" && raw.subtype === "init") {
      for (const k of ["slash_commands", "terminal_slash_commands", "skills", "plugins", "agents"]) raw[k] = []
      delete raw.memory_paths
    }
    lines.push(JSON.stringify(raw))
    if (m.type === "result") send()
  }
} catch (e) {
  // e.g. the CLI exits non-zero after an error result; keep what was received.
  console.error(`query ended: ${e instanceof Error ? e.message : String(e)}`)
}
// Make paths stable across recordings: the temp workspace becomes /work.
const out = lines.map((l) => l.split(`/private${cwd}`).join("/work").split(cwd).join("/work"))
const dir = join(import.meta.dir, "../src/fixtures")
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, `${name}.jsonl`), `${out.join("\n")}\n`)
console.error(`wrote ${out.length} lines`)
