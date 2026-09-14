/**
 * Dialect normalization: Amp and Qwen Code emit Claude-compatible stream-json, but with their own
 * tool names/inputs and a few differently named fields. Everything is rewritten into the Claude
 * Code shapes the shared ClaudeTranslator understands; native tool names are restored on the
 * resulting BEP `tool.call` events by the session.
 */

export type Dialect = "claude" | "amp" | "qwen"

type Input = Record<string, unknown>

export interface NormalizedTool {
  name: string
  input: Input
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
const obj = (v: unknown): Input => (v && typeof v === "object" && !Array.isArray(v) ? (v as Input) : {})

function defined(o: Input): Input {
  const out: Input = {}
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v
  return out
}

type Mapper = (i: Input) => NormalizedTool

/** Amp tool names → Claude Code equivalents. */
const AMP_TOOLS: Record<string, Mapper> = {
  Read: (i) => {
    const range = Array.isArray(i.read_range) ? i.read_range : undefined
    return { name: "Read", input: defined({ ...i, file_path: str(i.path) ?? str(i.file_path), offset: typeof range?.[0] === "number" ? range[0] : undefined }) }
  },
  create_file: (i) => ({ name: "Write", input: defined({ ...i, file_path: str(i.path) ?? str(i.file_path), content: str(i.content) ?? "" }) }),
  edit_file: (i) => ({
    name: "Edit",
    input: defined({
      ...i,
      file_path: str(i.path) ?? str(i.file_path),
      old_string: str(i.old_str) ?? "",
      new_string: str(i.new_str) ?? "",
      replace_all: i.replace_all,
    }),
  }),
  Bash: (i) => ({ name: "Bash", input: defined({ ...i, command: str(i.cmd) ?? str(i.command) ?? "" }) }),
  Grep: (i) => ({ name: "Grep", input: i }),
  glob: (i) => ({ name: "Glob", input: defined({ ...i, pattern: str(i.filePattern) ?? str(i.pattern) ?? "" }) }),
  list_directory: (i) => ({ name: "LS", input: i }),
  todo_write: (i) => ({ name: "TodoWrite", input: i }),
  Task: (i) => ({ name: "Task", input: i }),
  web_search: (i) => ({ name: "WebSearch", input: i }),
  read_web_page: (i) => ({ name: "WebFetch", input: i }),
}

/** Qwen Code (Gemini CLI lineage) tool names → Claude Code equivalents. */
const QWEN_TOOLS: Record<string, Mapper> = {
  read_file: (i) => ({ name: "Read", input: defined({ ...i, file_path: str(i.file_path) ?? str(i.absolute_path) ?? str(i.path) }) }),
  write_file: (i) => ({ name: "Write", input: defined({ ...i, file_path: str(i.file_path) ?? str(i.absolute_path), content: str(i.content) ?? "" }) }),
  edit: (i) => ({ name: "Edit", input: defined({ ...i, file_path: str(i.file_path) ?? str(i.absolute_path) }) }),
  replace: (i) => ({ name: "Edit", input: defined({ ...i, file_path: str(i.file_path) ?? str(i.absolute_path) }) }),
  run_shell_command: (i) => ({ name: "Bash", input: i }),
  glob: (i) => ({ name: "Glob", input: i }),
  grep_search: (i) => ({ name: "Grep", input: i }),
  search_file_content: (i) => ({ name: "Grep", input: i }),
  grep: (i) => ({ name: "Grep", input: i }),
  list_directory: (i) => ({ name: "LS", input: i }),
  web_fetch: (i) => ({ name: "WebFetch", input: i }),
  web_search: (i) => ({ name: "WebSearch", input: i }),
  todo_write: (i) => ({ name: "TodoWrite", input: i }),
  task: (i) => ({ name: "Task", input: i }),
  agent: (i) => ({ name: "Task", input: i }),
}

/** Native tool name/input → the Claude Code tool it corresponds to (identity when unknown). */
export function normalizeTool(dialect: Dialect, name: string, input: Input): NormalizedTool {
  const table = dialect === "amp" ? AMP_TOOLS : dialect === "qwen" ? QWEN_TOOLS : undefined
  const m = table?.[name]
  return m ? m(input) : { name, input }
}

export interface NormalizeHooks {
  /** A tool_use block was seen (called with native and normalized forms). */
  onToolUse?(id: string, native: NormalizedTool, normalized: NormalizedTool): void
}

/**
 * Rewrite one stdout message into Claude Code's shape. Returns a new object (the input is not
 * mutated) so `raw` on emitted events can still carry the native frame.
 */
export function normalizeMessage(dialect: Dialect, msg: Input & { type: string }, hooks: NormalizeHooks = {}): Input & { type: string } {
  if (msg.type === "system") {
    if (dialect === "qwen") {
      const out: Input & { type: string } = { ...msg }
      if (out.subtype === "session_start") out.subtype = "init"
      if (typeof out.qwen_code_version === "string" && out.claude_code_version === undefined) out.claude_code_version = out.qwen_code_version
      // session_start carries its details under `data` in some versions.
      const data = obj(out.data)
      if (out.subtype === "init") {
        if (out.session_id === undefined && typeof data.session_id === "string") out.session_id = data.session_id
        if (out.model === undefined && typeof data.model === "string") out.model = data.model
      }
      return out
    }
    return msg
  }
  if (msg.type === "assistant") {
    const message = obj(msg.message)
    if (!Array.isArray(message.content)) return msg
    let changed = false
    const content = (message.content as Input[]).map((b) => {
      if (b?.type !== "tool_use") return b
      const id = String(b.id)
      const native = { name: String(b.name ?? "tool"), input: obj(b.input) }
      const normalized = normalizeTool(dialect, native.name, native.input)
      hooks.onToolUse?.(id, native, normalized)
      if (normalized.name === native.name && normalized.input === native.input) return b
      changed = true
      return { ...b, name: normalized.name, input: normalized.input }
    })
    return changed ? { ...msg, message: { ...message, content } } : msg
  }
  return msg
}

/** Error text carried by an Amp/Qwen failure result or system error frame, if any. */
export function frameError(msg: Input): string | undefined {
  const e = msg.error
  if (typeof e === "string" && e) return e
  if (e && typeof e === "object" && typeof (e as Input).message === "string") return (e as Input).message as string
  return undefined
}
