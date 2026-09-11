import { describe, expect, test } from "bun:test"
import { buildEnv, buildMcpServers, permissionModeFor } from "./options.ts"
import { editDiff, patchToLines, toolKind, toolSummary, toolTitle } from "./tools.ts"

describe("tools", () => {
  test("kinds", () => {
    expect(
      ["Read", "Glob", "Grep", "Edit", "MultiEdit", "NotebookEdit", "Write", "Bash", "WebFetch", "WebSearch", "Task", "Agent", "mcp__x__y"].map(toolKind),
    ).toEqual(["read", "search", "search", "edit", "edit", "edit", "edit", "execute", "fetch", "fetch", "delegate", "delegate", "other"])
  })

  test("titles use cwd-relative paths and keep outside paths absolute", () => {
    expect(toolTitle("Read", { file_path: "/w/src/app.ts" }, "/w")).toBe("Read(src/app.ts)")
    expect(toolTitle("Edit", { file_path: "/etc/hosts" }, "/w")).toBe("Update(/etc/hosts)")
    expect(toolTitle("Bash", { command: "make lint\necho done" }, "/w")).toBe("Bash(make lint)")
    expect(toolTitle("Grep", { pattern: "TODO", path: "/w/src" }, "/w")).toBe("Grep(TODO in src)")
    expect(toolTitle("WebFetch", { url: "https://x.dev" }, "/w")).toBe("Fetch(https://x.dev)")
  })

  test("Edit fallback (no structured result) locates the edit in the snapshot for line numbers", () => {
    const before = "a\nb\nc\nold\ne\n"
    const d = editDiff({ name: "Edit", input: { file_path: "/w/f", old_string: "old", new_string: "new\nnew2" }, content: "ok", isError: false, before })
    expect(d?.lines?.filter((l) => l.kind !== "ctx")).toEqual([
      { kind: "del", text: "old", oldLine: 4 },
      { kind: "add", text: "new", newLine: 4 },
      { kind: "add", text: "new2", newLine: 5 },
    ])
    expect(toolSummary({ name: "Edit", input: {}, content: "", isError: false }, d)).toBe("Updated 2 lines")
  })

  test("Write fallback diffs against the PreToolUse snapshot", () => {
    const d = editDiff({ name: "Write", input: { file_path: "/w/f", content: "x\ny\n" }, content: "ok", isError: false, before: "x\n" })
    expect(d).toMatchObject({ oldText: "x\n", newText: "x\ny\n", added: 1, removed: 0 })
    expect(toolSummary({ name: "Edit", input: {}, content: "", isError: false }, d)).toBe("Added 1 line")
  })

  test("MultiEdit applies edits to the snapshot", () => {
    const d = editDiff({
      name: "MultiEdit",
      input: {
        file_path: "/w/f",
        edits: [
          { old_string: "a", new_string: "A" },
          { old_string: "c", new_string: "C" },
        ],
      },
      content: "ok",
      isError: false,
      before: "a\nb\nc\n",
    })
    expect(d).toMatchObject({ added: 2, removed: 2, newText: "A\nb\nC\n" })
  })

  test("patchToLines numbers multiple hunks", () => {
    const lines = patchToLines([
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [" x", "+y"] },
      { oldStart: 40, oldLines: 1, newStart: 41, newLines: 0, lines: ["-z", "\\ No newline at end of file"] },
    ])
    expect(lines).toEqual([
      { kind: "ctx", text: "x", oldLine: 10, newLine: 10 },
      { kind: "add", text: "y", newLine: 11 },
      { kind: "del", text: "z", oldLine: 40 },
    ])
  })

  test("Bash summary: first line or (no output)", () => {
    expect(toolSummary({ name: "Bash", input: {}, content: "", isError: false, structured: { stdout: "", stderr: "" } })).toBe("(no output)")
    expect(toolSummary({ name: "Bash", input: {}, content: "\nhello\nworld", isError: false })).toBe("hello")
  })

  test("errors strip tool_use_error tags", () => {
    expect(toolSummary({ name: "Read", input: {}, content: "<tool_use_error>File does not exist.</tool_use_error>", isError: true })).toBe(
      "File does not exist.",
    )
  })
})

describe("options", () => {
  test("approval → permission mode", () => {
    expect(permissionModeFor("ask")).toBe("default")
    expect(permissionModeFor("auto-edit")).toBe("acceptEdits")
    expect(permissionModeFor("auto")).toBe("auto")
    expect(permissionModeFor("yolo")).toBe("bypassPermissions")
  })

  test("env strips nested-session vars and maps providers", () => {
    const env = buildEnv(
      { provider: { id: "gw", kind: "openai-compatible", baseUrl: "http://gw", apiKey: "k" }, env: { FOO: "1" } },
      { CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: "x", HOME: "/h" },
    )
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined()
    expect(env).toMatchObject({ HOME: "/h", ANTHROPIC_BASE_URL: "http://gw", ANTHROPIC_AUTH_TOKEN: "k", FOO: "1" })
    expect(buildEnv({ provider: { id: "a", kind: "anthropic", apiKey: "sk" } }, {}).ANTHROPIC_API_KEY).toBe("sk")
    expect(buildEnv({ provider: { id: "b", kind: "bedrock" } }, {}).CLAUDE_CODE_USE_BEDROCK).toBe("1")
  })

  test("mcp servers → http configs", () => {
    expect(buildMcpServers({ mcpServers: [{ name: "baton", url: "http://127.0.0.1:1/mcp", headers: { a: "b" } }] })).toEqual({
      baton: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { a: "b" } },
    })
    expect(buildMcpServers({ mcpServers: [] })).toBeUndefined()
  })
})
