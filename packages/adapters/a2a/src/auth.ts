/**
 * Client authentication from the agent card's `securitySchemes` / security requirements:
 * HTTP bearer / basic, API keys (header, query or cookie), OAuth 2.0 client credentials
 * (token URL from the card, the server's RFC 8414 metadata, or options) and OpenID Connect
 * (token endpoint discovered from `openIdConnectUrl`, then client credentials). Access tokens
 * are cached until shortly before they expire and refreshed after a 401.
 */
import type { SecurityRequirement, SecurityScheme } from "./wire.ts"

export interface AuthOptions {
  /** Bearer token (HTTP bearer schemes; also the API key when no `apiKey` is given). */
  token?: string
  apiKey?: string
  /** `user:password` for HTTP basic schemes. */
  basic?: string
  clientId?: string
  clientSecret?: string
  /** Overrides the card's token URL (OAuth2) / discovery (OIDC). */
  tokenUrl?: string
  /** Overrides the card's OpenID Connect discovery URL. */
  oidcUrl?: string
  scopes?: string[]
  audience?: string
  /** How to send client credentials: HTTP basic (default, `client_secret_basic`) or in the form body. */
  clientAuth?: "basic" | "post"
  /** Use this scheme (by name in the card) instead of picking one. */
  scheme?: string
}

type Log = (level: "debug" | "info" | "warn" | "error", message: string) => void

interface Cached {
  token: string
  exp: number
}

const MARGIN_MS = 30_000

export class Auth {
  /** The requirement in use: scheme name → scopes. Empty when nothing applies (static headers / token only). */
  readonly chosen: [string, SecurityScheme, string[]][] = []
  private cache = new Map<string, Cached>()
  private inflight = new Map<string, Promise<Cached>>()
  private discovered = new Map<string, string>()

  constructor(
    schemes: Record<string, SecurityScheme>,
    requirements: SecurityRequirement[],
    private opts: AuthOptions,
    private log: Log = () => {},
    private fetchImpl: typeof fetch = fetch,
  ) {
    const reqs: SecurityRequirement[] = opts.scheme
      ? [{ [opts.scheme]: [] }]
      : requirements.length
        ? requirements
        : Object.keys(schemes).map((k) => ({ [k]: [] }))
    for (const r of reqs) {
      const entries = Object.entries(r)
      if (entries.every(([name]) => schemes[name] && this.can(schemes[name] as SecurityScheme))) {
        for (const [name, scopes] of entries) this.chosen.push([name, schemes[name] as SecurityScheme, scopes])
        break
      }
    }
    if (!this.chosen.length && reqs.length && Object.keys(schemes).length) {
      const names = Object.entries(schemes)
        .map(([k, s]) => `${k} (${s.type})`)
        .join(", ")
      if (!opts.token) log("warn", `a2a: the agent card asks for authentication (${names}) but no matching credentials are configured`)
    }
  }

  private can(s: SecurityScheme): boolean {
    const o = this.opts
    switch (s.type) {
      case "http":
        return /^basic$/i.test(s.scheme) ? !!o.basic : !!o.token
      case "apiKey":
        return !!(o.apiKey ?? o.token)
      case "oauth2":
        return !!(o.clientId && o.clientSecret && (o.tokenUrl || s.tokenUrl || s.metadataUrl))
      case "openIdConnect":
        return !!(o.clientId && o.clientSecret && (o.tokenUrl || o.oidcUrl || s.url))
      default:
        return false
    }
  }

  /** Human-readable summary for logs. */
  describe(): string {
    if (!this.chosen.length) return this.opts.token ? "bearer token" : "none"
    return this.chosen.map(([n, s]) => `${n} (${s.type})`).join(" + ")
  }

  /** Whether a 401 can be fixed by fetching a new token. */
  get refreshable(): boolean {
    return this.chosen.some(([, s]) => s.type === "oauth2" || s.type === "openIdConnect")
  }

  /** Add credentials to a request. Explicit `Authorization` headers (from options.headers) win. */
  async apply(url: URL, headers: Record<string, string>, signal?: AbortSignal): Promise<void> {
    const has = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase())
    const setAuth = (v: string) => {
      if (!has("authorization")) headers.Authorization = v
    }
    if (!this.chosen.length) {
      if (this.opts.token) setAuth(`Bearer ${this.opts.token}`)
      return
    }
    for (const [name, s, scopes] of this.chosen) {
      switch (s.type) {
        case "http":
          if (/^basic$/i.test(s.scheme)) setAuth(`Basic ${Buffer.from(this.opts.basic ?? "").toString("base64")}`)
          else setAuth(`${/^bearer$/i.test(s.scheme) ? "Bearer" : s.scheme} ${this.opts.token}`)
          break
        case "apiKey": {
          const key = (this.opts.apiKey ?? this.opts.token) as string
          if (s.location === "query") url.searchParams.set(s.name, key)
          else if (s.location === "cookie") {
            const k = Object.keys(headers).find((h) => h.toLowerCase() === "cookie")
            const pair = `${s.name}=${encodeURIComponent(key)}`
            if (k) headers[k] = `${headers[k]}; ${pair}`
            else headers.Cookie = pair
          } else if (!has(s.name)) headers[s.name] = key
          break
        }
        case "oauth2":
        case "openIdConnect":
          setAuth(`Bearer ${(await this.accessToken(name, s, scopes, signal)).token}`)
          break
      }
    }
  }

  /** After a 401: drop cached tokens. True when retrying can help. */
  invalidate(): boolean {
    if (!this.refreshable) return false
    this.cache.clear()
    return true
  }

  private async accessToken(name: string, s: SecurityScheme, scopes: string[], signal?: AbortSignal): Promise<Cached> {
    const hit = this.cache.get(name)
    if (hit && hit.exp > Date.now()) return hit
    let p = this.inflight.get(name)
    if (!p) {
      p = this.fetchToken(s, scopes, signal).finally(() => this.inflight.delete(name))
      this.inflight.set(name, p)
    }
    const got = await p
    this.cache.set(name, got)
    return got
  }

  private async tokenEndpoint(s: SecurityScheme, signal?: AbortSignal): Promise<string> {
    if (this.opts.tokenUrl) return this.opts.tokenUrl
    if (s.type === "oauth2" && s.tokenUrl) return s.tokenUrl
    const discovery = s.type === "oauth2" ? s.metadataUrl : s.type === "openIdConnect" ? (this.opts.oidcUrl ?? s.url) : undefined
    if (!discovery) throw new Error("no token endpoint (set options.tokenUrl)")
    const cached = this.discovered.get(discovery)
    if (cached) return cached
    const res = await this.fetchImpl(discovery, { headers: { accept: "application/json" }, signal })
    if (!res.ok) throw new Error(`discovery ${discovery}: HTTP ${res.status}`)
    const doc = (await res.json()) as { token_endpoint?: unknown }
    if (typeof doc.token_endpoint !== "string") throw new Error(`discovery ${discovery}: no token_endpoint`)
    this.discovered.set(discovery, doc.token_endpoint)
    return doc.token_endpoint
  }

  private async fetchToken(s: SecurityScheme, scopes: string[], signal?: AbortSignal): Promise<Cached> {
    const url = await this.tokenEndpoint(s, signal)
    const o = this.opts
    const body = new URLSearchParams({ grant_type: "client_credentials" })
    const scope = (scopes.length ? scopes : (o.scopes ?? [])).join(" ")
    if (scope) body.set("scope", scope)
    if (o.audience) body.set("audience", o.audience)
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }
    if (o.clientAuth === "post") {
      body.set("client_id", o.clientId ?? "")
      body.set("client_secret", o.clientSecret ?? "")
    } else {
      const enc = (v: string) => encodeURIComponent(v).replace(/%20/g, "+")
      headers.Authorization = `Basic ${Buffer.from(`${enc(o.clientId ?? "")}:${enc(o.clientSecret ?? "")}`).toString("base64")}`
    }
    const res = await this.fetchImpl(url, { method: "POST", headers, body, signal })
    const text = await res.text()
    let json: { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } = {}
    try {
      json = JSON.parse(text)
    } catch {}
    if (!res.ok || typeof json.access_token !== "string")
      throw new Error(
        `token request to ${url} failed: HTTP ${res.status}${json.error ? ` ${json.error}${json.error_description ? ` (${json.error_description})` : ""}` : ""}`,
      )
    const ttl = typeof json.expires_in === "number" ? json.expires_in * 1000 : Number(json.expires_in) * 1000 || 300_000
    this.log("debug", `a2a: got an access token from ${url} (expires in ${Math.round(ttl / 1000)}s)`)
    return { token: json.access_token, exp: Date.now() + Math.max(0, ttl - Math.min(MARGIN_MS, ttl / 2)) }
  }
}

/** Resolve `env:NAME` references (options values that point at environment variables). */
export function resolveRef(v: unknown, env: Record<string, string | undefined> = process.env): string | undefined {
  if (typeof v !== "string" || !v) return undefined
  const m = /^env:([A-Za-z_][A-Za-z0-9_]*)$/.exec(v)
  return m ? env[m[1] as string] || undefined : v
}
