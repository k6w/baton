/**
 * Pure ACP → BEP mapping helpers (no I/O).
 */
import type * as acp from "@agentclientprotocol/sdk"
import type { ToolContent, ToolKind } from "@batonsh/protocol"
import { diffLines, diffStat } from "@batonsh/protocol"

const KIND_NAMES: Record<string, string> = {
  read: "Read",
  edit: "Edit",
  delete: "Delete",
  move: "Move",
  search: "Search",
  execute: "Bash",
  think: "Think",
  fetch: "Fetch",
  switch_mode: "SwitchMode",
  delegate: "Task",
}

const BEP_KINDS = new Set<string>(["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "delegate", "other"])

export function mapKind(kind: string | null | undefined): ToolKind {
  return kind && BEP_KINDS.has(kind) ? (kind as ToolKind) : "other"
}

/** Tool name: the agent's own (ACP `name`), else the title's verb, else the kind. */
export function toolName(kind: ToolKind, title: string | undefined, name?: string | null): string {
  if (name) return name
  if (kind !== "other" && KIND_NAMES[kind]) return KIND_NAMES[kind] as string
  const verb = /^\s*([A-Za-z][\w-]*)/.exec(title ?? "")?.[1]
  if (verb) return verb.charAt(0).toUpperCase() + verb.slice(1)
  return "Tool"
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined
}

function firstLine(s: string, max = 120): string {
  const line = s.split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * Claude-like one-line title ("Read(src/app.ts)", "Bash(git status)"); falls back to the
 * agent's own title when we can't do better.
 */
export function toolTitle(
  kind: ToolKind,
  acpTitle: string | undefined,
  locations: { path: string; line?: number | null }[] | undefined,
  rawInput: unknown,
  display: (p: string) => string,
  name?: string | null,
): string {
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>
  const loc = locations?.[0]?.path ?? str(input.path) ?? str(input.file_path) ?? str(input.filePath) ?? str(input.absolute_path)
  const label = toolName(kind, acpTitle, name)
  switch (kind) {
    case "read":
    case "edit":
    case "delete":
      if (loc) return `${label}(${display(loc)})`
      break
    case "move": {
      const to = str(input.destination) ?? str(input.to) ?? str(input.new_path) ?? locations?.[1]?.path
      if (loc && to) return `${label}(${display(loc)} → ${display(to)})`
      if (loc) return `${label}(${display(loc)})`
      break
    }
    case "execute": {
      const cmd = input.command
      const c = Array.isArray(cmd) ? cmd.join(" ") : str(cmd)
      if (c) return `${label}(${firstLine(c)})`
      break
    }
    case "search": {
      const q = str(input.pattern) ?? str(input.query) ?? str(input.regex) ?? str(input.glob)
      if (q) return `${label}(${firstLine(q)})`
      break
    }
    case "fetch": {
      const u = str(input.url) ?? str(input.query)
      if (u) return `${label}(${firstLine(u)})`
      break
    }
  }
  return acpTitle && acpTitle.length > 0 ? firstLine(acpTitle, 200) : label
}

/** Text of an ACP content block (non-text blocks get a short placeholder). */
export function blockText(b: acp.ContentBlock | undefined | null): string {
  if (!b) return ""
  switch (b.type) {
    case "text":
      return b.text
    case "image":
      return "[image]"
    case "audio":
      return "[audio]"
    case "resource_link":
      return `[${b.name ?? b.uri}](${b.uri})`
    case "resource": {
      const r = b.resource as { text?: string; uri?: string }
      return typeof r.text === "string" ? r.text : `[resource ${r.uri ?? ""}]`
    }
    default:
      return ""
  }
}

export function diffContent(path: string, oldText: string | null | undefined, newText: string): Extract<ToolContent, { type: "diff" }> {
  const lines = diffLines(oldText ?? "", newText)
  const { added, removed } = diffStat(lines)
  return { type: "diff", path, oldText: oldText ?? null, newText, lines, added, removed }
}

/** Terminal snapshot provider used to fill `terminal` content. */
export type TerminalLookup = (terminalId: string) => { output: string; exitCode?: number | null; command?: string } | undefined

export function mapToolContent(items: acp.ToolCallContent[] | null | undefined, terminals: TerminalLookup): ToolContent[] {
  const out: ToolContent[] = []
  for (const c of items ?? []) {
    if (c.type === "content") {
      const text = blockText(c.content)
      if (text) out.push({ type: "text", text })
    } else if (c.type === "diff") {
      out.push(diffContent(c.path, c.oldText, c.newText))
    } else if (c.type === "terminal") {
      const snap = terminals(c.terminalId)
      out.push({ type: "terminal", terminalId: c.terminalId, command: snap?.command, output: snap?.output ?? "", exitCode: snap?.exitCode ?? null })
    }
  }
  return out
}

export function rawSummary(rawInput: unknown): string | undefined {
  if (rawInput == null) return undefined
  if (typeof rawInput === "string") return rawInput
  const input = rawInput as Record<string, unknown>
  const cmd = input.command
  if (Array.isArray(cmd)) return cmd.join(" ")
  if (typeof cmd === "string") return cmd
  try {
    const s = JSON.stringify(rawInput)
    return s === "{}" ? undefined : s.length > 2000 ? `${s.slice(0, 2000)}…` : s
  } catch {
    return undefined
  }
}
