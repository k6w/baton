/** Installation / auth detection and model discovery for the Codex CLI. */
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { DetectResult } from "@batonsh/protocol"
import { parseVersion, runCapture, which } from "@batonsh/protocol"

export function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex")
}

export async function detectCodex(opts?: { command?: string }): Promise<DetectResult> {
  const protocols = ["app-server", "exec-json"]
  const bin = which(opts?.command ?? "codex")
  if (!bin) return { installed: false, auth: "unknown", authHint: "install the Codex CLI", protocols }

  const notes: string[] = []
  let version: string | undefined
  try {
    const v = await runCapture([bin, "--version"], { timeoutMs: 10_000 })
    version = parseVersion(v.stdout || v.stderr)
  } catch (e) {
    notes.push(`codex --version failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // `codex login status` exits 0 when logged in ("Logged in using ChatGPT" / API key), 1 otherwise.
  let auth: DetectResult["auth"] = "unknown"
  try {
    const s = await runCapture([bin, "login", "status"], { timeoutMs: 10_000 })
    const out = `${s.stdout}\n${s.stderr}`
    if (s.code === 0 && /logged in/i.test(out)) auth = "ok"
    else if (/not logged in/i.test(out)) auth = "missing"
  } catch {}
  if (auth === "unknown") {
    if (existsSync(join(codexHome(), "auth.json")) || process.env.OPENAI_API_KEY) auth = "ok"
  }

  return {
    installed: true,
    version,
    path: bin,
    auth,
    authHint: auth === "ok" ? undefined : "run `codex login`",
    protocols,
    ...(notes.length ? { notes } : {}),
  }
}

/** Models codex itself advertises (from its cached catalog); empty when unknown. */
export function codexModels(): string[] {
  try {
    const raw = JSON.parse(readFileSync(join(codexHome(), "models_cache.json"), "utf8")) as {
      models?: { slug?: string; visibility?: string }[]
    }
    return (raw.models ?? []).filter((m) => m.slug && m.visibility !== "hide").map((m) => m.slug as string)
  } catch {
    return []
  }
}
