/**
 * A2A client: agent-card discovery (with signature verification), then the JSON-RPC binding
 * (v1.0 or v0.3) or the HTTP+JSON/REST binding (v1.0) — SendMessage, SendStreamingMessage (SSE),
 * GetTask, ListTasks, CancelTask, SubscribeToTask and the push-notification config methods.
 * Authentication follows the card's security schemes (see ./auth.ts).
 *
 * gRPC is not implemented: it needs HTTP/2 trailers and a protobuf codec (Bun's fetch exposes
 * neither), i.e. @grpc/grpc-js + protobufjs, and gRPC-web needs a proxy in front of the agent.
 * Every A2A agent must offer the same operations over one of JSON-RPC / REST anyway.
 */
import { Auth, type AuthOptions } from "./auth.ts"
import {
  A2AError,
  type Binding,
  type CardInfo,
  type Dialect,
  decodePushConfig,
  decodeResult,
  decodeTask,
  ErrorCode,
  encodeMessage,
  encodePushConfig,
  type JsonRpcResponse,
  type Jwks,
  METHODS,
  type Message,
  type MethodKind,
  type PushConfig,
  parseSse,
  readCard,
  restError,
  type StreamEvent,
  type Task,
  type TransportPref,
  type VerifyResult,
  verifyCard,
} from "./wire.ts"

type Log = (level: "debug" | "info" | "warn" | "error", message: string) => void

export interface A2AClientOptions {
  /** Agent base URL, card URL (…/agent-card.json) or — with `endpoint` — anything. */
  url: string
  /** Skip discovery's interface choice and talk to this URL (JSON-RPC unless `transport: "rest"`). */
  endpoint?: string
  /** Binding: "auto" (default — what the card prefers), "jsonrpc" or "rest" (HTTP+JSON). */
  transport?: TransportPref
  headers?: Record<string, string>
  /** Bearer token (sent as `Authorization: Bearer …`), also used as API key when no `auth.apiKey` is set. */
  token?: string
  /** Credentials for the card's security schemes (API key, basic, OAuth2 client credentials, OIDC). */
  auth?: AuthOptions
  /** Force a protocol dialect ("1.0" | "0.3"); default: what the card offers (1.0 preferred). */
  dialect?: Dialect
  /** Per-request timeout for non-streaming calls (ms). */
  timeoutMs?: number
  /** A missing or invalid card signature is fatal (default: a warning). */
  requireSignedCard?: boolean
  /** Trusted signing keys (a JWKS object or its URL); pins the card's key instead of trusting its `jku`. */
  cardJwks?: Jwks | string
  /** Register this webhook for every task (if the card supports push notifications). */
  push?: { url: string; token?: string; authentication?: { scheme: string; credentials?: string } }
  log?: Log
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

type StreamKind = "stream" | "subscribe"

export class A2AClient {
  card: CardInfo
  endpoint: string
  dialect: Dialect
  binding: Binding
  tenant?: string
  auth: Auth
  signature: VerifyResult
  private id = 0
  private log: Log

  private constructor(
    private opts: A2AClientOptions,
    init: { card: CardInfo; endpoint: string; dialect: Dialect; binding: Binding; tenant?: string; signature: VerifyResult },
  ) {
    this.card = init.card
    this.endpoint = init.endpoint
    this.dialect = init.dialect
    this.binding = init.binding
    this.tenant = init.tenant
    this.signature = init.signature
    this.log = opts.log ?? (() => {})
    this.auth = new Auth(init.card.securitySchemes, init.card.securityRequirements, { token: opts.token, ...opts.auth }, this.log)
  }

  static async connect(opts: A2AClientOptions, signal?: AbortSignal): Promise<A2AClient> {
    const log = opts.log ?? (() => {})
    const errors: string[] = []
    let card: CardInfo | undefined
    let signature: VerifyResult = { status: "unsigned" }
    const transport = opts.transport ?? "auto"
    for (const url of cardCandidates(opts.url)) {
      try {
        const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) }
        if (opts.token && !Object.keys(headers).some((k) => k.toLowerCase() === "authorization")) headers.Authorization = `Bearer ${opts.token}`
        const res = await fetch(url, { headers, signal: timeoutSignal(signal, opts.timeoutMs ?? 15_000) })
        if (!res.ok) {
          errors.push(`${url}: HTTP ${res.status}`)
          continue
        }
        const raw = await res.json()
        card = readCard(raw, url, opts.dialect, transport)
        signature = await checkSignature(raw, url, opts, signal)
        break
      } catch (e) {
        if (signal?.aborted || (e instanceof A2AError && e.code === ErrorCode.InvalidAgentResponse && opts.requireSignedCard)) throw e
        errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (!card) {
      if (!opts.endpoint) throw new Error(`no A2A agent card found (${errors.join("; ")})`)
      if (opts.requireSignedCard) throw new Error("requireSignedCard: no agent card to verify")
      card = {
        name: new URL(opts.endpoint).host,
        streaming: false,
        pushNotifications: false,
        extendedCard: false,
        interfaces: [],
        bearer: false,
        securitySchemes: {},
        securityRequirements: [],
        signed: false,
      }
    }
    if (signature.status === "valid") log("info", `a2a: ${card.name}: card signature verified (kid ${signature.kid ?? "?"})`)
    else if (signature.status === "invalid")
      log("warn", `a2a: ${card.name}: card signature does NOT verify (${signature.reason}) — set requireSignedCard to refuse such agents`)
    const binding: Binding = opts.endpoint ? (transport === "rest" ? "HTTP+JSON" : "JSONRPC") : (card.endpoint?.binding ?? "JSONRPC")
    const endpoint = opts.endpoint ?? card.endpoint?.url
    if (!endpoint) {
      const offered = [...new Set(card.interfaces.map((i) => `${i.binding} ${i.dialect}`))].join(", ") || "none"
      throw new Error(`${card.name}: the agent card offers no interface this client speaks (offered: ${offered}; supported: JSON-RPC 1.0/0.3, HTTP+JSON 1.0)`)
    }
    const dialect = binding === "HTTP+JSON" ? "1.0" : (opts.dialect ?? card.endpoint?.dialect ?? "1.0")
    return new A2AClient(opts, { card, endpoint, dialect, binding, tenant: opts.endpoint ? undefined : card.endpoint?.tenant, signature })
  }

  get rest(): boolean {
    return this.binding === "HTTP+JSON"
  }

  // ───────────────────────────── HTTP plumbing ─────────────────────────────

  /** fetch with auth applied; one retry with fresh credentials after a 401 (OAuth2 / OIDC). */
  private async request(url: string, init: { method: string; body?: string; accept: string; signal?: AbortSignal }): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const u = new URL(url)
      const headers: Record<string, string> = {
        accept: init.accept,
        "A2A-Version": this.dialect === "1.0" ? "1.0" : "0.3",
        ...(init.body !== undefined ? { "content-type": this.rest ? "application/a2a+json" : "application/json" } : {}),
        ...(this.opts.headers ?? {}),
      }
      await this.auth.apply(u, headers, init.signal)
      const res = await fetch(u, { method: init.method, headers, body: init.body, signal: init.signal })
      if (res.status === 401 && attempt === 0 && this.auth.invalidate()) {
        await res.body?.cancel().catch(() => {})
        continue
      }
      return res
    }
  }

  private restPath(kind: MethodKind, params: Record<string, unknown>): { method: string; path: string; body?: unknown; query?: Record<string, unknown> } {
    const enc = (v: unknown) => encodeURIComponent(String(v ?? ""))
    const id = params.id ?? params.taskId
    switch (kind) {
      case "send":
        return { method: "POST", path: "/message:send", body: params }
      case "stream":
        return { method: "POST", path: "/message:stream", body: params }
      case "get":
        return { method: "GET", path: `/tasks/${enc(params.id)}`, query: { historyLength: params.historyLength } }
      case "list": {
        const { tenant: _t, ...q } = params
        return { method: "GET", path: "/tasks", query: q }
      }
      case "cancel":
        return { method: "POST", path: `/tasks/${enc(params.id)}:cancel`, body: params.metadata ? { metadata: params.metadata } : {} }
      case "subscribe":
        return { method: "GET", path: `/tasks/${enc(params.id)}:subscribe` }
      case "pushSet":
        return { method: "POST", path: `/tasks/${enc(id)}/pushNotificationConfigs`, body: params }
      case "pushGet":
        return { method: "GET", path: `/tasks/${enc(params.taskId)}/pushNotificationConfigs/${enc(params.id)}` }
      case "pushList":
        return { method: "GET", path: `/tasks/${enc(id)}/pushNotificationConfigs`, query: { pageSize: params.pageSize, pageToken: params.pageToken } }
      case "pushDelete":
        return { method: "DELETE", path: `/tasks/${enc(params.taskId)}/pushNotificationConfigs/${enc(params.id)}` }
      case "extendedCard":
        return { method: "GET", path: "/extendedAgentCard" }
    }
  }

  private restUrl(path: string, query?: Record<string, unknown>): string {
    const base = this.endpoint.replace(/\/+$/, "")
    const u = new URL(`${base}${this.tenant ? `/${encodeURIComponent(this.tenant)}` : ""}${path}`)
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v))
    return u.toString()
  }

  private withTenant(params: unknown): unknown {
    return this.tenant && this.dialect === "1.0" && params && typeof params === "object" ? { tenant: this.tenant, ...params } : params
  }

  /** One call; resolves with the (dialect-specific) result or throws an {@link A2AError}. */
  async call(kind: MethodKind, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const sig = timeoutSignal(signal, kind === "send" ? undefined : (this.opts.timeoutMs ?? 30_000))
    if (this.rest) {
      const r = this.restPath(kind, (params ?? {}) as Record<string, unknown>)
      const res = await this.request(this.restUrl(r.path, r.query), {
        method: r.method,
        body: r.body === undefined ? undefined : JSON.stringify(r.body),
        accept: "application/a2a+json, application/json",
        signal: sig,
      })
      const text = await res.text()
      let json: unknown
      try {
        json = text ? JSON.parse(text) : {}
      } catch {
        json = undefined
      }
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) throw notAuthorized(res.status)
        throw restError(res.status, json, text.slice(0, 300) || res.statusText)
      }
      if (json === undefined) throw new A2AError(ErrorCode.InvalidAgentResponse, `invalid JSON from ${r.method} ${r.path}`)
      return json
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: METHODS[this.dialect][kind], params: this.withTenant(params) })
    const res = await this.request(this.endpoint, { method: "POST", body, accept: "application/json", signal: sig })
    return unwrap(await readJson(res))
  }

  /** A streaming call; yields decoded events until the server closes the stream. */
  async *stream(kind: StreamKind, params: unknown, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    let res: Response
    if (this.rest) {
      const r = this.restPath(kind, (params ?? {}) as Record<string, unknown>)
      const url = this.restUrl(r.path)
      res = await this.request(url, { method: r.method, body: r.body === undefined ? undefined : JSON.stringify(r.body), accept: "text/event-stream", signal })
      // the spec's prose says POST for :subscribe, the proto says GET: try the other one
      if (kind === "subscribe" && (res.status === 405 || res.status === 404)) {
        await res.body?.cancel().catch(() => {})
        res = await this.request(url, { method: "POST", body: "{}", accept: "text/event-stream", signal })
      }
    } else {
      const body = JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method: METHODS[this.dialect][kind], params: this.withTenant(params) })
      res = await this.request(this.endpoint, { method: "POST", body, accept: "text/event-stream", signal })
    }
    const type = res.headers.get("content-type") ?? ""
    if (!res.ok || !type.includes("text/event-stream") || !res.body) {
      // errors (and servers that answer a stream request with one JSON response) come back as JSON
      let result: unknown
      if (this.rest) {
        const text = await res.text()
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {}
        if (!res.ok)
          throw res.status === 401 || res.status === 403 ? notAuthorized(res.status) : restError(res.status, json, text.slice(0, 300) || res.statusText)
        result = json
      } else result = unwrap(await readJson(res))
      const ev = decodeResult(result)
      if (!ev) throw new A2AError(ErrorCode.InvalidAgentResponse, "unexpected response to a streaming request")
      yield ev
      return
    }
    for await (const msg of parseSse(res.body, signal)) {
      if (!msg.data.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(msg.data)
      } catch {
        throw new A2AError(ErrorCode.InvalidAgentResponse, `invalid JSON in event stream: ${msg.data.slice(0, 200)}`)
      }
      let result: unknown
      if (this.rest) {
        const p = parsed as { error?: unknown }
        if (p && typeof p === "object" && p.error) throw restError(500, p, "stream error")
        result = parsed
      } else result = unwrap(parsed as JsonRpcResponse)
      const ev = decodeResult(result)
      if (ev) yield ev
    }
  }

  // ───────────────────────────── operations ─────────────────────────────

  sendParams(message: Message, blocking = true): unknown {
    const m = encodeMessage(message, this.dialect)
    const push = this.opts.push && this.card.pushNotifications ? this.opts.push : undefined
    if (this.dialect === "1.0")
      return {
        message: m,
        configuration: {
          acceptedOutputModes: OUTPUT_MODES,
          returnImmediately: !blocking,
          ...(push ? { taskPushNotificationConfig: { url: push.url, token: push.token, authentication: push.authentication } } : {}),
        },
      }
    return {
      message: m,
      configuration: {
        acceptedOutputModes: OUTPUT_MODES,
        blocking,
        ...(push
          ? {
              pushNotificationConfig: {
                url: push.url,
                token: push.token,
                authentication: push.authentication && { schemes: [push.authentication.scheme], credentials: push.authentication.credentials },
              },
            }
          : {}),
      },
    }
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

  async listTasks(params: { contextId?: string; status?: string; pageSize?: number; pageToken?: string; historyLength?: number } = {}, signal?: AbortSignal) {
    const r = (await this.call("list", params, signal)) as { tasks?: unknown[]; nextPageToken?: string; totalSize?: number }
    return { tasks: (r.tasks ?? []).map(decodeTask).filter((t): t is Task => !!t), nextPageToken: r.nextPageToken ?? "", totalSize: r.totalSize }
  }

  async cancelTask(id: string, signal?: AbortSignal): Promise<Task | undefined> {
    return decodeTask(unwrapTask(await this.call("cancel", { id }, signal)))
  }

  resubscribe(id: string, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    return this.stream("subscribe", { id }, signal)
  }

  async setPushConfig(cfg: Omit<PushConfig, "id"> & { id?: string }, signal?: AbortSignal): Promise<PushConfig> {
    const r = await this.call("pushSet", encodePushConfig({ id: cfg.id ?? "", ...cfg }, this.dialect), signal)
    const c = decodePushConfig(r, cfg.taskId)
    return { ...c, id: c.id ?? cfg.id ?? "" }
  }

  async listPushConfigs(taskId: string, signal?: AbortSignal): Promise<PushConfig[]> {
    const r = await this.call("pushList", this.dialect === "1.0" ? { taskId } : { id: taskId }, signal)
    const list = Array.isArray(r) ? r : ((r as { configs?: unknown[] }).configs ?? [])
    return list.map((c) => {
      const d = decodePushConfig(c, taskId)
      return { ...d, id: d.id ?? "" }
    })
  }

  async deletePushConfig(taskId: string, id: string, signal?: AbortSignal): Promise<void> {
    await this.call("pushDelete", this.dialect === "1.0" ? { taskId, id } : { id: taskId, pushNotificationConfigId: id }, signal)
  }
}

async function checkSignature(raw: unknown, cardUrl: string, opts: A2AClientOptions, signal?: AbortSignal): Promise<VerifyResult> {
  let jwks: Jwks | undefined
  if (typeof opts.cardJwks === "string") {
    const res = await fetch(opts.cardJwks, { signal: timeoutSignal(signal, 10_000) })
    if (!res.ok) throw new Error(`cardJwks ${opts.cardJwks}: HTTP ${res.status}`)
    jwks = (await res.json()) as Jwks
  } else jwks = opts.cardJwks
  const result = await verifyCard(raw, {
    jwks,
    cardUrl,
    fetchJwks: async (url) => {
      const res = await fetch(url, { headers: { accept: "application/json" }, signal: timeoutSignal(signal, 10_000) })
      if (!res.ok) throw new Error(`jku ${url}: HTTP ${res.status}`)
      return res.json()
    },
  })
  if (opts.requireSignedCard && result.status !== "valid")
    throw new A2AError(
      ErrorCode.InvalidAgentResponse,
      result.status === "unsigned" ? "requireSignedCard: the agent card is not signed" : `requireSignedCard: invalid card signature (${result.reason})`,
    )
  return result
}

function unwrapTask(r: unknown): unknown {
  return r && typeof r === "object" && "task" in r && !("id" in r) ? (r as { task: unknown }).task : r
}

function notAuthorized(status: number): A2AError {
  return new A2AError(ErrorCode.InvalidRequest, `HTTP ${status}: not authorized (set options.token / apiKey / clientId+clientSecret for this agent)`)
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
  if (res.status === 401 || res.status === 403) throw notAuthorized(res.status)
  throw new A2AError(ErrorCode.InvalidAgentResponse, `HTTP ${res.status}: ${text.slice(0, 300) || res.statusText}`)
}

function unwrap(r: JsonRpcResponse): unknown {
  if (r.error) throw new A2AError(r.error.code, r.error.message, r.error.data)
  return r.result
}
