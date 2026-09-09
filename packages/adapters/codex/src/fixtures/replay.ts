/**
 * Replays a recorded app-server JSONL fixture through CodexTranslator, the way CodexSession
 * would: notifications and server requests are translated, our recorded answers to server
 * requests are fed back through resolvePermission() so tests can compare the computed response
 * with what was actually sent.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentEvent, JsonRpcMessage } from "@batonsh/protocol"
import { CodexTranslator } from "../translator.ts"

export interface ReplayResult {
  events: AgentEvent[]
  translator: CodexTranslator
  /** For each answered server request: what we recorded vs. what the translator computes now. */
  answers: { method: string; recorded: unknown; computed: unknown }[]
}

export function loadFixture(name: string): { dir: "in" | "out"; msg: JsonRpcMessage }[] {
  return readFileSync(join(import.meta.dir, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/** Map a recorded approval decision back to the option the user must have picked. */
function optionFor(result: unknown): string | null {
  const r = result as { decision?: unknown; action?: unknown } | null | undefined
  const d = r?.decision ?? r?.action
  if (d === "accept" || d === "approved") return "allow_once"
  if (d === "acceptForSession" || d === "approved_for_session") return "allow_always"
  if (d === "decline" || (d && typeof d === "object" && "denied" in d)) return "reject_once"
  return null
}

export function replay(name: string, opts: { keepRaw?: boolean } = {}): ReplayResult {
  const events: AgentEvent[] = []
  const t = new CodexTranslator((e) => events.push(e), { keepRaw: opts.keepRaw })
  const requests = new Map<number | string, { method: string; requestId: string }>()
  const answers: ReplayResult["answers"] = []
  for (const { dir, msg } of loadFixture(name)) {
    if (dir === "out") {
      if (msg.method === "turn/start") {
        const input = (msg.params as { input: { text?: string }[] }).input
        t.notePrompt(input.map((i) => i.text ?? "").join(""))
      } else if (msg.method === undefined && msg.id !== undefined && msg.id !== null) {
        const req = requests.get(msg.id)
        if (!req) continue
        const r = t.resolvePermission(req.requestId, optionFor(msg.result))
        answers.push({ method: req.method, recorded: msg.result, computed: r?.result })
      }
      continue
    }
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      const r = t.serverRequest(msg.id, msg.method, msg.params, msg)
      if (r) requests.set(msg.id, { method: msg.method, requestId: r.requestId })
    } else if (msg.method !== undefined) {
      t.notification(msg.method, msg.params, msg)
    } else {
      // Responses to our requests: thread/start|resume carry the thread.
      const thread = (msg.result as { thread?: { id: string } } | undefined)?.thread
      if (thread) {
        t.setThread(thread.id)
        t.setStatus("ready")
      }
    }
  }
  return { events, translator: t, answers }
}
