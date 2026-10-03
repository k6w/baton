/**
 * Persistent conversations: <stateDir>/native-sessions/<sessionId>.json (0600, written atomically),
 * so `resumeId` works across daemon restarts. Only the conversation, the model and the provider
 * id are stored — never API keys, headers or base URLs with credentials.
 * Sessions not updated for 30 days are pruned.
 */
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { stateDir } from "@batonsh/kernel"
import type { ModelMessage } from "ai"
import { writeFileAtomic } from "./catalogue.ts"

export interface StoredSession {
  version: 1
  id: string
  createdAt: string
  updatedAt: string
  cwd?: string
  providerId?: string
  kind?: string
  model?: string
  /** Session this one was forked from. */
  forkedFrom?: string
  messages: ModelMessage[]
}

export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const VALID_ID = /^[A-Za-z0-9_.-]{1,128}$/

export function sessionsDir(): string {
  return join(stateDir(), "native-sessions")
}

function fileFor(dir: string, id: string): string {
  if (!VALID_ID.test(id) || id.startsWith(".")) throw new Error(`invalid session id "${id}"`)
  return join(dir, `${id}.json`)
}

export function saveSession(s: StoredSession, dir = sessionsDir()): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileAtomic(fileFor(dir, s.id), JSON.stringify(s), 0o600)
}

export function loadSession(id: string, dir = sessionsDir()): StoredSession | undefined {
  try {
    const s = JSON.parse(readFileSync(fileFor(dir, id), "utf8")) as StoredSession
    if (s?.version !== 1 || !Array.isArray(s.messages)) return undefined
    return s
  } catch {
    return undefined
  }
}

/** Delete sessions older than `maxAgeMs` (by file mtime). Returns how many were removed. */
export function pruneSessions(dir = sessionsDir(), maxAgeMs = SESSION_MAX_AGE_MS, now = Date.now()): number {
  let removed = 0
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const n of names) {
    if (!n.endsWith(".json") && !n.endsWith(".tmp")) continue
    const p = join(dir, n)
    try {
      if (now - statSync(p).mtimeMs > maxAgeMs) {
        unlinkSync(p)
        removed++
      }
    } catch {}
  }
  return removed
}

let lastPrune = 0
/** Prune at most once a day per process. */
export function maybePrune(dir = sessionsDir()): void {
  const now = Date.now()
  if (now - lastPrune < 24 * 60 * 60 * 1000) return
  lastPrune = now
  pruneSessions(dir, SESSION_MAX_AGE_MS, now)
}
