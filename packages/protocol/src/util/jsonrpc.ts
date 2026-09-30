import { deferred } from "./queue.ts"

export interface JsonRpcMessage {
  jsonrpc?: "2.0"
  id?: number | string | null
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export class JsonRpcError extends Error {
  constructor(
    public code: number,
    message: string,
    public data?: unknown,
  ) {
    super(message)
  }
}

type RequestHandler = (params: any, method: string) => unknown | Promise<unknown>
type NotificationHandler = (params: any, method: string) => void

/**
 * Transport-agnostic JSON-RPC 2.0 peer (both client and server). Feed it incoming
 * messages with `handle()`; it writes outgoing ones through `send`.
 */
export class JsonRpcPeer {
  private nextId = 1
  private pending = new Map<number | string, ReturnType<typeof deferred<unknown>>>()
  private requestHandlers = new Map<string, RequestHandler>()
  private notificationHandlers = new Map<string, NotificationHandler>()
  private fallbackRequest?: RequestHandler
  private fallbackNotification?: NotificationHandler
  closed = false
  private closeReason?: string

  constructor(
    private send: (msg: JsonRpcMessage) => void,
    private opts: { includeVersion?: boolean } = { includeVersion: true },
  ) {}

  onRequest(method: string, h: RequestHandler): this {
    this.requestHandlers.set(method, h)
    return this
  }
  onNotification(method: string, h: NotificationHandler): this {
    this.notificationHandlers.set(method, h)
    return this
  }
  onAnyRequest(h: RequestHandler): this {
    this.fallbackRequest = h
    return this
  }
  onAnyNotification(h: NotificationHandler): this {
    this.fallbackNotification = h
    return this
  }

  private out(msg: JsonRpcMessage): void {
    if (this.closed) return
    this.send(this.opts.includeVersion === false ? msg : { jsonrpc: "2.0", ...msg })
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new JsonRpcError(-32099, this.closeReason ?? "connection closed"))
    const id = this.nextId++
    const d = deferred<unknown>()
    this.pending.set(id, d)
    this.out({ id, method, params })
    if (timeoutMs > 0) {
      const t = setTimeout(() => {
        if (this.pending.delete(id)) d.reject(new JsonRpcError(-32000, `timeout: ${method}`))
      }, timeoutMs)
      d.promise.finally(() => clearTimeout(t)).catch(() => {})
    }
    return d.promise as Promise<T>
  }

  notify(method: string, params?: unknown): void {
    this.out({ method, params })
  }

  async handle(msg: JsonRpcMessage): Promise<void> {
    // Ignore anything that isn't a JSON-RPC object (e.g. a `null` / number / array line from a misbehaving peer).
    if (msg === null || typeof msg !== "object" || Array.isArray(msg)) return
    if (msg.method !== undefined && typeof msg.method !== "string") return
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      const h = this.requestHandlers.get(msg.method) ?? this.fallbackRequest
      if (!h) {
        this.out({ id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } })
        return
      }
      try {
        const result = await h(msg.params, msg.method)
        this.out({ id: msg.id, result: result ?? null })
      } catch (e) {
        const err = e instanceof JsonRpcError ? e : new JsonRpcError(-32603, e instanceof Error ? e.message : String(e))
        this.out({ id: msg.id, error: { code: err.code, message: err.message, data: err.data } })
      }
      return
    }
    if (msg.method !== undefined) {
      const h = this.notificationHandlers.get(msg.method) ?? this.fallbackNotification
      h?.(msg.params, msg.method)
      return
    }
    if (msg.id !== undefined && msg.id !== null) {
      const d = this.pending.get(msg.id)
      if (!d) return
      this.pending.delete(msg.id)
      if (msg.error) d.reject(new JsonRpcError(msg.error.code, msg.error.message, msg.error.data))
      else d.resolve(msg.result)
    }
  }

  close(reason = "connection closed"): void {
    this.closed = true
    this.closeReason ??= reason
    for (const d of this.pending.values()) d.reject(new JsonRpcError(-32099, reason))
    this.pending.clear()
  }
}
