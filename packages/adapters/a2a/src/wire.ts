/**
 * Agent2Agent (A2A) wire model, shared by the client adapter and the daemon's A2A server.
 *
 * Two JSON-RPC dialects are in the wild:
 *   - v1.0 (current stable, a2a-protocol.org/latest): PascalCase methods (`SendMessage`,
 *     `SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`), ProtoJSON payloads
 *     (no `kind` discriminators, `TASK_STATE_*` / `ROLE_*` enums, `{ task }` / `{ message }` /
 *     `{ statusUpdate }` / `{ artifactUpdate }` wrappers, parts as `{ text | raw | url | data }`),
 *     `A2A-Version: 1.0` header, card with `supportedInterfaces`.
 *   - v0.3 (still the most deployed): slash methods (`message/send`, `message/stream`, `tasks/get`,
 *     `tasks/cancel`, `tasks/resubscribe`), `kind`-tagged objects, lowercase-kebab states,
 *     `final` on status updates, card with `url` / `preferredTransport`.
 *
 * Internally everything is normalized to the v0.3 shapes below (they are plain, tagged JS objects);
 * `encodeV1*` / `decode*` convert at the edges. Decoders accept either dialect.
 *
 * Pure TypeScript with no imports, so the daemon can use it without a package dependency.
 */

export const A2A_PROTOCOL_VERSION = "1.0"
export const A2A_LEGACY_VERSION = "0.3.0"

export type Dialect = "1.0" | "0.3"

export type TaskState = "submitted" | "working" | "input-required" | "completed" | "canceled" | "failed" | "rejected" | "auth-required" | "unknown"

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set(["completed", "canceled", "failed", "rejected"])
/** States in which the task waits for the client (a stream ends here too). */
export const INTERRUPTED_STATES: ReadonlySet<TaskState> = new Set(["input-required", "auth-required"])

export function isFinalState(s: TaskState): boolean {
  return TERMINAL_STATES.has(s) || INTERRUPTED_STATES.has(s)
}

export type FileContent = { name?: string; mimeType?: string; bytes?: string; uri?: string }

export type Part =
  | { kind: "text"; text: string; metadata?: Record<string, unknown> }
  | { kind: "file"; file: FileContent; metadata?: Record<string, unknown> }
  | { kind: "data"; data: unknown; metadata?: Record<string, unknown> }

export interface Message {
  kind: "message"
  messageId: string
  role: "user" | "agent"
  parts: Part[]
  contextId?: string
  taskId?: string
  referenceTaskIds?: string[]
  extensions?: string[]
  metadata?: Record<string, unknown>
}

export interface TaskStatus {
  state: TaskState
  message?: Message
  timestamp?: string
}

export interface Artifact {
  artifactId: string
  name?: string
  description?: string
  parts: Part[]
  metadata?: Record<string, unknown>
  extensions?: string[]
}

export interface Task {
  kind: "task"
  id: string
  contextId: string
  status: TaskStatus
  history?: Message[]
  artifacts?: Artifact[]
  metadata?: Record<string, unknown>
}

export interface TaskStatusUpdateEvent {
  kind: "status-update"
  taskId: string
  contextId: string
  status: TaskStatus
  final: boolean
  metadata?: Record<string, unknown>
}

export interface TaskArtifactUpdateEvent {
  kind: "artifact-update"
  taskId: string
  contextId: string
  artifact: Artifact
  append?: boolean
  lastChunk?: boolean
  metadata?: Record<string, unknown>
}

export type StreamEvent = Task | Message | TaskStatusUpdateEvent | TaskArtifactUpdateEvent

// ───────────────────────────── JSON-RPC ─────────────────────────────

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  Internal: -32603,
  TaskNotFound: -32001,
  TaskNotCancelable: -32002,
  PushNotificationNotSupported: -32003,
  UnsupportedOperation: -32004,
  ContentTypeNotSupported: -32005,
  InvalidAgentResponse: -32006,
  ExtendedCardNotConfigured: -32007,
  ExtensionSupportRequired: -32008,
  VersionNotSupported: -32009,
} as const

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: JsonRpcError
}

export class A2AError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message)
    this.name = "A2AError"
  }
}

export type MethodKind = "send" | "stream" | "get" | "cancel" | "subscribe" | "list" | "extendedCard" | "push"

export const METHODS: Record<Dialect, Record<Exclude<MethodKind, "push">, string>> = {
  "1.0": {
    send: "SendMessage",
    stream: "SendStreamingMessage",
    get: "GetTask",
    cancel: "CancelTask",
    subscribe: "SubscribeToTask",
    list: "ListTasks",
    extendedCard: "GetExtendedAgentCard",
  },
  "0.3": {
    send: "message/send",
    stream: "message/stream",
    get: "tasks/get",
    cancel: "tasks/cancel",
    subscribe: "tasks/resubscribe",
    list: "tasks/list",
    extendedCard: "agent/getAuthenticatedExtendedCard",
  },
}

/** Which dialect + operation a JSON-RPC method name belongs to. */
export function classifyMethod(method: string): { dialect: Dialect; kind: MethodKind } | undefined {
  for (const dialect of ["1.0", "0.3"] as const) {
    for (const [kind, name] of Object.entries(METHODS[dialect])) if (name === method) return { dialect, kind: kind as MethodKind }
  }
  if (/PushNotificationConfig/.test(method)) return { dialect: method.includes("/") ? "0.3" : "1.0", kind: "push" }
  return undefined
}

// ───────────────────────────── decoding (either dialect) ─────────────────────────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

export function normalizeState(s: unknown): TaskState {
  if (typeof s !== "string") return "unknown"
  const k = s
    .replace(/^TASK_STATE_/i, "")
    .toLowerCase()
    .replace(/_/g, "-")
  switch (k) {
    case "submitted":
    case "working":
    case "input-required":
    case "completed":
    case "failed":
    case "rejected":
    case "auth-required":
      return k
    case "canceled":
    case "cancelled":
      return "canceled"
    default:
      return "unknown"
  }
}

export function normalizeRole(r: unknown): "user" | "agent" {
  return typeof r === "string" && /agent/i.test(r) ? "agent" : "user"
}

export function decodePart(p: unknown): Part | undefined {
  if (!isObj(p)) return undefined
  const metadata = isObj(p.metadata) ? p.metadata : undefined
  const kind = str(p.kind) ?? str(p.type)
  if (kind === "text" || (kind === undefined && typeof p.text === "string")) return { kind: "text", text: String(p.text ?? ""), metadata }
  if (kind === "file" && isObj(p.file)) {
    const f = p.file
    return {
      kind: "file",
      file: { name: str(f.name), mimeType: str(f.mimeType) ?? str(f.mediaType), bytes: str(f.bytes), uri: str(f.uri) ?? str(f.url) },
      metadata,
    }
  }
  if (kind === "data" || (kind === undefined && "data" in p)) return { kind: "data", data: p.data, metadata }
  if (kind === undefined && (typeof p.raw === "string" || typeof p.url === "string")) {
    return { kind: "file", file: { name: str(p.filename), mimeType: str(p.mediaType), bytes: str(p.raw), uri: str(p.url) }, metadata }
  }
  return undefined
}

export function decodeMessage(m: unknown): Message | undefined {
  if (!isObj(m) || !Array.isArray(m.parts)) return undefined
  return {
    kind: "message",
    messageId: str(m.messageId) ?? crypto.randomUUID(),
    role: normalizeRole(m.role),
    parts: m.parts.map(decodePart).filter((p): p is Part => !!p),
    contextId: str(m.contextId),
    taskId: str(m.taskId),
    referenceTaskIds: Array.isArray(m.referenceTaskIds) ? m.referenceTaskIds.filter((x): x is string => typeof x === "string") : undefined,
    extensions: Array.isArray(m.extensions) ? m.extensions.filter((x): x is string => typeof x === "string") : undefined,
    metadata: isObj(m.metadata) ? m.metadata : undefined,
  }
}

function decodeStatus(s: unknown): TaskStatus {
  if (!isObj(s)) return { state: "unknown" }
  return { state: normalizeState(s.state), message: s.message ? decodeMessage(s.message) : undefined, timestamp: str(s.timestamp) }
}

export function decodeArtifact(a: unknown): Artifact | undefined {
  if (!isObj(a)) return undefined
  return {
    artifactId: str(a.artifactId) ?? crypto.randomUUID(),
    name: str(a.name),
    description: str(a.description),
    parts: Array.isArray(a.parts) ? a.parts.map(decodePart).filter((p): p is Part => !!p) : [],
    metadata: isObj(a.metadata) ? a.metadata : undefined,
  }
}

export function decodeTask(t: unknown): Task | undefined {
  if (!isObj(t) || typeof t.id !== "string") return undefined
  return {
    kind: "task",
    id: t.id,
    contextId: str(t.contextId) ?? "",
    status: decodeStatus(t.status),
    history: Array.isArray(t.history) ? t.history.map(decodeMessage).filter((m): m is Message => !!m) : undefined,
    artifacts: Array.isArray(t.artifacts) ? t.artifacts.map(decodeArtifact).filter((a): a is Artifact => !!a) : undefined,
    metadata: isObj(t.metadata) ? t.metadata : undefined,
  }
}

function decodeStatusUpdate(u: Obj): TaskStatusUpdateEvent {
  const status = decodeStatus(u.status)
  return {
    kind: "status-update",
    taskId: str(u.taskId) ?? "",
    contextId: str(u.contextId) ?? "",
    status,
    // v1.0 dropped `final`: the stream ends after a terminal or interrupted state
    final: typeof u.final === "boolean" ? u.final : isFinalState(status.state),
    metadata: isObj(u.metadata) ? u.metadata : undefined,
  }
}

function decodeArtifactUpdate(u: Obj): TaskArtifactUpdateEvent | undefined {
  const artifact = decodeArtifact(u.artifact)
  if (!artifact) return undefined
  return {
    kind: "artifact-update",
    taskId: str(u.taskId) ?? "",
    contextId: str(u.contextId) ?? "",
    artifact,
    append: typeof u.append === "boolean" ? u.append : undefined,
    lastChunk: typeof u.lastChunk === "boolean" ? u.lastChunk : undefined,
    metadata: isObj(u.metadata) ? u.metadata : undefined,
  }
}

/**
 * A `result` of SendMessage / SendStreamingMessage / GetTask / CancelTask in either dialect:
 * a `kind`-tagged object (v0.3), a `{ task | message | statusUpdate | artifactUpdate }` wrapper
 * (v1.0), or a bare v1.0 Task / Message.
 */
export function decodeResult(r: unknown): StreamEvent | undefined {
  if (!isObj(r)) return undefined
  switch (r.kind) {
    case "task":
      return decodeTask(r)
    case "message":
      return decodeMessage(r)
    case "status-update":
      return decodeStatusUpdate(r)
    case "artifact-update":
      return decodeArtifactUpdate(r)
  }
  if (isObj(r.task)) return decodeTask(r.task)
  if (isObj(r.message)) return decodeMessage(r.message)
  if (isObj(r.statusUpdate)) return decodeStatusUpdate(r.statusUpdate)
  if (isObj(r.artifactUpdate)) return decodeArtifactUpdate(r.artifactUpdate)
  // bare v1.0 objects
  if (typeof r.id === "string" && isObj(r.status)) return decodeTask(r)
  if (typeof r.messageId === "string" && Array.isArray(r.parts)) return decodeMessage(r)
  if (typeof r.taskId === "string" && isObj(r.status)) return decodeStatusUpdate(r)
  if (typeof r.taskId === "string" && isObj(r.artifact)) return decodeArtifactUpdate(r)
  return undefined
}

// ───────────────────────────── encoding ─────────────────────────────

const V1_STATE: Record<TaskState, string> = {
  submitted: "TASK_STATE_SUBMITTED",
  working: "TASK_STATE_WORKING",
  "input-required": "TASK_STATE_INPUT_REQUIRED",
  completed: "TASK_STATE_COMPLETED",
  canceled: "TASK_STATE_CANCELED",
  failed: "TASK_STATE_FAILED",
  rejected: "TASK_STATE_REJECTED",
  "auth-required": "TASK_STATE_AUTH_REQUIRED",
  unknown: "TASK_STATE_UNSPECIFIED",
}

function compact<T extends Obj>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]
  return o
}

export function encodeV1Part(p: Part): Obj {
  if (p.kind === "text") return compact({ text: p.text, metadata: p.metadata })
  if (p.kind === "data") return compact({ data: p.data, metadata: p.metadata })
  return compact({ raw: p.file.bytes, url: p.file.bytes ? undefined : p.file.uri, filename: p.file.name, mediaType: p.file.mimeType, metadata: p.metadata })
}

export function encodeV1Message(m: Message): Obj {
  return compact({
    messageId: m.messageId,
    contextId: m.contextId,
    taskId: m.taskId,
    role: m.role === "agent" ? "ROLE_AGENT" : "ROLE_USER",
    parts: m.parts.map(encodeV1Part),
    metadata: m.metadata,
    extensions: m.extensions,
    referenceTaskIds: m.referenceTaskIds,
  })
}

function encodeV1Status(s: TaskStatus): Obj {
  return compact({ state: V1_STATE[s.state], message: s.message ? encodeV1Message(s.message) : undefined, timestamp: s.timestamp })
}

function encodeV1Artifact(a: Artifact): Obj {
  return compact({
    artifactId: a.artifactId,
    name: a.name,
    description: a.description,
    parts: a.parts.map(encodeV1Part),
    metadata: a.metadata,
    extensions: a.extensions,
  })
}

export function encodeV1Task(t: Task): Obj {
  return compact({
    id: t.id,
    contextId: t.contextId,
    status: encodeV1Status(t.status),
    artifacts: t.artifacts?.map(encodeV1Artifact),
    history: t.history?.map(encodeV1Message),
    metadata: t.metadata,
  })
}

/** v1.0 `StreamResponse` / `SendMessageResponse` wrapper. */
export function encodeV1Event(e: StreamEvent): Obj {
  switch (e.kind) {
    case "task":
      return { task: encodeV1Task(e) }
    case "message":
      return { message: encodeV1Message(e) }
    case "status-update":
      return { statusUpdate: compact({ taskId: e.taskId, contextId: e.contextId, status: encodeV1Status(e.status), metadata: e.metadata }) }
    case "artifact-update":
      return {
        artifactUpdate: compact({
          taskId: e.taskId,
          contextId: e.contextId,
          artifact: encodeV1Artifact(e.artifact),
          append: e.append,
          lastChunk: e.lastChunk,
          metadata: e.metadata,
        }),
      }
  }
}

/** Encode a v0.3 / internal event for the given dialect (stream events and SendMessage results). */
export function encodeEvent(e: StreamEvent, dialect: Dialect): unknown {
  return dialect === "1.0" ? encodeV1Event(e) : e
}

/** Encode a bare Task (GetTask / CancelTask results). */
export function encodeTask(t: Task, dialect: Dialect): unknown {
  return dialect === "1.0" ? encodeV1Task(t) : t
}

/** Encode the outgoing `message` param of SendMessage in the given dialect. */
export function encodeMessage(m: Message, dialect: Dialect): unknown {
  return dialect === "1.0" ? encodeV1Message(m) : m
}

// ───────────────────────────── helpers ─────────────────────────────

export function textOf(parts: readonly Part[] | undefined): string {
  return (parts ?? [])
    .filter((p): p is Extract<Part, { kind: "text" }> => p.kind === "text")
    .map((p) => p.text)
    .join("\n")
}

export function textMessage(role: "user" | "agent", text: string, extra: Partial<Message> = {}): Message {
  return { kind: "message", messageId: crypto.randomUUID(), role, parts: [{ kind: "text", text }], ...extra }
}

// ───────────────────────────── agent card ─────────────────────────────

export interface AgentInterface {
  url: string
  protocolBinding: string
  protocolVersion: string
  tenant?: string
}

/** The parts of an agent card (either dialect) a client needs. */
export interface CardInfo {
  name: string
  description?: string
  version?: string
  streaming: boolean
  /** JSON-RPC endpoint + dialect to speak, if the card offers a JSON-RPC binding. */
  endpoint?: { url: string; dialect: Dialect }
  bearer: boolean
}

export function readCard(card: unknown, cardUrl: string, prefer?: Dialect): CardInfo {
  if (!isObj(card)) throw new Error("agent card is not a JSON object")
  const caps = isObj(card.capabilities) ? card.capabilities : {}
  const candidates: { url: string; dialect: Dialect }[] = []
  const dialectOf = (v: unknown): Dialect => (typeof v === "string" && /^0\./.test(v) ? "0.3" : "1.0")
  const isJsonRpc = (b: unknown) => typeof b === "string" && b.replace(/[-_]/g, "").toUpperCase() === "JSONRPC"
  if (Array.isArray(card.supportedInterfaces)) {
    for (const i of card.supportedInterfaces)
      if (isObj(i) && typeof i.url === "string" && isJsonRpc(i.protocolBinding)) candidates.push({ url: i.url, dialect: dialectOf(i.protocolVersion) })
  }
  // v0.3 card: `url` is the preferred transport's endpoint, `additionalInterfaces` lists others
  if (typeof card.url === "string") {
    const pref = str(card.preferredTransport) ?? "JSONRPC"
    if (isJsonRpc(pref)) candidates.push({ url: card.url, dialect: "0.3" })
  }
  if (Array.isArray(card.additionalInterfaces)) {
    for (const i of card.additionalInterfaces)
      if (isObj(i) && typeof i.url === "string" && isJsonRpc(i.transport)) candidates.push({ url: i.url, dialect: "0.3" })
  }
  let endpoint = (prefer && candidates.find((c) => c.dialect === prefer)) || candidates.find((c) => c.dialect === "1.0") || candidates[0]
  if (endpoint) endpoint = { url: new URL(endpoint.url, cardUrl).toString(), dialect: prefer ?? endpoint.dialect }
  const schemes = isObj(card.securitySchemes) ? Object.values(card.securitySchemes) : []
  const bearer = schemes.some(
    (s) =>
      isObj(s) &&
      ((s.type === "http" && /bearer/i.test(String(s.scheme))) || (isObj(s.httpAuthSecurityScheme) && /bearer/i.test(String(s.httpAuthSecurityScheme.scheme)))),
  )
  return {
    name: str(card.name) ?? "a2a agent",
    description: str(card.description),
    version: str(card.version),
    streaming: caps.streaming === true,
    endpoint,
    bearer,
  }
}

// ───────────────────────────── SSE ─────────────────────────────

/**
 * Server-Sent Events parser (WHATWG event-stream rules): multi-line `data:` fields are joined
 * with "\n", comment lines (`:`) and other fields are ignored, CR / LF / CRLF line endings
 * (also split across chunks), and a final event without a trailing blank line is dispatched.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<{ event?: string; data: string; id?: string }> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  let buf = ""
  let data: string[] = []
  let event: string | undefined
  let id: string | undefined
  let first = true
  const onAbort = () => void reader.cancel().catch(() => {})
  signal?.addEventListener("abort", onAbort, { once: true })
  const line = (l: string): { event?: string; data: string; id?: string } | undefined => {
    if (l === "") {
      if (data.length === 0) {
        event = undefined
        return undefined
      }
      const out = { event, data: data.join("\n"), id }
      data = []
      event = undefined
      return out
    }
    if (l.startsWith(":")) return undefined
    const i = l.indexOf(":")
    const field = i < 0 ? l : l.slice(0, i)
    let value = i < 0 ? "" : l.slice(i + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "data") data.push(value)
    else if (field === "event") event = value
    else if (field === "id" && !value.includes("\0")) id = value
    return undefined
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      if (first && buf.length) {
        if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1)
        first = false
      }
      let start = 0
      for (let i = 0; i < buf.length; i++) {
        const c = buf[i]
        if (c !== "\n" && c !== "\r") continue
        // a CR at the very end may be the first half of a CRLF in the next chunk
        if (c === "\r" && i === buf.length - 1) break
        const ev = line(buf.slice(start, i))
        if (c === "\r" && buf[i + 1] === "\n") i++
        start = i + 1
        if (ev) yield ev
      }
      buf = buf.slice(start)
    }
    buf += dec.decode()
    for (const l of buf.split(/\r\n|\r|\n/)) {
      const ev = line(l)
      if (ev) yield ev
    }
    const last = line("")
    if (last) yield last
  } finally {
    signal?.removeEventListener("abort", onAbort)
    try {
      reader.releaseLock()
    } catch {}
  }
}
