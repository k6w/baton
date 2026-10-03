/**
 * Agent-card signatures (A2A v1.0 §8.4): a JWS (RFC 7515) over the RFC 8785 (JCS) canonical
 * JSON of the card without its `signatures` field, carried as
 * `AgentCardSignature { protected, signature, header? }` (detached-payload JSON serialization).
 *
 * Signing uses Ed25519 (`alg: "EdDSA"`); verification also accepts ES256/384/512, RS256/384/512
 * and PS256/384/512. node:crypto only.
 */
import { constants, createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject, type webcrypto } from "node:crypto"

export interface AgentCardSignature {
  protected: string
  signature: string
  header?: Record<string, unknown>
}

export type Jwk = webcrypto.JsonWebKey & { kid?: string; alg?: string; use?: string }
export interface Jwks {
  keys: Jwk[]
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)

/** RFC 8785 JSON Canonicalization Scheme. Keys sorted by UTF-16 code units; ES number/string serialization. */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("JCS: non-finite number")
    if (v === undefined || typeof v === "function" || typeof v === "symbol") throw new Error("JCS: unsupported value")
    return JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalize(x))).join(",")}]`
  const o = v as Obj
  const keys = Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`
}

export const b64u = (b: Uint8Array | string): string => Buffer.from(b).toString("base64url")

/** The signed payload: the card minus `signatures`, canonicalized. */
export function cardPayload(card: Obj): string {
  const { signatures: _drop, ...rest } = card
  return canonicalize(rest)
}

/**
 * The same, after dropping proto3 "default" values (empty strings / arrays / objects, nulls) —
 * what §8.4.1 asks signers to do. Verifiers try both forms, since producers differ.
 */
export function cardPayloadStripped(card: Obj): string {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip)
    if (!isObj(v)) return v
    const out: Obj = {}
    for (const [k, x] of Object.entries(v)) {
      const y = strip(x)
      if (y === null || y === undefined || y === "" || (Array.isArray(y) && y.length === 0) || (isObj(y) && Object.keys(y).length === 0)) continue
      out[k] = y
    }
    return out
  }
  const { signatures: _drop, ...rest } = card
  return canonicalize(strip(rest))
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url) — a stable key id. */
export function jwkThumbprint(jwk: Jwk): string {
  const req: Record<string, string[]> = { OKP: ["crv", "kty", "x"], EC: ["crv", "kty", "x", "y"], RSA: ["e", "kty", "n"] }
  const fields = req[String(jwk.kty)] ?? ["kty"]
  const o: Obj = {}
  for (const f of fields) o[f] = (jwk as Obj)[f]
  return b64u(createHash("sha256").update(canonicalize(o)).digest())
}

/** Public JWK (with kid / alg / use) for an Ed25519 private or public key. */
export function publicJwk(key: KeyObject): Jwk {
  const pub = key.type === "private" ? createPublicKey(key) : key
  const jwk = pub.export({ format: "jwk" }) as Jwk
  return { ...jwk, kid: jwkThumbprint(jwk), alg: "EdDSA", use: "sig" }
}

/** Sign a card (Ed25519). Returns a copy with `signatures: [ … ]` (replacing any existing ones). */
export function signCard<T extends Obj>(card: T, privateKey: KeyObject, opts: { kid?: string; jku?: string } = {}): T & { signatures: AgentCardSignature[] } {
  const kid = opts.kid ?? publicJwk(privateKey).kid
  const header = { alg: "EdDSA", typ: "JOSE", kid, ...(opts.jku ? { jku: opts.jku } : {}) }
  const protectedB64 = b64u(JSON.stringify(header))
  const input = `${protectedB64}.${b64u(cardPayload(card))}`
  const signature = b64u(cryptoSign(null, Buffer.from(input), privateKey))
  const { signatures: _drop, ...rest } = card
  return { ...(rest as T), signatures: [{ protected: protectedB64, signature }] }
}

const HASH: Record<string, string> = { "256": "sha256", "384": "sha384", "512": "sha512" }

function verifyOne(alg: string, key: KeyObject, data: Buffer, sig: Buffer): boolean {
  if (alg === "EdDSA" || alg === "Ed25519") return cryptoVerify(null, data, key, sig)
  const m = /^(ES|RS|PS)(256|384|512)$/.exec(alg)
  if (!m) throw new Error(`unsupported alg ${alg}`)
  const hash = HASH[m[2] as string] as string
  if (m[1] === "ES") return cryptoVerify(hash, data, { key, dsaEncoding: "ieee-p1363" }, sig)
  if (m[1] === "RS") return cryptoVerify(hash, data, key, sig)
  return cryptoVerify(hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, sig)
}

export interface VerifyResult {
  status: "valid" | "invalid" | "unsigned"
  kid?: string
  reason?: string
}

export interface VerifyOptions {
  /** Trusted keys (pinning). When set, `jku` headers are ignored. */
  jwks?: Jwks
  /** Fetch a JWKS by URL (for `jku`). */
  fetchJwks?: (url: string) => Promise<unknown>
  /** Base for relative `jku` URLs. */
  cardUrl?: string
}

/** Verify a card's signatures: valid when at least one verifies against a known key. */
export async function verifyCard(card: unknown, opts: VerifyOptions = {}): Promise<VerifyResult> {
  if (!isObj(card) || !Array.isArray(card.signatures) || card.signatures.length === 0) return { status: "unsigned" }
  const payloads = [...new Set([cardPayload(card), cardPayloadStripped(card)])]
  const reasons: string[] = []
  const jwksCache = new Map<string, Jwk[]>()
  for (const s of card.signatures) {
    try {
      if (!isObj(s) || typeof s.protected !== "string" || typeof s.signature !== "string") throw new Error("malformed signature entry")
      const header = JSON.parse(Buffer.from(s.protected, "base64url").toString("utf8")) as Obj
      const alg = String(header.alg ?? "")
      const kid = typeof header.kid === "string" ? header.kid : undefined
      if (!alg || alg === "none") throw new Error("missing alg")
      let keys: Jwk[]
      if (opts.jwks) keys = opts.jwks.keys
      else if (typeof header.jku === "string") {
        const url = new URL(header.jku, opts.cardUrl).toString()
        if (!jwksCache.has(url)) {
          if (!opts.fetchJwks) throw new Error("no way to fetch jku")
          const j = await opts.fetchJwks(url)
          jwksCache.set(url, isObj(j) && Array.isArray(j.keys) ? (j.keys as Jwk[]) : [])
        }
        keys = jwksCache.get(url) ?? []
      } else throw new Error("no jku and no trusted keys")
      const candidates = keys.filter((k) => !kid || k.kid === kid)
      if (!candidates.length) throw new Error(`no key for kid ${kid ?? "(none)"}`)
      const sig = Buffer.from(s.signature, "base64url")
      for (const jwk of candidates) {
        const key = createPublicKey({ key: jwk as never, format: "jwk" })
        for (const p of payloads) if (verifyOne(alg, key, Buffer.from(`${s.protected}.${b64u(p)}`), sig)) return { status: "valid", kid }
      }
      throw new Error(`signature does not match (kid ${kid ?? "?"})`)
    } catch (e) {
      reasons.push(e instanceof Error ? e.message : String(e))
    }
  }
  return { status: "invalid", reason: reasons.join("; ") }
}
