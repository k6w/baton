import type { AdapterCapabilities, DetectResult, SessionConfig } from "../../../protocol/src/index.ts"
import type { Dialect } from "./dialect.ts"

export interface LaunchContext {
  /** Resolved executable. */
  binary: string
  /** Native session id to resume (cfg.resumeId on first launch, the live session id on respawn). */
  resumeId?: string
}

export interface UserMessageOptions {
  /** Inject into the running turn (Amp `steer: true`). */
  steer: boolean
  uuid: string
  /** Native session id, once known. */
  sessionId?: string
}

export interface AuthResult {
  auth: DetectResult["auth"]
  authHint?: string
  notes?: string[]
}

/**
 * Everything that differs between stream-json CLIs. The session runtime (spawn, NDJSON I/O,
 * control protocol, turn tracking) is shared.
 */
export interface StreamJsonPreset {
  id: string
  displayName: string
  /** Executable names looked up with which() (absolute paths allowed). */
  binaries: string[]
  /** Arguments placed before buildArgs() output (e.g. a script path when the binary is an interpreter). */
  prefixArgs?: string[]
  dialect: Dialect
  /** CLI flags for one long-lived streaming session (cfg.args is appended by the runtime). */
  buildArgs(cfg: SessionConfig, launch: LaunchContext): string[]
  /** Environment for the child (PATH is always augmented; cfg.env is applied last). */
  buildEnv?(cfg: SessionConfig): Record<string, string | undefined>
  /** One NDJSON line (as an object) carrying a user message on stdin. */
  encodeUser(text: string, opts: UserMessageOptions): Record<string, unknown>
  /**
   * "native": the CLI folds a message sent mid-turn into the running turn.
   * "none": no steering (capabilities.steer must be false).
   */
  steer: "native" | "none"
  /**
   * "cli": messages are written immediately; the CLI queues them and reports consumption
   * (Claude's user_message_uuids). "host": baton holds queued prompts and writes each one when
   * its turn starts (needed when an interrupt may kill the process and lose the CLI's queue).
   */
  queue: "cli" | "host"
  /** "control": `control_request {subtype:"interrupt"}` on stdin. "signal": SIGINT (respawn + resume if the CLI exits). */
  interrupt: "control" | "signal"
  /** Speaks the Claude-style control protocol (control_request/control_response on stdin/stdout). */
  control: boolean
  /** Payload merged into the `initialize` control request sent at startup (control presets only). */
  initialize?(cfg: SessionConfig): Record<string, unknown>
  /** How SessionConfig.systemPrompt reaches the agent: CLI flags, or prepended to the first prompt. */
  systemPrompt: "args" | "first-message"
  capabilities: AdapterCapabilities
  /** Arguments that print the version (default ["--version"]). */
  versionArgs?: string[]
  detectAuth?(path: string): Promise<AuthResult>
  installHint: string
  protocols: string[]
}
