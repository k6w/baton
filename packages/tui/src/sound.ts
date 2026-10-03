/**
 * Notification sounds: your own file per kind (notify.sounds), or the system's sounds
 * (macOS afplay, Linux paplay / pw-play with the freedesktop theme), else the terminal bell.
 * Never blocks, never overlaps (at most one sound every 1.5s).
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import type { BatonConfig } from "@batonsh/kernel"

const MAC: Record<string, string> = { approval: "Ping", done: "Glass", error: "Basso", merge: "Hero" }
const FREEDESKTOP: Record<string, string> = { approval: "message-new-instant", done: "complete", error: "dialog-error", merge: "complete" }

let last = 0

function player(): ((file: string) => string[]) | undefined {
  if (process.platform === "darwin" && Bun.which("afplay")) return (f) => ["afplay", f]
  for (const bin of ["pw-play", "paplay", "aplay"]) if (Bun.which(bin)) return (f) => [bin, f]
  return undefined
}

/** The file that would play for this kind (undefined → bell). */
export function soundFile(kind: string, cfg: BatonConfig["notify"]): string | undefined {
  const custom = cfg.sounds[kind]
  if (custom) {
    const p = custom.replace(/^~(?=\/)/, homedir())
    return existsSync(p) ? p : undefined
  }
  if (cfg.sound !== "system") return undefined
  if (process.platform === "darwin") {
    const p = `/System/Library/Sounds/${MAC[kind] ?? "Pop"}.aiff`
    return existsSync(p) ? p : undefined
  }
  for (const ext of ["oga", "ogg", "wav"]) {
    const p = `/usr/share/sounds/freedesktop/stereo/${FREEDESKTOP[kind] ?? "complete"}.${ext}`
    if (existsSync(p)) return p
  }
  return undefined
}

export function playSound(kind: string, cfg: BatonConfig["notify"]): void {
  const now = Date.now()
  if (now - last < 1500) return
  last = now
  const file = soundFile(kind, cfg)
  const play = player()
  if (!file || !play) {
    process.stdout.write("\x07")
    return
  }
  try {
    Bun.spawn(play(file), { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref()
  } catch {
    process.stdout.write("\x07")
  }
}
