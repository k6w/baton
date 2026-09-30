/**
 * Claude Code tool presentation: kind mapping, Claude-Code-style titles ("Read(src/app.ts)",
 * "Update(button.css)"), result summaries ("Read 314 lines") and diff extraction.
 */
import { isAbsolute, relative } from "node:path"
import type { DiffHunkLine, ToolContent, ToolKind } from "@batonsh/protocol"
import { diffLines, diffStat } from "@batonsh/protocol"

type Input = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

export function toolKind(name: string): ToolKind {
  switch (name) {
    case "Read":
      return "read"
    case "Glob":
    case "Grep":
    case "LS":
    case "ToolSearch":
      return "search"
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit"
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "KillBash":
    case "Monitor":
      return "execute"
    case "WebFetch":
    case "WebSearch":
      return "fetch"
    case "Task":
    case "Agent":
    case "SendMessage":
      return "delegate"
    case "TodoWrite":
      return "think"
    case "ExitPlanMode":
    case "EnterPlanMode":
      return "switch_mode"
    default:
      return "other"
  }
}

/** Path as shown to the user: relative to cwd when inside it. */
export function displayPath(p: string | undefined, cwd: string): string {
  if (!p) return ""
  if (!isAbsolute(p)) return p
  const rel = relative(cwd, p)
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : p
}

function oneLine(s: string, max = 80): string {
  const first = s.split("\n").find((l) => l.trim().length > 0) ?? ""
  const t = first.trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** "mcp__baton__send_message" → "baton - send_message (MCP)" (Claude Code's own rendering). */
function mcpLabel(name: string): string {
  const parts = name.split("__")
  return parts.length >= 3 ? `${parts[1]} - ${parts.slice(2).join("__")} (MCP)` : name
}

export function toolTitle(name: string, input: Input, cwd: string): string {
  const path = displayPath(str(input.file_path) ?? str(input.notebook_path) ?? str(input.path), cwd)
  switch (name) {
    case "Read":
      return `Read(${path})`
    case "Edit":
    case "MultiEdit":
      return `Update(${path})`
    case "Write":
      return `Write(${path})`
    case "NotebookEdit":
      return `NotebookEdit(${path})`
    case "Bash":
      return `Bash(${oneLine(str(input.command) ?? "", 100)})`
    case "Glob":
      return `Glob(${str(input.pattern) ?? ""}${input.path ? ` in ${path}` : ""})`
    case "Grep":
      return `Grep(${str(input.pattern) ?? ""}${input.path ? ` in ${path}` : ""})`
    case "WebFetch":
      return `Fetch(${str(input.url) ?? ""})`
    case "WebSearch":
      return `WebSearch(${str(input.query) ?? ""})`
    case "Task":
    case "Agent":
      return `${name}(${str(input.description) ?? oneLine(str(input.prompt) ?? "")})`
    case "TodoWrite":
      return "Update Todos"
    default: {
      if (name.startsWith("mcp__")) return mcpLabel(name)
      return name
    }
  }
}

export function toolLocations(input: Input): { path: string; line?: number }[] | undefined {
  const p = str(input.file_path) ?? str(input.notebook_path)
  if (!p) return undefined
  const offset = typeof input.offset === "number" ? input.offset : undefined
  return [{ path: p, ...(offset ? { line: offset } : {}) }]
}

export type PlanEntry = { content: string; status: "pending" | "in_progress" | "completed" }

export function todosToPlan(input: Input): PlanEntry[] | undefined {
  if (!Array.isArray(input.todos)) return undefined
  return (input.todos as Input[]).map((t) => ({
    content: str(t.content) ?? "",
    status: t.status === "completed" || t.status === "in_progress" ? t.status : "pending",
  }))
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`

/** Text content of a tool_result block (string or array of text parts). */
export function resultText(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content.map((c) => (c && typeof c === "object" && (c as Input).type === "text" ? String((c as Input).text ?? "") : "")).join("")
  return ""
}

/** Strip Claude Code's <tool_use_error> wrapper. */
function cleanError(text: string): string {
  return text.replace(/<\/?tool_use_error>/g, "").trim()
}

type Patch = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** Claude Code structuredPatch hunks → DiffHunkLine[] with real file line numbers. */
export function patchToLines(patch: Patch[]): DiffHunkLine[] {
  const out: DiffHunkLine[] = []
  for (const h of patch) {
    let o = h.oldStart
    let n = h.newStart
    for (const l of h.lines) {
      const sign = l[0]
      const text = l.slice(1)
      if (sign === "+") out.push({ kind: "add", text, newLine: n++ })
      else if (sign === "-") out.push({ kind: "del", text, oldLine: o++ })
      else if (sign === "\\")
        continue // "\ No newline at end of file"
      else out.push({ kind: "ctx", text, oldLine: o++, newLine: n++ })
    }
  }
  return out
}

/**
 * Locate `needle` in `haystack` and return its 1-based starting line, so that a diff computed
 * from old_string/new_string alone can be shifted to real file line numbers.
 */
function lineOffsetOf(haystack: string | undefined, needle: string): number {
  if (!haystack || !needle) return 1
  const idx = haystack.indexOf(needle)
  if (idx < 0) return 1
  return haystack.slice(0, idx).split("\n").length
}

function shift(lines: DiffHunkLine[], by: number): DiffHunkLine[] {
  if (by === 0) return lines
  return lines.map((l) => ({
    ...l,
    ...(l.oldLine !== undefined ? { oldLine: l.oldLine + by } : {}),
    ...(l.newLine !== undefined ? { newLine: l.newLine + by } : {}),
  }))
}

export interface ToolResultInfo {
  name: string
  input: Input
  /** tool_result block content. */
  content: unknown
  isError: boolean
  /** SDKUserMessage.tool_use_result (structured tool output), when the SDK provides it. */
  structured?: unknown
  /** File content captured before the tool ran (PreToolUse snapshot), for Write/Edit fallbacks. */
  before?: string | null
}

/** Diff content for file-editing tools. Prefers Claude Code's own structuredPatch. */
export function editDiff(info: ToolResultInfo): Extract<ToolContent, { type: "diff" }> | undefined {
  const { name, input } = info
  if (name !== "Edit" && name !== "Write" && name !== "MultiEdit") return undefined
  const s = (info.structured && typeof info.structured === "object" ? info.structured : undefined) as Input | undefined
  const path = str(s?.filePath) ?? str(input.file_path) ?? ""
  const original = s && "originalFile" in s ? (s.originalFile as string | null) : info.before
  let lines: DiffHunkLine[] | undefined
  if (s && Array.isArray(s.structuredPatch) && s.structuredPatch.length > 0) lines = patchToLines(s.structuredPatch as Patch[])
  let newText: string | undefined
  if (name === "Write") {
    newText = str(s?.content) ?? str(input.content) ?? ""
    lines ??= diffLines(original ?? "", newText)
  } else if (name === "Edit") {
    const oldS = str(input.old_string) ?? ""
    const newS = str(input.new_string) ?? ""
    if (!lines) {
      if (input.replace_all === true && typeof original === "string" && oldS) {
        // Every occurrence changed: diff the whole file rather than the first match only.
        newText = original.split(oldS).join(newS)
        lines = diffLines(original, newText)
      } else lines = shift(diffLines(oldS, newS), lineOffsetOf(original ?? undefined, oldS) - 1)
    }
  } else {
    // MultiEdit: apply edits in order to the snapshot when we have one, else concatenate per-edit diffs.
    const edits = Array.isArray(input.edits) ? (input.edits as Input[]) : []
    if (!lines) {
      if (typeof original === "string") {
        let cur = original
        for (const e of edits) {
          const o = str(e.old_string) ?? ""
          const n = str(e.new_string) ?? ""
          cur = e.replace_all ? cur.split(o).join(n) : cur.replace(o, () => n)
        }
        lines = diffLines(original, cur)
        newText = cur
      } else lines = edits.flatMap((e) => diffLines(str(e.old_string) ?? "", str(e.new_string) ?? ""))
    }
  }
  const { added, removed } = diffStat(lines)
  return {
    type: "diff",
    path,
    oldText: original ?? null,
    ...(newText !== undefined ? { newText } : {}),
    lines,
    added,
    removed,
  }
}

export function toolSummary(info: ToolResultInfo, diff?: { added?: number; removed?: number }): string {
  const { name, isError } = info
  const text = resultText(info.content)
  const s = (info.structured && typeof info.structured === "object" ? info.structured : undefined) as Input | undefined
  if (isError) return oneLine(cleanError(text)) || "Error"
  switch (name) {
    case "Read": {
      const file = s?.file as Input | undefined
      const n = typeof file?.numLines === "number" ? file.numLines : text.split("\n").filter((l) => /^\s*\d+[→\t]/.test(l)).length
      return `Read ${plural(n, "line")}`
    }
    case "Edit":
    case "MultiEdit": {
      const a = diff?.added ?? 0
      const r = diff?.removed ?? 0
      if (a > 0 && r === 0) return `Added ${plural(a, "line")}`
      if (r > 0 && a === 0) return `Removed ${plural(r, "line")}`
      return `Updated ${plural(Math.max(a, r), "line")}`
    }
    case "Write": {
      const content = str(s?.content) ?? str(info.input.content) ?? ""
      const n = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length
      return `Wrote ${plural(n, "line")}`
    }
    case "Bash": {
      const out = s ? `${str(s.stdout) ?? ""}\n${str(s.stderr) ?? ""}` : text
      return oneLine(out, 100) || "(no output)"
    }
    case "Glob": {
      const n = typeof s?.numFiles === "number" ? s.numFiles : text.split("\n").filter((l) => l.trim()).length
      return `Found ${plural(n, "file")}`
    }
    case "Grep": {
      if (typeof s?.numLines === "number" && s.mode === "content") return `Found ${plural(s.numLines, "line")}`
      if (typeof s?.numFiles === "number") return `Found ${plural(s.numFiles, "file")}`
      return oneLine(text) || "No matches"
    }
    case "WebFetch":
      if (typeof s?.bytes === "number") return `Received ${(s.bytes / 1024).toFixed(1)}KB (${s.code} ${s.codeText ?? ""})`.trim()
      return oneLine(text) || "Fetched"
    case "TodoWrite":
      return "Updated todos"
    case "Task":
    case "Agent": {
      if (typeof s?.totalToolUseCount === "number")
        return `Done (${plural(s.totalToolUseCount, "tool use")} · ${Math.round(((s.totalDurationMs as number) ?? 0) / 1000)}s)`
      return "Done"
    }
    default:
      return oneLine(text) || "Done"
  }
}

/** Terminal content for Bash results. */
export function bashContent(info: ToolResultInfo): ToolContent | undefined {
  if (info.name !== "Bash") return undefined
  const s = (info.structured && typeof info.structured === "object" ? info.structured : undefined) as Input | undefined
  const output = s ? [str(s.stdout), str(s.stderr)].filter((x) => x).join("\n") : resultText(info.content)
  return { type: "terminal", command: str(info.input.command), output, ...(info.isError ? {} : { exitCode: 0 }) }
}
