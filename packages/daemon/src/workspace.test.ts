import { beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonConfig } from "@batonsh/kernel"
import { git } from "./git.ts"
import { WorkspaceManager } from "./workspace.ts"

let root: string
const cfg = (over: Record<string, unknown> = {}) => BatonConfig.parse({ workspace: { dir: mkdtempSync(join(tmpdir(), "baton-wt-")), ...over } }).workspace

async function repo(): Promise<string> {
  const d = mkdtempSync(join(tmpdir(), "baton-repo-"))
  await git(d, ["init", "-q", "-b", "main"])
  writeFileSync(join(d, "README.md"), "# demo\n\nteh fastest way\n")
  writeFileSync(join(d, "a.ts"), "export const a = 1\nexport const b = 2\nexport const c = 3\n")
  writeFileSync(join(d, ".gitignore"), "node_modules/\n.env\n")
  await git(d, ["add", "-A"])
  await git(d, ["commit", "-q", "-m", "init"])
  return d
}

beforeEach(async () => {
  root = await repo()
})

describe("WorkspaceManager", () => {
  test("worktree starts from the project *including uncommitted changes*, outside the repo", async () => {
    writeFileSync(join(root, "draft.txt"), "uncommitted\n")
    const wm = new WorkspaceManager(root, cfg(), "run_test123456")
    const ws = await wm.create("a1", "codex-1", "worktree")
    expect(ws.mode).toBe("worktree")
    expect(ws.path.startsWith(root)).toBe(false)
    expect(readFileSync(join(ws.path, "draft.txt"), "utf8")).toBe("uncommitted\n")
    expect(ws.branch).toBe("baton/123456/codex-1")
    // the user's index is untouched
    expect((await git(root, ["status", "--porcelain"])).stdout).toContain("?? draft.txt")
  })

  test("links dependency dirs and copies env files without counting them as changes", async () => {
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true })
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "x")
    writeFileSync(join(root, ".env"), "SECRET=1\n")
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    expect(existsSync(join(ws.path, "node_modules", "dep", "index.js"))).toBe(true)
    expect(readFileSync(join(ws.path, ".env"), "utf8")).toBe("SECRET=1\n")
    const r = await wm.refresh("a1")
    expect(r?.files).toEqual([])
  })

  test("refresh reports changed files; merge applies them to the working tree only", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "README.md"), "# demo\n\nthe fastest way\n")
    writeFileSync(join(ws.path, "new.ts"), "export {}\n")
    const r = await wm.refresh("a1")
    expect(r?.files.map((f) => f.path).sort()).toEqual(["README.md", "new.ts"])
    const m = await wm.merge("a1")
    expect(m.status).toBe("merged")
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("the fastest way")
    expect(existsSync(join(root, "new.ts"))).toBe(true)
    // nothing staged in the user's index, HEAD unchanged
    const status = (await git(root, ["status", "--porcelain"])).stdout
    expect(status).toContain(" M README.md")
    expect(status).toContain("?? new.ts")
    expect((await git(root, ["log", "--oneline"])).stdout.trim().split("\n").length).toBe(1)
    // a second merge with no new work is a no-op
    expect((await wm.merge("a1")).status).toBe("empty")
  })

  test("merges three-way on top of edits the user made meanwhile", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "a.ts"), "export const a = 10\nexport const b = 2\nexport const c = 3\n")
    writeFileSync(join(root, "a.ts"), "export const a = 1\nexport const b = 2\nexport const c = 30\n")
    const m = await wm.merge("a1")
    expect(m.status).toBe("merged")
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export const a = 10\nexport const b = 2\nexport const c = 30\n")
  })

  test("predicts conflicts between two workers, merge reports them, sync resolves via markers", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const w1 = await wm.create("a1", "codex-1", "worktree")
    const w2 = await wm.create("a2", "claude-1", "worktree")
    writeFileSync(join(w1.path, "a.ts"), "export const a = 'one'\nexport const b = 2\nexport const c = 3\n")
    writeFileSync(join(w2.path, "a.ts"), "export const a = 'two'\nexport const b = 2\nexport const c = 3\n")
    await wm.refresh("a1")
    await wm.refresh("a2")
    const c = await wm.conflictsFor("a1")
    expect(c).toEqual([{ with: "a2", files: ["a.ts"] }])
    expect((await wm.merge("a1")).status).toBe("merged")
    const m2 = await wm.merge("a2")
    expect(m2.status).toBe("conflict")
    expect(m2.conflicts).toEqual(["a.ts"])
    const s = await wm.sync("a2")
    expect(s.clean).toBe(false)
    expect(readFileSync(join(w2.path, "a.ts"), "utf8")).toContain("<<<<<<<")
    // the agent resolves the markers…
    writeFileSync(join(w2.path, "a.ts"), "export const a = 'one and two'\nexport const b = 2\nexport const c = 3\n")
    const m3 = await wm.merge("a2")
    expect(m3.status).toBe("merged")
    expect(readFileSync(join(root, "a.ts"), "utf8")).toContain("one and two")
  })

  test("undo a merge three-way: later edits survive, the agent's work is unmerged again", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "a.ts"), "export const a = 'agent'\nexport const b = 2\nexport const c = 3\n")
    expect((await wm.merge("a1")).status).toBe("merged")
    // the user edits another line after the merge
    writeFileSync(join(root, "a.ts"), "export const a = 'agent'\nexport const b = 2\nexport const c = 'mine'\n")
    const u = await wm.undoMerge()
    expect(u.ok).toBe(true)
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export const a = 1\nexport const b = 2\nexport const c = 'mine'\n")
    expect((await wm.refresh("a1"))?.files.map((f) => f.path)).toEqual(["a.ts"])
    expect((await wm.undoMerge()).ok).toBe(false)
  })

  test("each worktree gets its own port block", async () => {
    const wm = new WorkspaceManager(root, cfg({ ports: 2, port_base: 5000 }), "run_x")
    await wm.create("a1", "codex-1", "worktree")
    await wm.create("a2", "codex-2", "worktree")
    expect(wm.env("a1")).toMatchObject({ PORT: "5000", BATON_PORT_0: "5000", BATON_PORT_1: "5001" })
    expect(wm.env("a2")).toMatchObject({ PORT: "5010", BATON_PORT_1: "5011" })
    await wm.remove("a1")
    await wm.create("a3", "codex-3", "worktree")
    expect(wm.env("a3").PORT).toBe("5000") // freed block is reused
  })

  test("verify command gates the merge", async () => {
    const wm = new WorkspaceManager(root, cfg({ verify: "grep -q ok status.txt" }), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "status.txt"), "failing\n")
    const bad = await wm.merge("a1")
    expect(bad.status).toBe("failed")
    expect(bad.detail).toContain("verify")
    expect(existsSync(join(root, "status.txt"))).toBe(false)
    writeFileSync(join(ws.path, "status.txt"), "ok\n")
    expect((await wm.merge("a1")).status).toBe("merged")
  })

  test("cleanup keeps worktrees with unmerged work, removes merged ones", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const w1 = await wm.create("a1", "codex-1", "worktree")
    const w2 = await wm.create("a2", "codex-2", "worktree")
    writeFileSync(join(w1.path, "x.txt"), "keep me\n")
    expect((await wm.remove("a1")).kept).toBe(true)
    expect(existsSync(w1.path)).toBe(true)
    expect((await wm.remove("a2")).kept).toBe(false)
    expect(existsSync(w2.path)).toBe(false)
    expect((await git(root, ["branch", "--list", "baton/*"])).stdout).not.toContain("codex-2")
  })

  test("non-git folders and isolation=shared work in place", async () => {
    const plain = mkdtempSync(join(tmpdir(), "baton-plain-"))
    const wm = new WorkspaceManager(plain, cfg(), "run_x")
    expect((await wm.create("a1", "codex-1", "worktree")).mode).toBe("shared")
    const wm2 = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm2.create("a2", "codex-2", "shared")
    expect(ws.path).toBe(root)
    expect((await wm2.merge("a2")).status).toBe("failed")
  })

  test("repo without any commit still gets worktrees", async () => {
    const d = mkdtempSync(join(tmpdir(), "baton-empty-"))
    await git(d, ["init", "-q"])
    writeFileSync(join(d, "x.txt"), "1\n")
    const wm = new WorkspaceManager(d, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "x.txt"), "2\n")
    expect((await wm.merge("a1")).status).toBe("merged")
    expect(readFileSync(join(d, "x.txt"), "utf8")).toBe("2\n")
  })
})

void symlinkSync
