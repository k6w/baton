/**
 * Fake stream-json agent CLI for tests. Run with `bun fake-cli.ts [flags]`.
 *
 * Reads NDJSON from stdin (user messages + control requests) and writes Claude-compatible
 * stream-json frames. FAKE_DIALECT=claude|amp|qwen selects the dialect quirks; FAKE_LOG appends
 * argv and every stdin frame (one JSON per line) for assertions.
 *
 * Scenarios, chosen by prompt text:
 *   "ping"  → assistant text "PONG", no tools
 *   "crash" → exit(3) mid-turn
 *   "grandchild" → spawns a long-lived `sleep` child (pid logged) and finishes the turn
 * FAKE_EXIT_ON_START=<code> exits immediately (before the initialize handshake).
 *   "fail"  → failing result frame
 *   "slow"  → edit, then a 3s window accepting steer / interrupt before finishing
 *   other   → stream deltas + Edit(notes.txt teh→the) + tool_result + final text + result
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

type Msg = Record<string, any>

const argv = process.argv.slice(2)
const dialect = process.env.FAKE_DIALECT ?? "claude"
const logFile = process.env.FAKE_LOG
const log = (o: unknown) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(o)}\n`)
}

if (argv.includes("--version")) {
  console.log("9.8.7 (Fake CLI)")
  process.exit(0)
}
log({ argv })

if (process.env.FAKE_EXIT_ON_START) {
  process.stderr.write("fatal: startup failed\n")
  process.exit(Number(process.env.FAKE_EXIT_ON_START))
}

const argValue = (flag: string) => {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}
const resumed = argValue("--resume") ?? (argv[0] === "threads" && argv[1] === "continue" ? argv[2] : undefined)
const sessionId = resumed ?? (dialect === "amp" ? `T-${crypto.randomUUID()}` : crypto.randomUUID())
const asksPermission =
  (dialect === "claude" && argValue("--permission-mode") === "default" && argValue("--permission-prompt-tool") === "stdio") ||
  (dialect === "qwen" && argValue("--approval-mode") === "default")

const out = (o: Msg) => process.stdout.write(`${JSON.stringify(o)}\n`)

process.on("SIGINT", () => {
  log({ signal: "SIGINT" })
  process.exit(130)
})

// ───────────────────────────── input ─────────────────────────────

const inbox: Msg[] = []
let eof = false
let interrupted = false
let wake: (() => void) | undefined
const pendingControl = new Map<string, (r: Msg) => void>()
const notify = () => {
  const w = wake
  wake = undefined
  w?.()
}
const waitInput = (ms: number) =>
  new Promise<void>((res) => {
    const t = setTimeout(() => {
      wake = undefined
      res()
    }, ms)
    wake = () => {
      clearTimeout(t)
      res()
    }
  })

const rl = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY })
rl.on("line", (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line) as Msg
  log({ stdin: m })
  if (m.type === "control_request") {
    const sub = m.request?.subtype
    if (sub === "interrupt") interrupted = true
    if (sub === "initialize" || sub === "interrupt" || sub === "set_model")
      out({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response: sub === "initialize" ? { commands: [] } : {} } })
    else out({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `unknown ${sub}` } })
  } else if (m.type === "control_response") {
    pendingControl.get(m.response?.request_id)?.(m.response)
    pendingControl.delete(m.response?.request_id)
  } else if (m.type === "user") inbox.push(m)
  notify()
})
rl.on("close", () => {
  eof = true
  notify()
})

const textOf = (m: Msg): string => {
  const c = m.message?.content
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((b: Msg) => (b.type === "text" ? b.text : "")).join("")
  return ""
}

// ───────────────────────────── output helpers ─────────────────────────────

let msgN = 0
let toolN = 0
let initSent = false
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function init() {
  if (initSent) return
  initSent = true
  if (dialect === "qwen")
    out({ type: "system", subtype: "session_start", uuid: crypto.randomUUID(), session_id: sessionId, model: "qwen3-coder-plus", qwen_code_version: "0.9.1" })
  else if (dialect === "amp")
    out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, tools: ["Read", "edit_file", "Bash"], mcp_servers: [] })
  else out({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sessionId, model: "fake-sonnet", claude_code_version: "9.8.7", tools: ["Edit"] })
}

const extra = (uuids: string[]) => (dialect === "claude" && uuids.length ? { user_message_uuids: uuids } : {})

async function say(text: string, uuids: string[], toolUse?: Msg) {
  const id = `msg_${++msgN}`
  if (dialect !== "amp") {
    out({ type: "stream_event", event: { type: "message_start", message: { id } }, parent_tool_use_id: null, session_id: sessionId })
    out({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, parent_tool_use_id: null })
    const mid = Math.ceil(text.length / 2)
    for (const part of [text.slice(0, mid), text.slice(mid)])
      out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } }, parent_tool_use_id: null })
    out({ type: "stream_event", event: { type: "content_block_stop", index: 0 }, parent_tool_use_id: null })
    out({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null })
  }
  await sleep(5)
  out({
    type: "assistant",
    message: { id, type: "message", role: "assistant", model: "fake", content: [{ type: "text", text }, ...(toolUse ? [toolUse] : [])] },
    parent_tool_use_id: null,
    session_id: sessionId,
    ...extra(uuids),
  })
}

function result(uuids: string[], ok: boolean, text: string) {
  const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }
  const base = { type: "result", session_id: sessionId, duration_ms: 10, num_turns: 1, usage }
  if (ok)
    out({
      ...base,
      subtype: "success",
      is_error: false,
      result: text,
      ...(dialect === "claude"
        ? {
            total_cost_usd: 0.0123,
            modelUsage: { "fake-sonnet": { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 0 } },
            ...extra(uuids),
            queued_turn_count: inbox.length,
          }
        : {}),
    })
  else
    out({
      ...base,
      subtype: "error_during_execution",
      is_error: true,
      ...(dialect === "amp" ? { error: text } : dialect === "qwen" ? { error: { message: text } } : { result: text }),
      ...extra(uuids),
    })
}

function editTool(): Msg {
  const id = `toolu_${++toolN}`
  const file = join(process.cwd(), "notes.txt")
  if (dialect === "amp") return { type: "tool_use", id, name: "edit_file", input: { path: file, old_str: "teh", new_str: "the" } }
  if (dialect === "qwen") return { type: "tool_use", id, name: "edit", input: { file_path: file, old_string: "teh", new_string: "the" } }
  return { type: "tool_use", id, name: "Edit", input: { file_path: file, old_string: "teh", new_string: "the" } }
}

let reqN = 0
function askPermission(tool: Msg): Promise<Msg> {
  const request_id = `cli_req_${++reqN}`
  return new Promise((res) => {
    pendingControl.set(request_id, res)
    out({
      type: "control_request",
      request_id,
      request: { subtype: "can_use_tool", tool_name: tool.name, input: tool.input, tool_use_id: tool.id, permission_suggestions: null, blocked_path: null },
    })
  })
}

// ───────────────────────────── turns ─────────────────────────────

async function runTurn(first: Msg) {
  interrupted = false
  const uuids = first.uuid ? [first.uuid] : []
  const text = textOf(first)
  init()
  if (text.includes("ping")) {
    await say("PONG", uuids)
    return result(uuids, true, "PONG")
  }
  if (text.includes("grandchild")) {
    // A long-lived child in the CLI's process group (like a tool's shell).
    const child = Bun.spawn(["sleep", "37"], { stdio: ["ignore", "ignore", "ignore"] })
    log({ child: child.pid })
    await say("spawned", uuids)
    return result(uuids, true, "spawned")
  }
  if (text.includes("crash")) {
    await say("about to crash", uuids)
    process.stderr.write("fatal: boom\n")
    process.exit(3)
  }
  if (text.includes("fail")) return result(uuids, false, "model exploded")

  const tool = editTool()
  await say("Fixing the typo.", uuids, tool)
  let denied = false
  if (asksPermission) {
    const r = await askPermission(tool)
    const behavior = r.response?.behavior
    if (behavior !== "allow") {
      denied = true
      if (r.response?.interrupt) interrupted = true
    }
  }
  const file = join(process.cwd(), "notes.txt")
  const original = existsSync(file) ? readFileSync(file, "utf8") : ""
  if (!denied) {
    await sleep(50) // tool execution latency
    writeFileSync(file, original.replace("teh", "the"))
  }
  const firstLine = original.split("\n")[0] ?? ""
  out({
    type: "user",
    message: {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: tool.id, content: denied ? "Permission denied" : "The file notes.txt has been updated.", is_error: denied },
      ],
    },
    parent_tool_use_id: null,
    session_id: sessionId,
    // Claude Code attaches the structured tool output (Amp/Qwen don't).
    ...(dialect === "claude" && !denied
      ? {
          tool_use_result: {
            filePath: file,
            oldString: "teh",
            newString: "the",
            originalFile: original,
            structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-${firstLine}`, `+${firstLine.replace("teh", "the")}`] }],
          },
        }
      : {}),
  })
  if (interrupted) return result(uuids, false, "interrupted")

  if (text.includes("slow")) {
    const until = Date.now() + 3_000
    while (Date.now() < until && !interrupted) {
      // Fold steering input into this turn (Claude: any queued message; Amp: steer:true only).
      const idx = inbox.findIndex((m) => dialect === "claude" || (dialect === "amp" && m.steer === true))
      if (idx >= 0) {
        const [m] = inbox.splice(idx, 1)
        if (m?.uuid) uuids.push(m.uuid)
        await say(`Steered: ${textOf(m ?? {})}`, m?.uuid ? [m.uuid] : [])
        break
      }
      await waitInput(until - Date.now())
    }
    if (interrupted) return result(uuids, false, "interrupted")
  }
  await say("Done.", [])
  result(uuids, true, "Done.")
}

for (;;) {
  const next = inbox.shift()
  if (next) {
    await runTurn(next)
    continue
  }
  if (eof) break
  await waitInput(60_000)
}
process.exit(0)
