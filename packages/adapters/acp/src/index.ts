/**
 * @batonsh/adapter-acp — generic Agent Client Protocol adapter.
 *
 * One implementation drives every ACP stdio agent (Gemini CLI, Cursor, Copilot, Goose,
 * OpenCode, Claude/Codex ACP bridges, …); presets only differ in command line and hints.
 */
import type { AgentAdapter } from "@batonsh/protocol"
import { createAcpAdapter } from "./adapter.ts"
import { ACP_PRESETS, GENERIC_ACP_PRESET } from "./presets.ts"

export { createAcpAdapter } from "./adapter.ts"
export type { AcpAuthCheck, AcpAuthStatus, AcpPreset } from "./presets.ts"
export { ACP_PRESETS, GENERIC_ACP_PRESET, runAuthCheck } from "./presets.ts"
export type { RegistryAgent } from "./registry.ts"
export { ACP_REGISTRY_URL, fetchAcpRegistry, registryAgentToPreset } from "./registry.ts"
export { AcpSession } from "./session.ts"
export { TerminalManager } from "./terminal.ts"
export { WorkspaceFs } from "./workspace-fs.ts"

/** Generic adapter (id "acp"): command/args come from SessionConfig — for custom agents. */
export const acpAdapter: AgentAdapter = createAcpAdapter(GENERIC_ACP_PRESET)

/** One adapter per preset, plus the generic one. */
export const acpAdapters: AgentAdapter[] = [...ACP_PRESETS.map(createAcpAdapter), acpAdapter]

export default createAcpAdapter
