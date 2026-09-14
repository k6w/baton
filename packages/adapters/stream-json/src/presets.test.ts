import { describe, expect, test } from "bun:test"
import type { SessionConfig } from "../../../protocol/src/index.ts"
import { contractSuite } from "../../testkit/src/index.ts"
import { ampAdapter, ampPreset, claudeCliAdapter, claudeCliPreset, normalizeMessage, qwenStreamAdapter, qwenStreamPreset, streamJsonAdapters } from "./index.ts"

const cfg = (over: Partial<SessionConfig> = {}): SessionConfig => ({ agentId: "a", name: "a", cwd: "/w", mcpServers: [], approval: "ask", ...over })

describe("presets: command lines", () => {
  test("claude-cli", () => {
    expect(claudeCliPreset.buildArgs(cfg(), { binary: "claude" })).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool",
      "stdio",
      "--permission-mode",
      "default",
    ])
    const yolo = claudeCliPreset.buildArgs(cfg({ approval: "yolo", resumeId: "s1", options: { effort: "high", forkSession: true } }), {
      binary: "claude",
      resumeId: "s1",
    })
    expect(yolo.join(" ")).toContain("--permission-mode bypassPermissions --allow-dangerously-skip-permissions")
    expect(yolo.join(" ")).toContain("--resume s1 --effort high --fork-session")
    // A respawn resume (live session id) never forks.
    expect(claudeCliPreset.buildArgs(cfg({ resumeId: "s1", options: { forkSession: true } }), { binary: "claude", resumeId: "s2" })).not.toContain(
      "--fork-session",
    )
    expect(claudeCliPreset.buildArgs(cfg({ approval: "auto" }), { binary: "claude" })).toContain("auto")
  })

  test("amp", () => {
    expect(ampPreset.buildArgs(cfg(), { binary: "amp" })).toEqual(["--execute", "--stream-json", "--stream-json-input"])
    expect(ampPreset.buildArgs(cfg({ approval: "yolo", model: "rush" }), { binary: "amp", resumeId: "T-1" })).toEqual([
      "threads",
      "continue",
      "T-1",
      "--execute",
      "--stream-json",
      "--stream-json-input",
      "--dangerously-allow-all",
      "--mode",
      "rush",
    ])
    expect(ampPreset.encodeUser("hi", { steer: true, uuid: "u" })).toEqual({
      type: "user",
      steer: true,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    })
  })

  test("qwen-stream", () => {
    expect(qwenStreamPreset.buildArgs(cfg({ approval: "auto-edit", model: "qwen3-coder-plus", systemPrompt: "x" }), { binary: "qwen", resumeId: "r" })).toEqual(
      [
        "--output-format",
        "stream-json",
        "--input-format",
        "stream-json",
        "--include-partial-messages",
        "--approval-mode",
        "auto-edit",
        "--model",
        "qwen3-coder-plus",
        "--append-system-prompt",
        "x",
        "--resume",
        "r",
      ],
    )
    expect(qwenStreamPreset.initialize?.(cfg({ mcpServers: [{ name: "b", url: "http://x/mcp", headers: { a: "1" } }] }))).toEqual({
      hooks: null,
      mcpServers: { b: { httpUrl: "http://x/mcp", headers: { a: "1" }, trust: true } },
    })
  })
})

describe("dialect normalization", () => {
  test("qwen session_start → init, tool names → Claude", () => {
    const sys = normalizeMessage("qwen", { type: "system", subtype: "session_start", session_id: "s", qwen_code_version: "1.0.0" })
    expect(sys).toMatchObject({ subtype: "init", claude_code_version: "1.0.0" })
    const seen: string[] = []
    const a = normalizeMessage(
      "qwen",
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "run_shell_command", input: { command: "ls" } }] } },
      { onToolUse: (_id, n, m) => seen.push(`${n.name}->${m.name}`) },
    )
    expect((a.message as any).content[0].name).toBe("Bash")
    expect(seen).toEqual(["run_shell_command->Bash"])
  })

  test("amp tool inputs are mapped", () => {
    const a = normalizeMessage("amp", { type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: { cmd: "ls" } }] } })
    expect((a.message as any).content[0].input).toEqual({ cmd: "ls", command: "ls" })
  })
})

describe("adapters", () => {
  test("registry + capabilities", () => {
    expect(streamJsonAdapters.map((a) => a.id)).toEqual(["claude-cli", "amp", "qwen-stream"])
    for (const a of streamJsonAdapters) expect(a.family).toBe("stream-json")
    expect(claudeCliAdapter.capabilities()).toMatchObject({ steer: true, permissions: true, cost: true })
    expect(ampAdapter.capabilities()).toMatchObject({ steer: true, permissions: false })
    expect(qwenStreamAdapter.capabilities()).toMatchObject({ steer: false, permissions: true })
  })
})

describe("claude-cli contract", () => {
  contractSuite(claudeCliAdapter, { test, expect }, { model: "haiku" })
})
describe("amp contract", () => {
  contractSuite(ampAdapter, { test, expect })
})
describe("qwen-stream contract", () => {
  contractSuite(qwenStreamAdapter, { test, expect })
})
