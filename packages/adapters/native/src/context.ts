/**
 * Keep the transcript inside a character budget (≈ 4 chars/token):
 *   1. replace old tool outputs (and big write_file payloads) with a stub, oldest first;
 *   2. if still too big, drop whole old exchanges (from a user message up to the next one).
 * The most recent `keepRecent` messages are never touched.
 */
import type { ModelMessage } from "ai"

const STUB = "[earlier tool output removed to save context — re-run the tool if you need it again]"

export function transcriptChars(messages: ModelMessage[]): number {
  let n = 0
  for (const m of messages) n += JSON.stringify(m.content).length
  return n
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
      const before = JSON.stringify(m.content).length
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
      total -= before - JSON.stringify(content).length
    } else if (m.role === "assistant") {
      const before = JSON.stringify(m.content).length
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
      total -= before - JSON.stringify(content).length
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
