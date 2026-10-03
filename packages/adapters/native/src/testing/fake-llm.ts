/**
 * Test helper: a fake OpenAI-compatible `/v1/chat/completions` endpoint that streams scripted
 * SSE responses (text, reasoning, tool calls, usage). Each request is answered by the script.
 */

export interface FakeToolCall {
  name: string
  args: unknown
  id?: string
}

export interface FakeReply {
  reasoning?: string
  text?: string
  toolCalls?: FakeToolCall[]
  usage?: { prompt: number; completion: number; cached?: number }
  /** Delay between streamed chunks (ms). */
  chunkDelayMs?: number
  /** Respond with an HTTP error instead of a stream. */
  error?: { status: number; message: string }
}

export interface FakeRequest {
  index: number
  body: {
    model: string
    messages: { role: string; content?: unknown; tool_calls?: { id: string; function: { name: string; arguments: string } }[]; tool_call_id?: string }[]
    tools?: { type: string; function: { name: string; description?: string; parameters?: unknown } }[]
    stream?: boolean
  }
  headers: Headers
}

export type FakeScript = ((req: FakeRequest) => FakeReply | Promise<FakeReply>) | FakeReply[]

export interface FakeLLM {
  /** Base URL to use as ProviderSpec.baseUrl. */
  baseUrl: string
  requests: FakeRequest[]
  stop(): void
}

/** `ollamaTags`: also answer Ollama's GET /api/tags with these model names (for detection tests). */
export function fakeLLM(script: FakeScript, opts: { ollamaTags?: string[] } = {}): FakeLLM {
  const requests: FakeRequest[] = []
  let calls = 0
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (opts.ollamaTags && url.pathname === "/api/tags") return Response.json({ models: opts.ollamaTags.map((name) => ({ name, model: name })) })
      if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as FakeRequest["body"]
      const r: FakeRequest = { index: calls++, body, headers: req.headers }
      requests.push(r)
      const reply = Array.isArray(script) ? (script[r.index] ?? { text: "(script exhausted)" }) : await script(r)
      if (reply.error) return Response.json({ error: { message: reply.error.message, type: "fake_error" } }, { status: reply.error.status })
      return new Response(sse(reply, body.model, r.index, req.signal), {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    },
  })
  return { baseUrl: `http://localhost:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

function sse(reply: FakeReply, model: string, index: number, signal: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  const id = `chatcmpl-${index}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })
  const events: unknown[] = [chunk({ role: "assistant", content: "" })]
  for (const piece of split(reply.reasoning)) events.push(chunk({ reasoning_content: piece }))
  for (const piece of split(reply.text)) events.push(chunk({ content: piece }))
  reply.toolCalls?.forEach((tc, i) => {
    const args = JSON.stringify(tc.args)
    const half = Math.floor(args.length / 2)
    events.push(
      chunk({ tool_calls: [{ index: i, id: tc.id ?? `call_${index}_${i}`, type: "function", function: { name: tc.name, arguments: args.slice(0, half) } }] }),
    )
    events.push(chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] }))
  })
  events.push(chunk({}, reply.toolCalls?.length ? "tool_calls" : "stop"))
  const u = reply.usage ?? { prompt: 100, completion: 20 }
  events.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: {
      prompt_tokens: u.prompt,
      completion_tokens: u.completion,
      total_tokens: u.prompt + u.completion,
      ...(u.cached ? { prompt_tokens_details: { cached_tokens: u.cached } } : {}),
    },
  })
  return new ReadableStream({
    async start(controller) {
      try {
        for (const e of events) {
          if (signal.aborted) break
          controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
          if (reply.chunkDelayMs) await Bun.sleep(reply.chunkDelayMs)
        }
        if (!signal.aborted) controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      } catch {
        try {
          controller.close()
        } catch {}
      }
    },
  })
}

function split(s: string | undefined): string[] {
  if (!s) return []
  return s.split(/(?<= )/)
}

/** Text of the last message with `role` in a request (string or parts). */
export function lastMessage(req: FakeRequest, role: string): string {
  const m = [...req.body.messages].reverse().find((x) => x.role === role)
  return contentText(m?.content)
}

export function contentText(c: unknown): string {
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : ((p as { text?: string }).text ?? ""))).join("")
  return ""
}
