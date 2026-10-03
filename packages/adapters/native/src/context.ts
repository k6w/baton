/**
 * Keep the transcript inside a character budget (≈ 4 chars/token):
 *   1. replace old tool outputs (and big write_file payloads) with a stub, oldest first;
 *   2. if still too big, drop whole old exchanges (from a user message up to the next one).
 * The most recent `keepRecent` messages are never touched.
 */
import type { ModelMessage } from "ai"

const STUB = "[earlier tool output removed to save context — re-run the tool if you need it again]"

/** Images count as a fixed ~1600 tokens instead of their base64 length. */
const IMAGE_CHARS = 6400

function sizeOf(v: unknown): number {
  return JSON.stringify(v, (k, x) => (k === "data" && typeof x === "string" && x.length > 1000 ? "" : x)).length
}

function imageCount(v: unknown): number {
  const s = JSON.stringify(v)
  return (s.match(/"mediaType":"image\//g) ?? []).length
}

function contentChars(content: unknown): number {
  return sizeOf(content) + imageCount(content) * IMAGE_CHARS
}

export function transcriptChars(messages: ModelMessage[]): number {
  let n = 0
  for (const m of messages) n += contentChars(m.content)
  return n
}

/** Rough token estimate (≈ 4 characters per token). */
export function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(transcriptChars(messages) / 4)
}

// ───────────────────────────── summarising compaction ─────────────────────────────

export const COMPACTION_PROMPT = `You are compacting the conversation history of an autonomous coding agent so it can keep working with less context.
Write a concise but complete summary of the conversation excerpt you are given. It replaces that excerpt, so keep everything the agent still needs:
- the user's goals, requirements and constraints, and any decisions or preferences they stated;
- what has been done so far: files read, created or changed (with paths), commands run and their important results, errors hit and how they were fixed;
- important facts discovered about the codebase (structure, APIs, conventions, test commands);
- what is still open or was being worked on, and the planned next steps.
Tool outputs were removed from the excerpt; rely on the calls and the assistant's notes. Do not invent details.
Write plain text or short markdown lists, no preamble. Aim for at most 600 words.`

export interface CompactionSplit {
  /** The original task (first user message), kept verbatim. */
  head: ModelMessage[]
  /** Summarised away. */
  middle: ModelMessage[]
  /** The most recent messages, kept verbatim. */
  tail: ModelMessage[]
}

/**
 * Split the transcript: [original task] [middle → summary] [last `keepRecent` messages]. The tail
 * never starts with a tool message (its tool calls would be summarised away). Undefined when
 * there is nothing worth summarising.
 */
export function splitForCompaction(messages: ModelMessage[], keepRecent = 8): CompactionSplit | undefined {
  const headLen = messages[0]?.role === "user" ? 1 : 0
  let start = Math.max(headLen, messages.length - keepRecent)
  while (start > headLen && messages[start]?.role === "tool") start--
  if (start - headLen < 2) return undefined
  return { head: messages.slice(0, headLen), middle: messages.slice(headLen, start), tail: messages.slice(start) }
}

function partText(p: unknown, maxArg: number): string {
  const part = p as { type?: string; text?: string; toolName?: string; input?: unknown; mediaType?: string }
  switch (part.type) {
    case "text":
      return part.text ?? ""
    case "reasoning":
      return ""
    case "tool-call": {
      const args = JSON.stringify(part.input ?? {})
      return `→ ${part.toolName}(${args.length > maxArg ? `${args.slice(0, maxArg)}…` : args})`
    }
    case "tool-result":
      return ""
    case "file":
    case "image":
      return `[${part.mediaType ?? "image"} attachment]`
    default:
      return ""
  }
}

/** Plain-text rendering of messages for the summariser. Tool results are dropped. */
export function renderForSummary(messages: ModelMessage[], maxChars = 400_000): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === "tool") continue
    const body =
      typeof m.content === "string"
        ? m.content
        : m.content
            .map((p) => partText(p, 300))
            .filter(Boolean)
            .join("\n")
    if (!body.trim()) continue
    lines.push(`## ${m.role}\n${body.trim()}`)
  }
  let text = lines.join("\n\n")
  if (text.length > maxChars) {
    const half = Math.floor(maxChars / 2)
    text = `${text.slice(0, half)}\n… [middle of the excerpt omitted] …\n${text.slice(-half)}`
  }
  return text
}

export function summaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: `[Summary of the earlier conversation, written when the context was compacted. Tool outputs from that part are no longer available — re-run tools if you need them.]\n\n${summary.trim()}`,
  }
}

export function trimTranscript(
  messages: ModelMessage[],
  budgetChars: number,
  keepRecent = 6,
): { messages: ModelMessage[]; trimmedOutputs: number; droppedMessages: number } {
  let total = transcriptChars(messages)
  if (total <= budgetChars) return { messages, trimmedOutputs: 0, droppedMessages: 0 }
  const out = [...messages]
  let trimmedOutputs = 0
  const frozen = Math.max(0, out.length - keepRecent)

  for (let i = 0; i < frozen && total > budgetChars; i++) {
    const m = out[i]
    if (!m || typeof m.content === "string") continue
    if (m.role === "tool") {
      const before = contentChars(m.content)
      const content = m.content.map((p) => {
        if (p.type !== "tool-result") return p
        const o = p.output
        const big = (o.type === "text" || o.type === "error-text") && o.value.length > 400
        const bigJson = (o.type === "json" || o.type === "content" || o.type === "error-json") && JSON.stringify(o).length > 400
        if (!big && !bigJson) return p
        trimmedOutputs++
        return { ...p, output: { type: "text" as const, value: STUB } }
      })
      out[i] = { ...m, content }
      total -= before - contentChars(content)
    } else if (m.role === "assistant") {
      const before = contentChars(m.content)
      const content = m.content.map((p) => {
        if (p.type !== "tool-call" || !p.input || typeof p.input !== "object") return p
        const input = p.input as Record<string, unknown>
        if (typeof input.content === "string" && input.content.length > 400) {
          trimmedOutputs++
          return { ...p, input: { ...input, content: "[file content omitted]" } }
        }
        return p
      })
      out[i] = { ...m, content }
      total -= before - contentChars(content)
    }
  }

  let dropped = 0
  while (total > budgetChars) {
    // drop the oldest exchange: messages[0 .. next user message)
    let next = -1
    for (let i = 1; i < out.length - keepRecent; i++) {
      if (out[i]?.role === "user") {
        next = i
        break
      }
    }
    if (next <= 0) break
    const removed = out.splice(0, next)
    dropped += removed.length
    total = transcriptChars(out)
  }
  if (dropped) out.unshift({ role: "user", content: "[Earlier conversation was trimmed to fit the context window.]" })
  return { messages: out, trimmedOutputs, droppedMessages: dropped }
}
