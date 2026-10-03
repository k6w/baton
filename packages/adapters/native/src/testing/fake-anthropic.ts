/**
 * Test helper: a fake Anthropic Messages API (`POST /v1/messages`, streaming SSE) with scripted
 * replies, including prompt-cache usage numbers. Records request bodies (to check cache_control).
 */

export interface FakeAnthropicReply {
  text?: string
  toolCalls?: { name: string; args: unknown; id?: string }[]
  usage?: { input: number; output: number; cacheRead?: number; cacheWrite?: number }
  error?: { status: number; message: string }
}

export interface FakeAnthropicRequest {
  index: number
  body: {
    model: string
    system?: { type: string; text: string; cache_control?: unknown }[] | string
    messages: { role: string; content: string | { type: string; text?: string; cache_control?: unknown; content?: unknown; source?: unknown }[] }[]
    tools?: { name: string; cache_control?: unknown }[]
    stream?: boolean
  }
  headers: Headers
}

export interface FakeAnthropic {
  baseUrl: string
  requests: FakeAnthropicRequest[]
  stop(): void
}

export function fakeAnthropic(script: FakeAnthropicReply[] | ((r: FakeAnthropicRequest) => FakeAnthropicReply)): FakeAnthropic {
  const requests: FakeAnthropicRequest[] = []
  let calls = 0
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (!url.pathname.endsWith("/messages")) return new Response("not found", { status: 404 })
      const body = (await req.json()) as FakeAnthropicRequest["body"]
      const r: FakeAnthropicRequest = { index: calls++, body, headers: req.headers }
      requests.push(r)
      const reply = Array.isArray(script) ? (script[r.index] ?? { text: "(script exhausted)" }) : script(r)
      if (reply.error)
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: reply.error.message } }, { status: reply.error.status })
      return new Response(stream(reply, body.model, r.index), { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { baseUrl: `http://localhost:${server.port}/v1`, requests, stop: () => server.stop(true) }
}

function stream(reply: FakeAnthropicReply, model: string, index: number): ReadableStream<Uint8Array> {
  const u = reply.usage ?? { input: 100, output: 20 }
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_${index}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: u.input, output_tokens: 1, cache_creation_input_tokens: u.cacheWrite ?? 0, cache_read_input_tokens: u.cacheRead ?? 0 },
        },
      },
    ],
  ]
  let block = 0
  if (reply.text) {
    events.push(["content_block_start", { type: "content_block_start", index: block, content_block: { type: "text", text: "" } }])
    events.push(["content_block_delta", { type: "content_block_delta", index: block, delta: { type: "text_delta", text: reply.text } }])
    events.push(["content_block_stop", { type: "content_block_stop", index: block }])
    block++
  }
  for (const [i, tc] of (reply.toolCalls ?? []).entries()) {
    events.push([
      "content_block_start",
      { type: "content_block_start", index: block, content_block: { type: "tool_use", id: tc.id ?? `toolu_${index}_${i}`, name: tc.name, input: {} } },
    ])
    events.push([
      "content_block_delta",
      { type: "content_block_delta", index: block, delta: { type: "input_json_delta", partial_json: JSON.stringify(tc.args) } },
    ])
    events.push(["content_block_stop", { type: "content_block_stop", index: block }])
    block++
  }
  events.push([
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: reply.toolCalls?.length ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: u.output },
    },
  ])
  events.push(["message_stop", { type: "message_stop" }])
  const enc = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const [name, data] of events) controller.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`))
      controller.close()
    },
  })
}
