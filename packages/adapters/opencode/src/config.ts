/**
 * SessionConfig → OpenCode config, injected via OPENCODE_CONFIG_CONTENT (merged by OpenCode on
 * top of the user's global/project config).
 */
import type { ApprovalMode, SessionConfig } from "@batonsh/protocol"
import type { Config as OcConfig, PermissionConfig, ProviderConfig } from "@opencode-ai/sdk/v2"

export function permissionFor(approval: ApprovalMode): PermissionConfig {
  // `question` would block on a TUI-only prompt; baton has no channel for it, so remove the tool.
  switch (approval) {
    case "yolo":
      return {
        edit: "allow",
        bash: "allow",
        webfetch: "allow",
        websearch: "allow",
        external_directory: "allow",
        doom_loop: "allow",
        question: "deny",
      }
    case "auto":
      return { edit: "allow", bash: "allow", webfetch: "ask", question: "deny" }
    case "auto-edit":
      return { edit: "allow", bash: "ask", webfetch: "ask", question: "deny" }
    default:
      return { edit: "ask", bash: "ask", webfetch: "ask", question: "deny" }
  }
}

/** "provider/model" → {providerID, modelID}. A bare model id uses the injected provider, if any. */
export function splitModel(model: string | undefined, providerId?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined
  const slash = model.indexOf("/")
  if (slash > 0) return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
  return providerId ? { providerID: providerId, modelID: model } : undefined
}

export function buildConfig(cfg: SessionConfig): OcConfig {
  const config: OcConfig = {
    autoupdate: false,
    share: "disabled",
    permission: permissionFor(cfg.approval),
  }

  if (cfg.mcpServers.length) {
    config.mcp = {}
    for (const s of cfg.mcpServers) {
      config.mcp[s.name] = { type: "remote", url: s.url, enabled: true, ...(s.headers ? { headers: s.headers } : {}), oauth: false }
    }
  }

  const p = cfg.provider
  if (p) {
    const model = splitModel(cfg.model, p.id)
    const options: NonNullable<ProviderConfig["options"]> = {}
    if (p.baseUrl) options.baseURL = p.baseUrl
    if (p.apiKey) options.apiKey = p.apiKey
    if (p.headers) options.headers = p.headers
    const provider: ProviderConfig = { options }
    if (p.kind === "openai-compatible" || p.kind === "ollama" || p.kind === "lmstudio") {
      provider.npm = "@ai-sdk/openai-compatible"
      provider.name = p.id
      if (model && model.providerID === p.id) provider.models = { [model.modelID]: { name: model.modelID } }
    }
    config.provider = { [p.id]: provider }
  }

  const m = splitModel(cfg.model, p?.id)
  if (m) config.model = `${m.providerID}/${m.modelID}`
  return config
}
