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
 * Also: push-notification config codecs, REST error mapping, card reading (interfaces,
 * security schemes) and — re-exported from ./sign.ts — agent-card signing (JCS + JWS).
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

export type MethodKind = "send" | "stream" | "get" | "cancel" | "subscribe" | "list" | "extendedCard" | "pushSet" | "pushGet" | "pushList" | "pushDelete"

export const METHODS: Record<Dialect, Record<MethodKind, string>> = {
  "1.0": {
    send: "SendMessage",
    stream: "SendStreamingMessage",
    get: "GetTask",
    cancel: "CancelTask",
    subscribe: "SubscribeToTask",
    list: "ListTasks",
    extendedCard: "GetExtendedAgentCard",
    pushSet: "CreateTaskPushNotificationConfig",
    pushGet: "GetTaskPushNotificationConfig",
    pushList: "ListTaskPushNotificationConfigs",
    pushDelete: "DeleteTaskPushNotificationConfig",
  },
  "0.3": {
    send: "message/send",
    stream: "message/stream",
    get: "tasks/get",
    cancel: "tasks/cancel",
    subscribe: "tasks/resubscribe",
    list: "tasks/list",
    extendedCard: "agent/getAuthenticatedExtendedCard",
    pushSet: "tasks/pushNotificationConfig/set",
    pushGet: "tasks/pushNotificationConfig/get",
    pushList: "tasks/pushNotificationConfig/list",
    pushDelete: "tasks/pushNotificationConfig/delete",
  },
}

/** Method names seen in drafts / other SDKs, accepted as aliases. */
const METHOD_ALIASES: Record<string, { dialect: Dialect; kind: MethodKind }> = {
  SetTaskPushNotificationConfig: { dialect: "1.0", kind: "pushSet" },
  ListTaskPushNotificationConfig: { dialect: "1.0", kind: "pushList" },
  GetAuthenticatedExtendedCard: { dialect: "1.0", kind: "extendedCard" },
}

/** Which dialect + operation a JSON-RPC method name belongs to. */
export function classifyMethod(method: string): { dialect: Dialect; kind: MethodKind } | undefined {
  for (const dialect of ["1.0", "0.3"] as const) {
    for (const [kind, name] of Object.entries(METHODS[dialect])) if (name === method) return { dialect, kind: kind as MethodKind }
  }
  return METHOD_ALIASES[method]
}

// ───────────────────────────── errors ↔ HTTP (REST binding) ─────────────────────────────

/** A2A error code → (HTTP status, google.rpc.ErrorInfo reason), per spec §5.4. */
export const ERROR_REASONS: Record<number, { http: number; reason: string }> = {
  [ErrorCode.TaskNotFound]: { http: 404, reason: "TASK_NOT_FOUND" },
  [ErrorCode.TaskNotCancelable]: { http: 400, reason: "TASK_NOT_CANCELABLE" },
  [ErrorCode.PushNotificationNotSupported]: { http: 400, reason: "PUSH_NOTIFICATION_NOT_SUPPORTED" },
  [ErrorCode.UnsupportedOperation]: { http: 400, reason: "UNSUPPORTED_OPERATION" },
  [ErrorCode.ContentTypeNotSupported]: { http: 400, reason: "CONTENT_TYPE_NOT_SUPPORTED" },
  [ErrorCode.InvalidAgentResponse]: { http: 500, reason: "INVALID_AGENT_RESPONSE" },
  [ErrorCode.ExtendedCardNotConfigured]: { http: 400, reason: "EXTENDED_AGENT_CARD_NOT_CONFIGURED" },
  [ErrorCode.ExtensionSupportRequired]: { http: 400, reason: "EXTENSION_SUPPORT_REQUIRED" },
  [ErrorCode.VersionNotSupported]: { http: 400, reason: "VERSION_NOT_SUPPORTED" },
  [ErrorCode.InvalidParams]: { http: 400, reason: "INVALID_ARGUMENT" },
  [ErrorCode.InvalidRequest]: { http: 400, reason: "INVALID_REQUEST" },
  [ErrorCode.ParseError]: { http: 400, reason: "PARSE_ERROR" },
  [ErrorCode.MethodNotFound]: { http: 404, reason: "METHOD_NOT_FOUND" },
  [ErrorCode.Internal]: { http: 500, reason: "INTERNAL" },
}

const HTTP_STATUS_NAMES: Record<number, string> = {
  400: "INVALID_ARGUMENT",
  401: "UNAUTHENTICATED",
  403: "PERMISSION_DENIED",
  404: "NOT_FOUND",
  405: "UNIMPLEMENTED",
  409: "FAILED_PRECONDITION",
  500: "INTERNAL",
}

/** The REST binding's error body (google.rpc.Status JSON with an ErrorInfo detail). */
export function restErrorBody(code: number, message: string): { status: number; body: unknown } {
  const m = ERROR_REASONS[code] ?? { http: 500, reason: "INTERNAL" }
  const status = code === ErrorCode.TaskNotCancelable || code === ErrorCode.PushNotificationNotSupported ? 400 : m.http
  return {
    status,
    body: {
      error: {
        code: status,
        status: HTTP_STATUS_NAMES[status] ?? (status >= 500 ? "INTERNAL" : "FAILED_PRECONDITION"),
        message,
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: m.reason, domain: "a2a-protocol.org" }],
      },
    },
  }
}

/** Parse a REST error body back into an {@link A2AError}. */
export function restError(httpStatus: number, body: unknown, fallback: string): A2AError {
  const err = isObj(body) && isObj(body.error) ? body.error : undefined
  const message = (err && str(err.message)) || fallback
  const details = err && Array.isArray(err.details) ? err.details : []
  for (const d of details) {
    if (!isObj(d) || typeof d.reason !== "string") continue
    for (const [code, v] of Object.entries(ERROR_REASONS)) if (v.reason === d.reason) return new A2AError(Number(code), message, details)
  }
  const byStatus: Record<number, number> = {
    404: ErrorCode.TaskNotFound,
    400: ErrorCode.InvalidParams,
    401: ErrorCode.InvalidRequest,
    403: ErrorCode.InvalidRequest,
  }
  return new A2AError(byStatus[httpStatus] ?? ErrorCode.InvalidAgentResponse, `HTTP ${httpStatus}: ${message}`, details.length ? details : undefined)
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

// ───────────────────────────── push notification configs ─────────────────────────────

/** A task's push-notification (webhook) configuration, dialect-neutral. */
export interface PushConfig {
  id: string
  taskId: string
  url: string
  /** Echoed to the webhook as `X-A2A-Notification-Token` so the receiver can validate it. */
  token?: string
  /** Sent as `Authorization: <scheme> <credentials>`. */
  authentication?: { scheme: string; credentials?: string }
}

/**
 * Decode a push config from any shape in use: v1.0 `TaskPushNotificationConfig` (flat:
 * `{ taskId, id, url, token, authentication: { scheme, credentials } }`), v1.0 drafts
 * (`{ taskId, config | pushNotificationConfig: {…} }`) and v0.3
 * (`{ taskId, pushNotificationConfig: { id, url, token, authentication: { schemes, credentials } } }`).
 * Also accepts a bare `PushNotificationConfig` (SendMessageConfiguration) with `taskId` given separately.
 */
export function decodePushConfig(p: unknown, taskId?: string): Omit<PushConfig, "id"> & { id?: string } {
  if (!isObj(p)) throw new A2AError(ErrorCode.InvalidParams, "push notification config must be an object")
  const inner = isObj(p.pushNotificationConfig) ? p.pushNotificationConfig : isObj(p.config) ? p.config : p
  const url = str(inner.url)
  if (!url) throw new A2AError(ErrorCode.InvalidParams, "push notification config needs a url")
  const tid = str(p.taskId) ?? str(p.task_id) ?? taskId
  if (!tid) throw new A2AError(ErrorCode.InvalidParams, "push notification config needs a taskId")
  let authentication: PushConfig["authentication"]
  if (isObj(inner.authentication)) {
    const a = inner.authentication
    const scheme = str(a.scheme) ?? (Array.isArray(a.schemes) ? str(a.schemes[0]) : undefined)
    if (scheme) authentication = { scheme, credentials: str(a.credentials) }
  }
  return { id: str(inner.id) ?? str(p.configId) ?? str(p.id === tid ? undefined : p.id), taskId: tid, url, token: str(inner.token), authentication }
}

export function encodePushConfig(c: PushConfig, dialect: Dialect): Obj {
  if (dialect === "1.0")
    return compact({ id: c.id, taskId: c.taskId, url: c.url, token: c.token, authentication: c.authentication && compact({ ...c.authentication }) })
  return {
    taskId: c.taskId,
    pushNotificationConfig: compact({
      id: c.id,
      url: c.url,
      token: c.token,
      authentication: c.authentication && compact({ schemes: [c.authentication.scheme], credentials: c.authentication.credentials }),
    }),
  }
}

// ───────────────────────────── agent card ─────────────────────────────

export interface AgentInterface {
  url: string
  protocolBinding: string
  protocolVersion: string
  tenant?: string
}

export type Binding = "JSONRPC" | "HTTP+JSON" | "GRPC"

/** One way to reach the agent: binding + dialect at a URL. */
export interface Endpoint {
  url: string
  binding: Binding
  dialect: Dialect
  tenant?: string
}

/** A security scheme from the card, normalized from either dialect. */
export type SecurityScheme =
  | { type: "http"; scheme: string; description?: string }
  | { type: "apiKey"; location: "header" | "query" | "cookie"; name: string; description?: string }
  | { type: "oauth2"; tokenUrl?: string; scopes: string[]; metadataUrl?: string; flows: string[]; description?: string }
  | { type: "openIdConnect"; url: string; description?: string }
  | { type: "mtls"; description?: string }
  | { type: "unknown"; description?: string }

/** A security requirement: scheme name → scopes. Any one requirement in the list suffices. */
export type SecurityRequirement = Record<string, string[]>

/** The parts of an agent card (either dialect) a client needs. */
export interface CardInfo {
  name: string
  description?: string
  version?: string
  streaming: boolean
  pushNotifications: boolean
  extendedCard: boolean
  /** The interface to use (JSON-RPC or HTTP+JSON, per preference and what the card offers). */
  endpoint?: Endpoint
  /** Every interface the card lists (including ones this client can't speak, e.g. gRPC). */
  interfaces: Endpoint[]
  /** Whether the card declares an HTTP bearer scheme. */
  bearer: boolean
  securitySchemes: Record<string, SecurityScheme>
  securityRequirements: SecurityRequirement[]
  signed: boolean
}

export type TransportPref = "auto" | "jsonrpc" | "rest"

export function normalizeBinding(b: unknown): Binding | undefined {
  if (typeof b !== "string") return undefined
  const k = b.replace(/[-_\s]/g, "").toUpperCase()
  if (k === "JSONRPC") return "JSONRPC"
  if (k === "HTTP+JSON" || k === "HTTPJSON" || k === "REST") return "HTTP+JSON"
  if (k === "GRPC") return "GRPC"
  return undefined
}

function normalizeScheme(s: unknown): SecurityScheme {
  if (!isObj(s)) return { type: "unknown" }
  const description = str(s.description)
  const flowsOf = (f: unknown) => {
    const flows = isObj(f) ? f : {}
    const cc = isObj(flows.clientCredentials) ? flows.clientCredentials : isObj(flows.client_credentials) ? flows.client_credentials : undefined
    return {
      tokenUrl: cc ? (str(cc.tokenUrl) ?? str(cc.token_url)) : undefined,
      scopes: cc && isObj(cc.scopes) ? Object.keys(cc.scopes) : [],
      flows: Object.keys(flows),
    }
  }
  // v1.0 ProtoJSON: a oneof wrapper
  if (isObj(s.httpAuthSecurityScheme)) return { type: "http", scheme: str(s.httpAuthSecurityScheme.scheme) ?? "bearer", description }
  if (isObj(s.apiKeySecurityScheme)) {
    const a = s.apiKeySecurityScheme
    return { type: "apiKey", location: apiKeyLocation(a.location ?? a.in), name: str(a.name) ?? "x-api-key", description }
  }
  if (isObj(s.oauth2SecurityScheme)) {
    const o = s.oauth2SecurityScheme
    return { type: "oauth2", ...flowsOf(o.flows), metadataUrl: str(o.oauth2MetadataUrl), description }
  }
  if (isObj(s.openIdConnectSecurityScheme)) return { type: "openIdConnect", url: str(s.openIdConnectSecurityScheme.openIdConnectUrl) ?? "", description }
  if (isObj(s.mtlsSecurityScheme)) return { type: "mtls", description }
  // v0.3 / OpenAPI: `type`-tagged
  switch (s.type) {
    case "http":
      return { type: "http", scheme: str(s.scheme) ?? "bearer", description }
    case "apiKey":
      return { type: "apiKey", location: apiKeyLocation(s.in ?? s.location), name: str(s.name) ?? "x-api-key", description }
    case "oauth2":
      return { type: "oauth2", ...flowsOf(s.flows), metadataUrl: str(s.oauth2MetadataUrl), description }
    case "openIdConnect":
      return { type: "openIdConnect", url: str(s.openIdConnectUrl) ?? "", description }
    case "mutualTLS":
      return { type: "mtls", description }
  }
  return { type: "unknown", description }
}

function apiKeyLocation(v: unknown): "header" | "query" | "cookie" {
  const k = typeof v === "string" ? v.toLowerCase() : ""
  return k === "query" || k === "cookie" ? k : "header"
}

function readRequirements(card: Obj): SecurityRequirement[] {
  const out: SecurityRequirement[] = []
  // v1.0: [{ schemes: { name: { list: [scopes] } } }]
  if (Array.isArray(card.securityRequirements)) {
    for (const r of card.securityRequirements) {
      if (!isObj(r) || !isObj(r.schemes)) continue
      const req: SecurityRequirement = {}
      for (const [name, v] of Object.entries(r.schemes)) req[name] = isObj(v) && Array.isArray(v.list) ? v.list.map(String) : []
      out.push(req)
    }
  }
  // v0.3 / OpenAPI: [{ name: [scopes] }]
  if (!out.length && Array.isArray(card.security)) {
    for (const r of card.security) {
      if (!isObj(r)) continue
      const req: SecurityRequirement = {}
      for (const [name, v] of Object.entries(r)) req[name] = Array.isArray(v) ? v.map(String) : []
      out.push(req)
    }
  }
  return out
}

/**
 * Read a card and pick the interface to use. Interfaces this client speaks: JSON-RPC (v1.0 and
 * v0.3) and HTTP+JSON (v1.0). `prefer` forces a dialect; `transport` forces a binding. With
 * neither, the card's own order wins among v1.0 interfaces (the first listed is the agent's
 * preferred one), then v0.3 JSON-RPC.
 */
export function readCard(card: unknown, cardUrl: string, prefer?: Dialect, transport: TransportPref = "auto"): CardInfo {
  if (!isObj(card)) throw new Error("agent card is not a JSON object")
  const caps = isObj(card.capabilities) ? card.capabilities : {}
  const interfaces: Endpoint[] = []
  const dialectOf = (v: unknown): Dialect => (typeof v === "string" && /^0\./.test(v) ? "0.3" : "1.0")
  const abs = (u: string) => {
    try {
      return new URL(u, cardUrl).toString()
    } catch {
      return u
    }
  }
  if (Array.isArray(card.supportedInterfaces)) {
    for (const i of card.supportedInterfaces) {
      const binding = isObj(i) ? normalizeBinding(i.protocolBinding) : undefined
      if (isObj(i) && typeof i.url === "string" && binding)
        interfaces.push({ url: binding === "GRPC" ? i.url : abs(i.url), binding, dialect: dialectOf(i.protocolVersion), tenant: str(i.tenant) || undefined })
    }
  }
  // v0.3 card: `url` is the preferred transport's endpoint, `additionalInterfaces` lists others
  if (typeof card.url === "string") {
    const binding = normalizeBinding(str(card.preferredTransport) ?? "JSONRPC")
    if (binding) interfaces.push({ url: abs(card.url), binding, dialect: "0.3" })
  }
  if (Array.isArray(card.additionalInterfaces)) {
    for (const i of card.additionalInterfaces) {
      const binding = isObj(i) ? normalizeBinding(i.transport) : undefined
      if (isObj(i) && typeof i.url === "string" && binding) interfaces.push({ url: abs(i.url), binding, dialect: "0.3" })
    }
  }
  // what this client can speak: JSON-RPC (either dialect) and HTTP+JSON v1.0 (v0.3's REST used a different JSON shape)
  const usable = interfaces.filter(
    (c) =>
      (c.binding === "JSONRPC" || (c.binding === "HTTP+JSON" && c.dialect === "1.0")) &&
      (transport === "auto" || (transport === "rest") === (c.binding === "HTTP+JSON")),
  )
  let endpoint = (prefer && usable.find((c) => c.dialect === prefer)) || usable.find((c) => c.dialect === "1.0") || usable[0]
  // forcing 0.3 on a card that only lists v1.0 JSON-RPC: same URL, older dialect
  if (endpoint && prefer && endpoint.dialect !== prefer && endpoint.binding === "JSONRPC") endpoint = { ...endpoint, dialect: prefer }
  const securitySchemes: Record<string, SecurityScheme> = {}
  if (isObj(card.securitySchemes)) for (const [k, v] of Object.entries(card.securitySchemes)) securitySchemes[k] = normalizeScheme(v)
  return {
    name: str(card.name) ?? "a2a agent",
    description: str(card.description),
    version: str(card.version),
    streaming: caps.streaming === true,
    pushNotifications: caps.pushNotifications === true,
    extendedCard: caps.extendedAgentCard === true || card.supportsAuthenticatedExtendedCard === true,
    endpoint,
    interfaces,
    bearer: Object.values(securitySchemes).some((s) => s.type === "http" && /bearer/i.test(s.scheme)),
    securitySchemes,
    securityRequirements: readRequirements(card),
    signed: Array.isArray(card.signatures) && card.signatures.length > 0,
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

export * from "./sign.ts"
