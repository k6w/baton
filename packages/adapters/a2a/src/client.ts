/**
 * Minimal A2A JSON-RPC client: agent-card discovery, SendMessage / SendStreamingMessage (SSE),
 * GetTask, CancelTask, SubscribeToTask — in either the v1.0 or the v0.3 dialect.
 */
import {
  A2AError,
  type CardInfo,
  type Dialect,
  decodeResult,
  decodeTask,
  ErrorCode,
  encodeMessage,
  type JsonRpcResponse,
  METHODS,
  type Message,
  type MethodKind,
  parseSse,
  readCard,
  type StreamEvent,
  type Task,
} from "./wire.ts"

export interface A2AClientOptions {
  /** Agent base URL, card URL (…/agent-card.json) or — with `endpoint` — anything. */
  url: string
  /** Skip discovery's endpoint choice and post JSON-RPC here. */
  endpoint?: string
  headers?: Record<string, string>
  /** Bearer token (sent as `Authorization: Bearer …`). */
  token?: string
  /** Force a protocol dialect ("1.0" | "0.3"); default: what the card offers (1.0 preferred). */
  dialect?: Dialect
  /** Per-request timeout for non-streaming calls (ms). */
  timeoutMs?: number
}

export const OUTPUT_MODES = ["text/plain", "text/markdown", "application/json"]

/** Card locations to try for a URL (RFC 8615 well-known path, current name first, then the v0.2 name). */
export function cardCandidates(url: string): string[] {
  const u = new URL(url)
  if (u.pathname.endsWith(".json")) return [u.toString()]
  const base = `${u.origin}${u.pathname.replace(/\/+$/, "")}`
  const out: string[] = []
  for (const name of ["agent-card.json", "agent.json"]) {
    if (base !== u.origin) out.push(`${base}/.well-known/${name}`)
    out.push(`${u.origin}/.well-known/${name}`)
  }
  return [...new Set(out)]
}

export class A2AClient {
  card: CardInfo
  endpoint: string
  dialect: Dialect
  private id = 0

  private constructor(
    private opts: A2AClientOptions,
    card: CardInfo,
    endpoint: string,
    dialect: Dialect,
  ) {
    this.card = card
    this.endpoint = endpoint
    this.dialect = dialect
  }

  static async connect(opts: A2AClientOptions, signal?: AbortSignal): Promise<A2AClient> {
    const errors: string[] = []
    let card: CardInfo | undefined
    for (const url of cardCandidates(opts.url)) {
      try {
        const res = await fetch(url, { headers: { accept: "application/json", ...authHeaders(opts) }, signal: timeoutSignal(signal, opts.timeoutMs ?? 15_000) })
        if (!res.ok) {
          errors.push(`${url}: HTTP ${res.status}`)
          continue
        }
        card = readCard(await res.json(), url, opts.dialect)
        break
      } catch (e) {
        if (signal?.aborted) throw e
        errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (!card) {
      if (!opts.endpoint) throw new Error(`no A2A agent card found (${errors.join("; ")})`)
      card = { name: new URL(opts.endpoint).host, streaming: false, bearer: false }
    }
    const endpoint = opts.endpoint ?? card.endpoint?.url
    if (!endpoint) throw new Error(`${card.name}: the agent card offers no JSON-RPC interface (only JSON-RPC is supported)`)
    return new A2AClient(opts, card, endpoint, opts.dialect ?? card.endpoint?.dialect ?? "1.0")
  }

  private headers(stream: boolean): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
      "A2A-Version": this.dialect === "1.0" ? "1.0" : "0.3",
      ...authHeaders(this.opts),
    }
  }

  private body(kind: Exclude<MethodKind, "push">, params: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: METHODS[this.dialect][kind], params })
  }

  /** One JSON-RPC call; resolves with `result` or throws an {@link A2AError}. */
  async call(kind: Exclude<MethodKind, "push">, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers(false),
      body: this.body(kind, params),
      signal: timeoutSignal(signal, kind === "send" ? undefined : (this.opts.timeoutMs ?? 30_000)),
    })
    return unwrap(await readJson(res))
  }

  /** A streaming call; yields decoded events until the server closes the stream. */
  async *stream(kind: "stream" | "subscribe", params: unknown, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const res = await fetch(this.endpoint, { method: "POST", headers: this.headers(true), body: this.body(kind, params), signal })
    const type = res.headers.get("content-type") ?? ""
    if (!res.ok || !type.includes("text/event-stream") || !res.body) {
      // errors (and servers that answer a stream request with one JSON response) come back as JSON
      const result = unwrap(await readJson(res))
      const ev = decodeResult(result)
      if (!ev) throw new A2AError(ErrorCode.InvalidAgentResponse, "unexpected response to a streaming request")
      yield ev
      return
    }
    for await (const msg of parseSse(res.body, signal)) {
      if (!msg.data.trim()) continue
      let parsed: JsonRpcResponse
      try {
        parsed = JSON.parse(msg.data) as JsonRpcResponse
      } catch {
        throw new A2AError(ErrorCode.InvalidAgentResponse, `invalid JSON in event stream: ${msg.data.slice(0, 200)}`)
      }
      const ev = decodeResult(unwrap(parsed))
      if (ev) yield ev
    }
  }

  sendParams(message: Message, blocking = true): unknown {
    const m = encodeMessage(message, this.dialect)
    return this.dialect === "1.0"
      ? { message: m, configuration: { acceptedOutputModes: OUTPUT_MODES, returnImmediately: !blocking } }
      : { message: m, configuration: { acceptedOutputModes: OUTPUT_MODES, blocking } }
  }

  /** SendMessage; `blocking: false` asks the server to answer right away (then poll GetTask). */
  async send(message: Message, signal?: AbortSignal, blocking = true): Promise<StreamEvent> {
    const ev = decodeResult(await this.call("send", this.sendParams(message, blocking), signal))
    if (!ev) throw new A2AError(ErrorCode.InvalidAgentResponse, "SendMessage returned neither a task nor a message")
    return ev
  }

  sendStream(message: Message, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    return this.stream("stream", this.sendParams(message), signal)
  }

  async getTask(id: string, historyLength?: number, signal?: AbortSignal): Promise<Task> {
    const t = decodeTask(unwrapTask(await this.call("get", historyLength === undefined ? { id } : { id, historyLength }, signal)))
    if (!t) throw new A2AError(ErrorCode.InvalidAgentResponse, "GetTask returned no task")
    return t
  }

  async cancelTask(id: string, signal?: AbortSignal): Promise<Task | undefined> {
    return decodeTask(unwrapTask(await this.call("cancel", { id }, signal)))
  }

  resubscribe(id: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    return this.stream("subscribe", { id }, signal)
  }
}

function unwrapTask(r: unknown): unknown {
  return r && typeof r === "object" && "task" in r && !("id" in r) ? (r as { task: unknown }).task : r
}

function authHeaders(o: A2AClientOptions): Record<string, string> {
  const h: Record<string, string> = { ...(o.headers ?? {}) }
  if (o.token && !Object.keys(h).some((k) => k.toLowerCase() === "authorization")) h.Authorization = `Bearer ${o.token}`
  return h
}

function timeoutSignal(signal: AbortSignal | undefined, ms: number | undefined): AbortSignal | undefined {
  if (!ms) return signal
  const t = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, t]) : t
}

async function readJson(res: Response): Promise<JsonRpcResponse> {
  const text = await res.text()
  try {
    const j = JSON.parse(text) as JsonRpcResponse
    if (j && typeof j === "object" && ("result" in j || "error" in j)) return j
  } catch {}
  if (res.status === 401 || res.status === 403)
    throw new A2AError(ErrorCode.InvalidRequest, `HTTP ${res.status}: not authorized (set options.token or options.headers for this agent)`)
  throw new A2AError(ErrorCode.InvalidAgentResponse, `HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`)
}

function unwrap(r: JsonRpcResponse): unknown {
  if (r.error) throw new A2AError(r.error.code, r.error.message, r.error.data)
  return r.result
}
