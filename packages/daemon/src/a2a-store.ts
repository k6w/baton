/**
 * Persistence for the A2A server: tasks (status, history, artifacts, contextId, push configs)
 * in `stateDir()/a2a/tasks-<projecthash>.json` (0600, atomic writes, debounced), and the
 * per-project Ed25519 card-signing key in `stateDir()/a2a/<projecthash>.ed25519.pem` (0600).
 */
import { createHash, createPrivateKey, generateKeyPairSync, type KeyObject } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { Task } from "@batonsh/adapter-a2a/wire"
import { stateDir } from "@batonsh/kernel"
import type { PushTarget } from "./a2a-push.ts"

export function projectHash(projectRoot: string): string {
  return createHash("sha1").update(projectRoot).digest("hex").slice(0, 16)
}

export function a2aDir(): string {
  return join(stateDir(), "a2a")
}

export function tasksFile(projectRoot: string): string {
  return join(a2aDir(), `tasks-${projectHash(projectRoot)}.json`)
}

export interface StoredTask {
  task: Task
  push?: PushTarget[]
  /** Why an input-required task waits: the lead asked a question, or an approval is pending. */
  waiting?: "question" | "approval"
}

interface FileShape {
  version: 1
  savedAt: string
  tasks: StoredTask[]
}

function writePrivate(file: string, data: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {}
}

export function loadTasks(file: string): StoredTask[] {
  try {
    if (!existsSync(file)) return []
    const j = JSON.parse(readFileSync(file, "utf8")) as Partial<FileShape>
    return Array.isArray(j.tasks) ? j.tasks.filter((t) => t && typeof t.task?.id === "string" && typeof t.task.contextId === "string") : []
  } catch {
    return []
  }
}

/** Debounced writer: `schedule()` after every change, `flush()` on shutdown. */
export class TaskStore {
  private timer: ReturnType<typeof setTimeout> | undefined
  private dirty = false

  constructor(
    readonly file: string,
    private snapshot: () => StoredTask[],
    private debounceMs = 250,
    private onError: (e: unknown) => void = () => {},
  ) {}

  schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.debounceMs)
    this.timer.unref?.()
  }

  flush(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    if (!this.dirty) return
    this.dirty = false
    try {
      const data: FileShape = { version: 1, savedAt: new Date().toISOString(), tasks: this.snapshot() }
      writePrivate(this.file, JSON.stringify(data))
    } catch (e) {
      this.onError(e)
    }
  }
}

/** The project's card-signing key: generated once, kept in the state dir (0600). */
export function a2aSigningKey(projectRoot: string): KeyObject {
  const file = join(a2aDir(), `${projectHash(projectRoot)}.ed25519.pem`)
  if (existsSync(file)) {
    try {
      return createPrivateKey(readFileSync(file, "utf8"))
    } catch {}
  }
  const { privateKey } = generateKeyPairSync("ed25519")
  writePrivate(file, privateKey.export({ format: "pem", type: "pkcs8" }) as string)
  return privateKey
}
