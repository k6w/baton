/**
 * Built-in workspace tools. Every path is confined to the session cwd (see workspace.ts).
 * Each tool returns the text the model sees plus BEP content (diffs, terminal output) for Baton.
 */
import { mkdirSync, readdirSync, statSync } from "node:fs"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, extname, join, relative } from "node:path"
import { augmentedPath, diffLines, diffStat, killProcessTree, runCapture, type ToolContent, type ToolKind, which } from "@batonsh/protocol"
import { z } from "zod"
import type { Sandbox } from "./sandbox.ts"
import { FETCH_MAX_CHARS, FetchRefused, webFetch } from "./webfetch.ts"
import type { Workspace } from "./workspace.ts"

/** "network" = web access (asks only under the `ask` approval mode). */
export type ToolCategory = "read" | "edit" | "execute" | "network" | "other"

export interface ToolImage {
  mediaType: string
  /** base64 */
  data: string
  bytes: number
}

export interface ToolOutcome {
  /** What the model sees. */
  output: string
  isError?: boolean
  /** Short line shown under the call in the UI. */
  summary?: string
  content?: ToolContent[]
  /** An image for the model (read_file on a picture, when the model has vision). */
  image?: ToolImage
}

export interface ToolRunContext {
  ws: Workspace
  signal: AbortSignal
  env: Record<string, string | undefined>
  /** Live progress (terminal output while a command runs). */
  progress(content: ToolContent[]): void
  commandTimeoutMs: number
  maxOutputChars: number
  /** Wraps run_command in an OS sandbox (kind "none" = unsandboxed). */
  sandbox?: Sandbox
  /** Can the model see images? */
  vision?: boolean
  /** web_fetch may reach loopback / private addresses. */
  allowPrivateFetch?: boolean
}

export interface BuiltinTool<I = Record<string, unknown>> {
  name: string
  description: string
  schema: z.ZodType<I>
  kind: ToolKind
  category: ToolCategory
  /** Safe to run concurrently with other read-only calls of the same step. */
  readOnly?: boolean
  title(input: I): string
  /** Remembered "always allow/deny" key. */
  permissionKey(input: I): string
  locations?(input: I, ws: Workspace): { path: string; line?: number }[]
  run(input: I, ctx: ToolRunContext): Promise<ToolOutcome>
}

const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", ".next", ".turbo", ".cache", "dist", "build", "target", "__pycache__", ".venv"])
const MAX_READ_LINES = 2000
const MAX_LINE_CHARS = 2000
const MAX_LIST = 1000
/** Images larger than this are not sent to the model (Anthropic's per-image limit is 5 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }

/** Media type of a png/jpg/gif/webp file: the extension must say image and the magic bytes must agree. */
export function imageType(path: string, buf: Uint8Array): string | undefined {
  if (!IMAGE_TYPES[extname(path).toLowerCase()]) return undefined
  const b = buf
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png"
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp"
  return undefined
}

function oneLine(s: string, max = 80): string {
  const line = s.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

function diffContent(ws: Workspace, abs: string, oldText: string | null, newText: string): { content: ToolContent; added: number; removed: number } {
  const lines = diffLines(oldText, newText)
  const { added, removed } = diffStat(lines)
  return { content: { type: "diff", path: ws.rel(abs), ...(oldText === null ? { oldText: null } : {}), lines, added, removed }, added, removed }
}

/** Keep the head and tail of long output. */
export function capOutput(text: string, max: number): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  return `${text.slice(0, half)}\n… [${text.length - 2 * half} characters omitted] …\n${text.slice(-half)}`
}

// ───────────────────────────── read_file ─────────────────────────────

const readFileTool: BuiltinTool<{ path: string; offset?: number; limit?: number }> = {
  name: "read_file",
  description:
    "Read a file from the workspace. Text is returned with numbered lines (`<n>\\t<line>`); use `offset` (1-based first line) and `limit` (number of lines) to read part of a large file. Images (png, jpg, gif, webp) are shown to you when the model supports vision.",
  schema: z.object({
    path: z.string().describe("File path, relative to the workspace root"),
    offset: z.number().int().min(1).optional().describe("1-based line to start reading at"),
    limit: z.number().int().min(1).optional().describe(`Max lines to return (default ${MAX_READ_LINES})`),
  }),
  kind: "read",
  category: "read",
  readOnly: true,
  title: (i) => `Read(${i.path})`,
  permissionKey: (i) => `read_file:${i.path}`,
  locations: (i, ws) => [{ path: safeRel(ws, i.path), ...(i.offset ? { line: i.offset } : {}) }],
  async run(i, { ws, vision }) {
    const abs = ws.resolve(i.path)
    const st = await stat(abs).catch(() => undefined)
    if (!st) return { output: `File not found: ${i.path}`, isError: true, summary: "Not found" }
    if (st.isDirectory()) return { output: `${i.path} is a directory — use list_dir`, isError: true, summary: "Is a directory" }
    if (st.size > 20 * 1024 * 1024) return { output: `${i.path} is too large (${st.size} bytes)`, isError: true, summary: "Too large" }
    const buf = await readFile(abs)
    const img = imageType(abs, buf)
    if (img) {
      const kb = Math.round(st.size / 1024)
      if (!vision) return { output: `${i.path} is an image (${img}, ${kb} KB). This model cannot view images.`, summary: "Image (not shown)" }
      if (st.size > MAX_IMAGE_BYTES)
        return {
          output: `${i.path} is an image (${img}, ${kb} KB) — too large to show (limit ${MAX_IMAGE_BYTES / 1024 / 1024} MB).`,
          summary: "Image too large",
        }
      return {
        output: `Image ${ws.rel(abs)} (${img}, ${kb} KB) — attached.`,
        summary: `Image (${kb} KB)`,
        image: { mediaType: img, data: Buffer.from(buf).toString("base64"), bytes: st.size },
      }
    }
    if (isBinary(buf)) return { output: `${i.path} is a binary file (${st.size} bytes)`, summary: "Binary file" }
    const all = buf.toString("utf8").split("\n")
    if (all.length > 1 && all.at(-1) === "") all.pop()
    const start = (i.offset ?? 1) - 1
    const end = Math.min(all.length, start + (i.limit ?? MAX_READ_LINES))
    const out: string[] = []
    for (let n = start; n < end; n++) {
      const line = all[n] ?? ""
      out.push(`${n + 1}\t${line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line}`)
    }
    let text = out.join("\n")
    if (all.length === 0 || (all.length === 1 && all[0] === "")) text = "(empty file)"
    else if (start >= all.length) text = `(file has only ${all.length} lines)`
    else if (end < all.length || start > 0) text += `\n\n(showing lines ${start + 1}-${end} of ${all.length}; use offset/limit to read more)`
    return { output: text, summary: `Read ${plural(Math.max(0, end - start), "line")}` }
  },
}

// ───────────────────────────── list_dir ─────────────────────────────

const listDirTool: BuiltinTool<{ path?: string }> = {
  name: "list_dir",
  description: "List the entries of a directory in the workspace (directories end with `/`, symlinks with `@`).",
  schema: z.object({ path: z.string().optional().describe("Directory, relative to the workspace root (default: root)") }),
  kind: "search",
  category: "read",
  readOnly: true,
  title: (i) => `List(${i.path || "."})`,
  permissionKey: (i) => `list_dir:${i.path ?? "."}`,
  async run(i, { ws }) {
    const abs = ws.resolve(i.path)
    const entries = await readdir(abs, { withFileTypes: true }).catch((e: NodeJS.ErrnoException) => {
      throw new Error(e.code === "ENOTDIR" ? `${i.path} is not a directory` : e.code === "ENOENT" ? `Directory not found: ${i.path}` : e.message)
    })
    const names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.isSymbolicLink() ? `${e.name}@` : e.name))
      .sort((a, b) => Number(b.endsWith("/")) - Number(a.endsWith("/")) || a.localeCompare(b))
    const shown = names.slice(0, MAX_LIST)
    const more = names.length > shown.length ? `\n… and ${names.length - shown.length} more` : ""
    return { output: shown.join("\n") + more || "(empty directory)", summary: plural(names.length, "entry").replace("entrys", "entries") }
  },
}

// ───────────────────────────── glob ─────────────────────────────

const globTool: BuiltinTool<{ pattern: string; path?: string }> = {
  name: "glob",
  description: "Find files by glob pattern (e.g. `src/**/*.ts`, `**/*.test.*`). Skips node_modules and .git. Returns workspace-relative paths.",
  schema: z.object({
    pattern: z.string().describe("Glob pattern"),
    path: z.string().optional().describe("Directory to search from (default: root)"),
  }),
  kind: "search",
  category: "read",
  readOnly: true,
  title: (i) => `Glob(${i.pattern}${i.path ? ` in ${i.path}` : ""})`,
  permissionKey: (i) => `glob:${i.pattern}`,
  async run(i, { ws, signal }) {
    const dir = ws.resolve(i.path)
    const explicitSkip = [...SKIP_DIRS].some((d) => i.pattern.includes(d))
    const out: string[] = []
    let total = 0
    for await (const rel of new Bun.Glob(i.pattern).scan({ cwd: dir, onlyFiles: true, followSymlinks: false, dot: true })) {
      if (signal.aborted) break
      if (!explicitSkip && rel.split(/[\\/]/).some((seg) => SKIP_DIRS.has(seg))) continue
      let abs: string
      try {
        abs = ws.resolve(join(dir, rel))
      } catch {
        continue
      }
      total++
      if (out.length < MAX_LIST) out.push(ws.rel(abs))
    }
    out.sort()
    const more = total > out.length ? `\n… and ${total - out.length} more (narrow the pattern)` : ""
    return { output: out.join("\n") + more || "(no matches)", summary: plural(total, "file") }
  },
}

// ───────────────────────────── grep ─────────────────────────────

const grepTool: BuiltinTool<{ pattern: string; path?: string; glob?: string; ignore_case?: boolean; max_results?: number }> = {
  name: "grep",
  description:
    "Search file contents with a regular expression (ripgrep syntax). Returns `path:line:text` matches. Respects .gitignore when ripgrep is installed.",
  schema: z.object({
    pattern: z.string().describe("Regular expression"),
    path: z.string().optional().describe("File or directory to search (default: root)"),
    glob: z.string().optional().describe("Only search files matching this glob, e.g. `*.ts`"),
    ignore_case: z.boolean().optional(),
    max_results: z.number().int().min(1).max(2000).optional().describe("Max matching lines (default 200)"),
  }),
  kind: "search",
  category: "read",
  readOnly: true,
  title: (i) => `Grep(${oneLine(i.pattern, 60)}${i.path ? ` in ${i.path}` : ""})`,
  permissionKey: (i) => `grep:${i.pattern}`,
  async run(i, { ws, signal }) {
    const target = ws.resolve(i.path)
    const max = i.max_results ?? 200
    const rg = which("rg")
    let lines: string[]
    if (rg) {
      const args = [rg, "--line-number", "--no-heading", "--color=never", "--max-columns=400", "--max-columns-preview"]
      if (i.ignore_case) args.push("-i")
      if (i.glob) args.push("--glob", i.glob)
      args.push("-e", i.pattern, "--", ws.rel(target))
      const r = await runCapture(args, { cwd: ws.root, timeoutMs: 30_000 })
      if (r.code === 2 && !r.stdout) return { output: `grep failed: ${r.stderr.trim()}`, isError: true, summary: "Error" }
      lines = r.stdout.split("\n").filter(Boolean)
    } else {
      lines = await jsGrep(ws, target, i, max + 1, signal)
    }
    const shown = lines.slice(0, max)
    const more = lines.length > max ? `\n… more matches truncated (showing ${max})` : ""
    return { output: shown.join("\n") + more || "(no matches)", summary: plural(lines.length, "match").replace("matchs", "matches") }
  },
}

async function jsGrep(
  ws: Workspace,
  target: string,
  i: { pattern: string; glob?: string; ignore_case?: boolean },
  max: number,
  signal: AbortSignal,
): Promise<string[]> {
  let re: RegExp
  try {
    re = new RegExp(i.pattern, i.ignore_case ? "i" : "")
  } catch (e) {
    throw new Error(`invalid regex: ${e instanceof Error ? e.message : String(e)}`)
  }
  const glob = i.glob ? new Bun.Glob(i.glob) : undefined
  const matchesGlob = (rel: string) => !glob || glob.match(i.glob?.includes("/") ? rel : (rel.split("/").at(-1) ?? rel))
  const out: string[] = []
  const files: string[] = []
  const walk = (dir: string) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p)
      } else if (e.isFile()) files.push(p)
    }
  }
  const st = statSync(target)
  if (st.isDirectory()) walk(target)
  else files.push(target)
  for (const f of files) {
    if (signal.aborted || out.length >= max) break
    const rel = relative(ws.root, f)
    if (!matchesGlob(rel)) continue
    let buf: Buffer
    try {
      if (statSync(f).size > 2 * 1024 * 1024) continue
      buf = await readFile(f)
    } catch {
      continue
    }
    if (isBinary(buf)) continue
    const text = buf.toString("utf8").split("\n")
    for (let n = 0; n < text.length && out.length < max; n++) {
      const line = text[n] ?? ""
      if (re.test(line)) out.push(`${rel}:${n + 1}:${line.length > 400 ? `${line.slice(0, 400)}…` : line}`)
    }
  }
  return out
}

// ───────────────────────────── write_file / edit_file ─────────────────────────────

const writeFileTool: BuiltinTool<{ path: string; content: string }> = {
  name: "write_file",
  description: "Create a file or overwrite it entirely. Prefer edit_file for changes to existing files. Parent directories are created.",
  schema: z.object({ path: z.string().describe("File path, relative to the workspace root"), content: z.string().describe("Full file content") }),
  kind: "edit",
  category: "edit",
  title: (i) => `Write(${i.path})`,
  permissionKey: (i) => `write_file:${i.path}`,
  locations: (i, ws) => [{ path: safeRel(ws, i.path) }],
  async run(i, { ws }) {
    const abs = ws.resolve(i.path)
    const st = await stat(abs).catch(() => undefined)
    if (st?.isDirectory()) return { output: `${i.path} is a directory`, isError: true, summary: "Is a directory" }
    const oldText = st ? await readFile(abs, "utf8") : null
    mkdirSync(dirname(abs), { recursive: true })
    await writeFile(abs, i.content)
    const d = diffContent(ws, abs, oldText, i.content)
    const verb = oldText === null ? "Created" : "Wrote"
    return {
      output: `${verb} ${ws.rel(abs)} (+${d.added} -${d.removed})`,
      summary: `${verb} ${plural(i.content.split("\n").length, "line")}`,
      content: [d.content],
    }
  },
}

const editFileTool: BuiltinTool<{ path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
  name: "edit_file",
  description:
    "Edit a file by exact string replacement. `old_string` must match the file exactly (including whitespace) and be unique unless `replace_all` is true — include enough surrounding context to make it unique. Read the file first.",
  schema: z.object({
    path: z.string().describe("File path, relative to the workspace root"),
    old_string: z.string().describe("Exact text to replace"),
    new_string: z.string().describe("Replacement text"),
    replace_all: z.boolean().optional().describe("Replace every occurrence (default false)"),
  }),
  kind: "edit",
  category: "edit",
  title: (i) => `Update(${i.path})`,
  permissionKey: (i) => `edit_file:${i.path}`,
  locations: (i, ws) => [{ path: safeRel(ws, i.path) }],
  async run(i, { ws }) {
    const abs = ws.resolve(i.path)
    const oldText = await readFile(abs, "utf8").catch(() => undefined)
    if (oldText === undefined) return { output: `File not found: ${i.path} (use write_file to create it)`, isError: true, summary: "Not found" }
    if (i.old_string === "") return { output: "old_string must not be empty", isError: true, summary: "Invalid edit" }
    if (i.old_string === i.new_string) return { output: "old_string and new_string are identical", isError: true, summary: "No change" }
    const count = oldText.split(i.old_string).length - 1
    if (count === 0) return { output: `old_string not found in ${i.path}. Re-read the file and copy the text exactly.`, isError: true, summary: "No match" }
    if (count > 1 && !i.replace_all)
      return {
        output: `old_string occurs ${count} times in ${i.path}. Add surrounding context to make it unique, or set replace_all.`,
        isError: true,
        summary: "Ambiguous match",
      }
    let newText: string
    if (i.replace_all) newText = oldText.split(i.old_string).join(i.new_string)
    else {
      const at = oldText.indexOf(i.old_string)
      newText = oldText.slice(0, at) + i.new_string + oldText.slice(at + i.old_string.length)
    }
    await writeFile(abs, newText)
    const d = diffContent(ws, abs, oldText, newText)
    const n = Math.max(d.added, d.removed)
    return {
      output: `Edited ${ws.rel(abs)}${count > 1 ? ` (${count} replacements)` : ""} (+${d.added} -${d.removed})`,
      summary: `Updated ${plural(n, "line")}`,
      content: [d.content],
    }
  },
}

// ───────────────────────────── run_command ─────────────────────────────

const runCommandTool: BuiltinTool<{ command: string; timeout_ms?: number; description?: string }> = {
  name: "run_command",
  description:
    "Run a shell command with `bash -lc` in the workspace root. Returns combined stdout/stderr and the exit code. Non-interactive only (no prompts, no editors, no pagers); long output is truncated. Do not start long-running servers in the foreground.",
  schema: z.object({
    command: z.string().describe("The shell command"),
    timeout_ms: z.number().int().min(1000).max(1_800_000).optional().describe("Timeout in ms (default 120000)"),
    description: z.string().optional().describe("Short description of what the command does"),
  }),
  kind: "execute",
  category: "execute",
  title: (i) => `Bash(${oneLine(i.command)})`,
  permissionKey: (i) => `run_command:${i.command.trim()}`,
  async run(i, ctx) {
    return runCommand(i.command, i.timeout_ms ?? ctx.commandTimeoutMs, ctx)
  },
}

async function runCommand(command: string, timeoutMs: number, ctx: ToolRunContext): Promise<ToolOutcome> {
  const argv = ["bash", "-lc", command]
  const proc = Bun.spawn(ctx.sandbox ? ctx.sandbox.wrap(argv) : argv, {
    cwd: ctx.ws.root,
    env: { ...process.env, PATH: augmentedPath(), ...ctx.env, PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", CI: ctx.env.CI ?? "1" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // own process group: timeout / interrupt kill everything the command started
    detached: true,
  })
  const cap = ctx.maxOutputChars
  let head = ""
  let tail = ""
  let omitted = 0
  const append = (s: string) => {
    if (head.length < cap) {
      const room = cap - head.length
      head += s.slice(0, room)
      s = s.slice(room)
    }
    if (!s) return
    tail += s
    if (tail.length > cap) {
      omitted += tail.length - cap
      tail = tail.slice(-cap)
    }
  }
  const text = () => (omitted ? `${head}\n… [${omitted} characters omitted] …\n${tail}` : head + tail)
  let lastProgress = 0
  let progressTimer: ReturnType<typeof setTimeout> | undefined
  const sendProgress = () => {
    progressTimer = undefined
    lastProgress = Date.now()
    const t = text()
    ctx.progress([{ type: "terminal", command, output: t.length > 8000 ? t.slice(-8000) : t, exitCode: null }])
  }
  const onChunk = (s: string) => {
    append(s)
    if (progressTimer) return
    progressTimer = setTimeout(sendProgress, Math.max(0, 250 - (Date.now() - lastProgress)))
  }
  const pump = async (stream: ReadableStream<Uint8Array>) => {
    const dec = new TextDecoder()
    try {
      for await (const chunk of stream) onChunk(dec.decode(chunk, { stream: true }))
    } catch {}
  }
  const pipes = Promise.all([pump(proc.stdout), pump(proc.stderr)])

  let reason: "timeout" | "interrupted" | undefined
  const kill = (why: "timeout" | "interrupted") => {
    if (reason) return
    reason = why
    killProcessTree(proc.pid, "SIGTERM", proc)
    setTimeout(() => killProcessTree(proc.pid, "SIGKILL"), 1500).unref?.()
  }
  const timer = setTimeout(() => kill("timeout"), timeoutMs)
  const onAbort = () => kill("interrupted")
  if (ctx.signal.aborted) onAbort()
  else ctx.signal.addEventListener("abort", onAbort, { once: true })
  const code = await proc.exited
  clearTimeout(timer)
  ctx.signal.removeEventListener("abort", onAbort)
  // a backgrounded grandchild may hold the pipes open forever: don't wait long for them
  await Promise.race([pipes, Bun.sleep(reason ? 200 : 1000)])
  if (progressTimer) clearTimeout(progressTimer)
  const output = text()
  const exitCode = reason ? null : code
  const terminal: ToolContent = { type: "terminal", command, output, exitCode }
  if (reason === "timeout")
    return {
      output: `${output}\n[command timed out after ${Math.round(timeoutMs / 1000)}s and was killed]`,
      isError: true,
      summary: "Timed out",
      content: [terminal],
    }
  if (reason === "interrupted") return { output: `${output}\n[command interrupted]`, isError: true, summary: "Interrupted", content: [terminal] }
  const firstLine = output.trim().split("\n")[0]?.trim()
  return {
    output: `${output || "(no output)"}\n[exit code ${code}]`,
    summary: code === 0 ? (firstLine ? oneLine(firstLine, 60) : "Done") : `Exit code ${code}`,
    content: [terminal],
  }
}

// ───────────────────────────── web_fetch ─────────────────────────────

const webFetchTool: BuiltinTool<{ url: string }> = {
  name: "web_fetch",
  description: `Fetch a web page or document over http(s) (GET) and return it as readable text (HTML is converted; at most ${FETCH_MAX_CHARS} characters). Use it for documentation, issues, API references. Private and local addresses are refused.`,
  schema: z.object({ url: z.string().describe("Absolute http(s) URL") }),
  kind: "fetch",
  category: "network",
  readOnly: true,
  title: (i) => `Fetch(${oneLine(i.url, 100)})`,
  permissionKey: (i) => {
    try {
      return `web_fetch:${new URL(i.url).host}`
    } catch {
      return `web_fetch:${i.url}`
    }
  },
  async run(i, ctx) {
    try {
      const r = await webFetch(i.url, { signal: ctx.signal, allowPrivate: ctx.allowPrivateFetch })
      let text = r.text
      const notes: string[] = []
      if (text.length > FETCH_MAX_CHARS) {
        notes.push(`[truncated: showing ${FETCH_MAX_CHARS} of ${text.length} characters]`)
        text = text.slice(0, FETCH_MAX_CHARS)
      }
      if (r.truncated) notes.push("[download stopped at the 2 MB limit]")
      const head = `URL: ${r.url}\nStatus: ${r.status}${r.contentType ? ` · ${r.contentType}` : ""}\n\n`
      const output = head + (text || "(empty body)") + (notes.length ? `\n\n${notes.join("\n")}` : "")
      return {
        output,
        isError: r.status >= 400,
        summary: `${r.status} · ${Math.round(r.bytes / 1024)} KB`,
        content: [{ type: "text", text: capOutput(output, 4000) }],
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (e instanceof FetchRefused) return { output: `Refused: ${msg}`, isError: true, summary: "Refused" }
      return { output: `Fetch failed: ${ctx.signal.aborted ? "interrupted" : msg}`, isError: true, summary: ctx.signal.aborted ? "Interrupted" : "Failed" }
    }
  },
}

function safeRel(ws: Workspace, p: string): string {
  try {
    return ws.rel(ws.resolve(p))
  } catch {
    return p
  }
}

export type AnyTool = BuiltinTool<Record<string, unknown>>

export const BUILTIN_TOOLS: AnyTool[] = [
  readFileTool,
  listDirTool,
  globTool,
  grepTool,
  writeFileTool,
  editFileTool,
  runCommandTool,
  webFetchTool,
] as unknown as AnyTool[]
