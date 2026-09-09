/**
 * OpenCode tool parts → BEP tool vocabulary (kind, Claude-Code-like titles, summaries, content).
 */
import { isAbsolute, relative, resolve } from "node:path"
import type { DiffHunkLine, ToolContent, ToolKind } from "@batonsh/protocol"
import { diffLines, diffStat, parseUnifiedDiff } from "@batonsh/protocol"

type Input = Record<string, unknown>
type Meta = Record<string, unknown>

const KINDS: Record<string, ToolKind> = {
  read: "read",
  glob: "search",
  grep: "search",
  list: "search",
  ls: "search",
  codesearch: "search",
  lsp: "search",
  edit: "edit",
  multiedit: "edit",
  write: "edit",
  patch: "edit",
  apply_patch: "edit",
  bash: "execute",
  shell: "execute",
  webfetch: "fetch",
  websearch: "fetch",
  task: "delegate",
}

export function toolKind(tool: string): ToolKind {
  return KINDS[tool] ?? "other"
}

export function isEditTool(tool: string): boolean {
  return toolKind(tool) === "edit"
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function oneLine(s: string, max = 80): string {
  const line = s.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function displayPath(p: string, cwd: string | undefined): string {
  if (!cwd || !isAbsolute(p)) return p
  const rel = relative(cwd, p)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p
}

export function absPath(p: string, cwd: string | undefined): string {
  return cwd && !isAbsolute(p) ? resolve(cwd, p) : p
}

function filePathOf(input: Input): string | undefined {
  return str(input.filePath) ?? str(input.file_path) ?? str(input.path) ?? str(input.filepath)
}

/** Files touched by an apply_patch / patch envelope ("*** Update File: x"). */
export function patchFiles(patchText: string): string[] {
  const out: string[] = []
  for (const m of patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) if (m[1]) out.push(m[1].trim())
  for (const m of patchText.matchAll(/^\*\*\* Move to: (.+)$/gm)) if (m[1]) out.push(m[1].trim())
  return out
}

/** Human title, e.g. `Read(src/app.ts)`, `Bash(git status)`, `Update(notes.txt)`. */
export function toolTitle(tool: string, input: Input, cwd?: string): string {
  const file = filePathOf(input)
  const p = file ? displayPath(file, cwd) : undefined
  switch (tool) {
    case "read":
      return p ? `Read(${p})` : "Read"
    case "write":
      return p ? `Write(${p})` : "Write"
    case "edit":
    case "multiedit":
      return p ? `Update(${p})` : "Update"
    case "patch":
    case "apply_patch": {
      const files = patchFiles(str(input.patchText) ?? str(input.patch) ?? "").map((f) => displayPath(f, cwd))
      return files.length ? `Update(${files.join(", ")})` : "Update"
    }
    case "bash":
    case "shell": {
      const cmd = str(input.command)
      return cmd ? `Bash(${oneLine(cmd)})` : "Bash"
    }
    case "glob": {
      const pat = str(input.pattern)
      return pat ? `Search(${pat}${p ? ` in ${p}` : ""})` : "Search"
    }
    case "grep": {
      const pat = str(input.pattern)
      return pat ? `Search(${oneLine(pat, 60)}${p ? ` in ${p}` : ""})` : "Search"
    }
    case "list":
    case "ls":
      return `List(${p ?? "."})`
    case "webfetch": {
      const url = str(input.url)
      return url ? `Fetch(${url})` : "Fetch"
    }
    case "websearch": {
      const q = str(input.query)
      return q ? `WebSearch(${oneLine(q, 60)})` : "WebSearch"
    }
    case "task": {
      const d = str(input.description) ?? str(input.subagent_type)
      return d ? `Task(${oneLine(d, 60)})` : "Task"
    }
    case "todowrite":
      return "Update Todos"
    case "todoread":
      return "Read Todos"
    case "skill": {
      const n = str(input.name)
      return n ? `Skill(${n})` : "Skill"
    }
    default: {
      const first = Object.values(input).find((v) => typeof v === "string") as string | undefined
      return first ? `${tool}(${oneLine(first, 60)})` : tool
    }
  }
}

export function toolLocations(tool: string, input: Input, cwd?: string): { path: string; line?: number }[] | undefined {
  if (tool === "patch" || tool === "apply_patch") {
    const files = patchFiles(str(input.patchText) ?? str(input.patch) ?? "")
    return files.length ? files.map((f) => ({ path: absPath(f, cwd) })) : undefined
  }
  const file = filePathOf(input)
  if (!file) return undefined
  const line = typeof input.offset === "number" ? input.offset : undefined
  return [line !== undefined ? { path: absPath(file, cwd), line } : { path: absPath(file, cwd) }]
}

function diffContent(path: string, lines: DiffHunkLine[], extra: { oldText?: string | null; newText?: string } = {}): ToolContent {
  const { added, removed } = diffStat(lines)
  return { type: "diff", path, lines, added, removed, ...extra }
}

/**
 * Build diff content for an edit-type tool from (in order of preference): metadata.filediff,
 * metadata.files[] (apply_patch), metadata.diff (unified), a diff captured from the permission
 * request, or before/after texts.
 */
export function editDiffs(tool: string, input: Input, meta: Meta | undefined, cwd: string | undefined, permissionDiff?: string): ToolContent[] {
  const m = meta ?? {}
  const out: ToolContent[] = []
  const fallbackPath = filePathOf(input)

  const fromPatch = (patch: string, defaultPath?: string) => {
    for (const f of parseUnifiedDiff(patch)) {
      if (!f.lines.length) continue
      const p = f.path && f.path !== "/dev/null" ? f.path : defaultPath
      if (p) out.push(diffContent(absPath(p, cwd), f.lines))
    }
  }

  const files = Array.isArray(m.files) ? (m.files as Record<string, unknown>[]) : undefined
  if (files?.length) {
    for (const f of files) {
      const p = str(f.filePath) ?? str(f.file) ?? str(f.path) ?? str(f.relativePath)
      if (!p) continue
      const before = typeof f.before === "string" ? f.before : undefined
      const after = typeof f.after === "string" ? f.after : undefined
      if (before !== undefined || after !== undefined) {
        const lines = diffLines(before ?? "", after ?? "")
        out.push(diffContent(absPath(p, cwd), lines, { oldText: before ?? null, newText: after ?? "" }))
      } else {
        const patch = str(f.diff) ?? str(f.patch)
        if (patch) {
          const parsed = parseUnifiedDiff(patch)
          const lines = parsed.flatMap((x) => x.lines)
          if (lines.length) out.push(diffContent(absPath(p, cwd), lines))
        }
      }
    }
    if (out.length) return out
  }

  const fd = m.filediff as Record<string, unknown> | undefined
  if (fd && typeof fd === "object") {
    const before = typeof fd.before === "string" ? fd.before : undefined
    const after = typeof fd.after === "string" ? fd.after : undefined
    const p = str(fd.file) ?? fallbackPath
    if (p && (before !== undefined || after !== undefined)) {
      return [diffContent(absPath(p, cwd), diffLines(before ?? "", after ?? ""), { oldText: before ?? null, newText: after ?? "" })]
    }
    const patch = str(fd.patch)
    if (patch) fromPatch(patch, p)
    if (out.length) return out
  }

  const diff = str(m.diff) ?? permissionDiff
  if (diff) {
    fromPatch(diff, fallbackPath)
    if (out.length) return out
  }

  // write tool: no diff in metadata; new file → diff from empty, otherwise new text only.
  if (tool === "write" && fallbackPath && typeof input.content === "string") {
    const content = input.content
    if (m.exists === false) return [diffContent(absPath(fallbackPath, cwd), diffLines("", content), { oldText: null, newText: content })]
    return [{ type: "diff", path: absPath(fallbackPath, cwd), newText: content }]
  }
  if ((tool === "edit" || tool === "multiedit") && fallbackPath && typeof input.oldString === "string" && typeof input.newString === "string") {
    return [diffContent(absPath(fallbackPath, cwd), diffLines(input.oldString, input.newString), { oldText: input.oldString, newText: input.newString })]
  }
  return out
}

function countLines(s: string): number {
  if (!s) return 0
  const n = s.split("\n").length
  return s.endsWith("\n") ? n - 1 : n
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

/** Short result summary for a completed tool ("Read 314 lines", "+3 −1"). */
export function toolSummary(tool: string, input: Input, output: string, meta: Meta | undefined, content: ToolContent[]): string | undefined {
  const m = meta ?? {}
  switch (tool) {
    case "read": {
      const display = m.display as Record<string, unknown> | undefined
      const total = typeof display?.totalLines === "number" ? display.totalLines : undefined
      const shown =
        typeof display?.lineEnd === "number" && typeof display?.lineStart === "number" ? display.lineEnd - display.lineStart + 1 : undefined
      const n = shown ?? total ?? (typeof m.preview === "string" ? countLines(m.preview) : undefined)
      return n !== undefined ? `Read ${plural(n, "line")}` : "Read"
    }
    case "glob":
    case "list":
    case "ls": {
      const n = typeof m.count === "number" ? m.count : output ? countLines(output.trim()) : 0
      return `Found ${plural(n, "file")}`
    }
    case "grep": {
      const n = typeof m.matches === "number" ? m.matches : undefined
      return n !== undefined ? `Found ${n} match${n === 1 ? "" : "es"}` : "Searched"
    }
    case "bash":
    case "shell": {
      const exit = typeof m.exit === "number" ? m.exit : undefined
      const lines = countLines(typeof m.output === "string" ? m.output : output)
      return exit !== undefined && exit !== 0 ? `Exit code ${exit}` : lines ? `${plural(lines, "line")} of output` : "Done"
    }
    case "todowrite":
    case "todoread": {
      const todos = Array.isArray(m.todos) ? m.todos : Array.isArray(input.todos) ? input.todos : undefined
      return todos ? plural(todos.length, "todo") : undefined
    }
    default:
      break
  }
  if (isEditTool(tool)) {
    let added = 0
    let removed = 0
    for (const c of content) if (c.type === "diff") {
      added += c.added ?? 0
      removed += c.removed ?? 0
    }
    return `+${added} −${removed}`
  }
  const first = output.trim().split("\n")[0]
  return first ? oneLine(first, 100) : undefined
}

export function truncate(s: string, max = 8000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more chars)` : s
}
