import { beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonConfig } from "@batonsh/kernel"
import { git } from "./git.ts"
import { cloneDir, installCommand, WorkspaceManager } from "./workspace.ts"

// real git work: slow machines / busy CI need more than the 5s default
setDefaultTimeout(30_000)

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
    const wm = new WorkspaceManager(root, cfg({ clone: [] }), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    expect(existsSync(join(ws.path, "node_modules", "dep", "index.js"))).toBe(true)
    expect(readFileSync(join(ws.path, ".env"), "utf8")).toBe("SECRET=1\n")
    const r = await wm.refresh("a1")
    expect(r?.files).toEqual([])
  })

  test("tool caches (a reviewer running the tests) are not the agent's work", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_c")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "new.ts"), "export {}\n")
    mkdirSync(join(ws.path, "node_modules/.vite/vitest"), { recursive: true })
    writeFileSync(join(ws.path, "node_modules/.vite/vitest/results.json"), "{}")
    mkdirSync(join(ws.path, "pkg/__pycache__"), { recursive: true })
    writeFileSync(join(ws.path, "pkg/__pycache__/m.pyc"), "x")
    const r = await wm.refresh("a1")
    expect(r?.files.map((f) => f.path)).toEqual(["new.ts"])
  })

  test("merge = working-tree: refresh reports changed files; merge applies them to the working tree only", async () => {
    const wm = new WorkspaceManager(root, cfg({ merge: "working-tree" }), "run_x")
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
  test("project in a subdirectory of its repo: agent cwd is the matching subdir, merges land in the project", async () => {
    const top = mkdtempSync(join(tmpdir(), "baton-mono-"))
    await git(top, ["init", "-q", "-b", "main"])
    mkdirSync(join(top, "packages", "app"), { recursive: true })
    writeFileSync(join(top, "root.txt"), "root\n")
    writeFileSync(join(top, "packages", "app", "a.ts"), "export const a = 1\n")
    await git(top, ["add", "-A"])
    await git(top, ["commit", "-q", "-m", "init"])
    const app = join(top, "packages", "app")
    writeFileSync(join(app, "draft.ts"), "uncommitted\n")
    const wm = new WorkspaceManager(app, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    expect(ws.root).toBeDefined()
    expect(ws.path).toBe(join(ws.root as string, "packages", "app"))
    expect(readFileSync(join(ws.path, "a.ts"), "utf8")).toBe("export const a = 1\n")
    expect(readFileSync(join(ws.path, "draft.ts"), "utf8")).toBe("uncommitted\n")
    writeFileSync(join(ws.path, "a.ts"), "export const a = 2\n")
    writeFileSync(join(ws.path, "new file.ts"), "export {}\n")
    const r = await wm.refresh("a1")
    expect(r?.files.map((f) => f.path).sort()).toEqual(["a.ts", "new file.ts"])
    const m = await wm.merge("a1")
    expect(m.status).toBe("merged")
    expect(readFileSync(join(app, "a.ts"), "utf8")).toBe("export const a = 2\n")
    expect(readFileSync(join(app, "new file.ts"), "utf8")).toBe("export {}\n")
    expect(existsSync(join(top, "a.ts"))).toBe(false)
    expect(existsSync(join(top, "new file.ts"))).toBe(false)
    // undo goes back to the project too
    expect((await wm.undoMerge()).ok).toBe(true)
    expect(readFileSync(join(app, "a.ts"), "utf8")).toBe("export const a = 1\n")
    // removal removes the whole worktree, not just the subdir
    await wm.merge("a1")
    expect((await wm.remove("a1")).kept).toBe(false)
    expect(existsSync(ws.root as string)).toBe(false)
  })

  test("reused agent names get a fresh branch instead of failing", async () => {
    const wm = new WorkspaceManager(root, cfg({ cleanup: "never" }), "run_test123456")
    const w1 = await wm.create("a1", "codex-1", "worktree")
    await wm.remove("a1")
    const w2 = await wm.create("a2", "codex-1", "worktree")
    expect(w1.branch).toBe("baton/123456/codex-1")
    expect(w2.branch).toBe("baton/123456/codex-1-2")
    // a resumed run (new manager, same run id) as well
    const wm2 = new WorkspaceManager(root, cfg(), "run_test123456")
    expect((await wm2.create("a3", "codex-1", "worktree")).branch).toBe("baton/123456/codex-1-3")
  })

  test("failed setup cleans up the worktree and the branch", async () => {
    const wm = new WorkspaceManager(root, cfg({ setup: "exit 3" }), "run_x")
    await expect(wm.create("a1", "codex-1", "worktree")).rejects.toThrow("setup")
    expect(wm.byAgent.has("a1")).toBe(false)
    expect((await git(root, ["branch", "--list", "baton/*"])).stdout.trim()).toBe("")
    expect((await git(root, ["worktree", "list"])).stdout.trim().split("\n").length).toBe(1)
  })

  test("paths with spaces, unicode and quotes are reported verbatim", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    // Windows forbids " and tabs in file names
    const names = ["with space.ts", "ünïcødé.ts", ...(process.platform === "win32" ? [] : ['q"uote.ts', "tab\there.ts"])]
    for (const n of names) writeFileSync(join(ws.path, n), "x\n")
    const r = await wm.refresh("a1")
    expect(r?.files.map((f) => f.path).sort()).toEqual([...names].sort())
    expect((await wm.merge("a1")).status).toBe("merged")
    for (const n of names) expect(readFileSync(join(root, n), "utf8")).toBe("x\n")
  })

  test("edits made during verify are never merged unverified", async () => {
    // verify passes, but sneaks in an extra edit (like an agent still working)
    const wm = new WorkspaceManager(root, cfg({ verify: "echo late > late.txt" }), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "a.ts"), "export const a = 'v'\n")
    const m = await wm.merge("a1")
    expect(m.status).toBe("failed")
    expect(m.detail).toContain("changed during verify")
    expect(existsSync(join(root, "late.txt"))).toBe(false)
    expect(readFileSync(join(root, "a.ts"), "utf8")).not.toContain("'v'")
  })

  test("after a merge the worktree index matches HEAD", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "a.ts"), "export const a = 'x'\n")
    writeFileSync(join(ws.path, "n.ts"), "n\n")
    expect((await wm.merge("a1")).status).toBe("merged")
    expect((await git(ws.path, ["status", "--porcelain"])).stdout.trim()).toBe("")
  })

  test("remove keeps the worktree when it can't be inspected", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "x.txt"), "work\n")
    ws.base = "0000000000000000000000000000000000000bad" // snapshot/diff will fail
    const r = await wm.remove("a1")
    expect(r.kept).toBe(true)
    expect(r.reason).toContain("couldn't check")
    expect(existsSync(join(ws.path, "x.txt"))).toBe(true)
  })

  test("gate runs in the queue with the fresh tree and can block the merge", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "a.ts"), "export const a = 'g'\n")
    let seen: string | undefined
    const m = await wm.merge("a1", {
      gate: (w) => {
        seen = w.tree
        return "needs review"
      },
    })
    expect(m).toMatchObject({ status: "failed", detail: "needs review" })
    expect(m.files.map((f) => f.path)).toEqual(["a.ts"])
    expect(seen).toMatch(/^[0-9a-f]{40}$/)
    expect(readFileSync(join(root, "a.ts"), "utf8")).not.toContain("'g'")
    const ok = await wm.merge("a1", { gate: (w) => (w.tree === seen ? undefined : "tree changed") })
    expect(ok.status).toBe("merged")
  })

  test("conflict prediction uses a common base for workers that branched at different times", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const w1 = await wm.create("a1", "codex-1", "worktree")
    // the user edits line 3 after the first worker started; the second worker starts from that
    writeFileSync(join(root, "a.ts"), "export const a = 1\nexport const b = 2\nexport const c = 'user'\n")
    const w2 = await wm.create("a2", "codex-2", "worktree")
    // non-overlapping edits to the same file: no conflict expected
    writeFileSync(join(w1.path, "a.ts"), "export const a = 'one'\nexport const b = 2\nexport const c = 3\n")
    writeFileSync(join(w2.path, "a.ts"), "export const a = 1\nexport const b = 2\nexport const c = 'user'\nexport const d = 4\n")
    await wm.refresh("a1")
    await wm.refresh("a2")
    expect(await wm.conflictsFor("a1")).toEqual([])
    expect(await wm.conflictsFor("a2")).toEqual([])
  })

  // ── regressions ──

  test("worker branch descends from the real HEAD; the user's untracked files stay uncommitted", async () => {
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim()
    mkdirSync(join(root, "docs"))
    writeFileSync(join(root, "docs", "big.md"), "user's untracked docs\n")
    writeFileSync(join(root, "README.md"), "# demo\n\nuser edit\n") // tracked, uncommitted
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    const branch = ws.branch as string
    expect((await git(root, ["rev-parse", branch])).stdout.trim()).toBe(head)
    // the agent still sees the user's state, as uncommitted changes
    expect(readFileSync(join(ws.path, "docs", "big.md"), "utf8")).toBe("user's untracked docs\n")
    expect(readFileSync(join(ws.path, "README.md"), "utf8")).toContain("user edit")
    const st = (await git(ws.path, ["status", "--porcelain"])).stdout
    expect(st).toContain("?? docs/")
    expect(st).toContain(" M README.md")
    // …but none of it is the agent's work
    expect((await wm.refresh("a1"))?.files).toEqual([])
    writeFileSync(join(ws.path, "a.ts"), "export const a = 'agent'\n")
    expect((await wm.refresh("a1"))?.files.map((f) => f.path)).toEqual(["a.ts"])
    expect((await wm.merge("a1")).status).toBe("merged")
    // the branch holds exactly the agent's change on top of HEAD — no docs, no user README edit
    expect((await git(root, ["rev-parse", `${branch}^`])).stdout.trim()).toBe(head)
    expect((await git(root, ["diff", "--name-only", head, branch])).stdout.trim()).toBe("a.ts")
    // merged three-way into the project, the user's own edits untouched
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export const a = 'agent'\n")
    expect(readFileSync(join(root, "README.md"), "utf8")).toContain("user edit")
    // further work is still measured against the agent's own last merge
    writeFileSync(join(ws.path, "b.ts"), "b\n")
    expect((await wm.refresh("a1"))?.files.map((f) => f.path)).toEqual(["b.ts"])
  })

  test("node_modules is a real per-worktree directory (not a symlink out of the worktree)", async () => {
    mkdirSync(join(root, "node_modules", "dep"), { recursive: true })
    writeFileSync(join(root, "node_modules", "dep", "index.js"), "x")
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    const nm = join(ws.path, "node_modules")
    expect(lstatSync(nm).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(nm, "dep", "index.js"), "utf8")).toBe("x")
    // installing in the worker doesn't touch the user's checkout
    writeFileSync(join(nm, "dep", "added.js"), "y")
    expect(existsSync(join(root, "node_modules", "dep", "added.js"))).toBe(false)
    expect((await wm.refresh("a1"))?.files).toEqual([])
  })

  test("merge lands as a commit on the user's branch, without the user's unrelated uncommitted work", async () => {
    const head = (await git(root, ["rev-parse", "HEAD"])).stdout.trim()
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(root, "README.md"), "# demo\n\nuser wip\n") // unrelated, uncommitted
    writeFileSync(join(root, "notes.txt"), "user notes\n") // unrelated, untracked
    writeFileSync(join(ws.path, "a.ts"), "export const a = 'agent'\n")
    writeFileSync(join(ws.path, "new.ts"), "export {}\n")
    const m = await wm.merge("a1", { label: "fix the thing" })
    expect(m.status).toBe("merged")
    expect((await git(root, ["log", "-1", "--format=%s"])).stdout.trim()).toBe("baton: codex-1 — fix the thing")
    expect((await git(root, ["rev-parse", "HEAD^"])).stdout.trim()).toBe(head)
    expect(m.commit).toBe((await git(root, ["rev-parse", "HEAD"])).stdout.trim())
    expect((await git(root, ["diff", "--name-only", "HEAD^", "HEAD"])).stdout.trim().split("\n").sort()).toEqual(["a.ts", "new.ts"])
    // only the user's own changes are left uncommitted; nothing of the agent's is staged or dirty
    const status = (await git(root, ["status", "--porcelain"])).stdout.trimEnd().split("\n").sort()
    expect(status).toEqual([" M README.md", "?? notes.txt"])
    // undo takes the commit back off the branch
    expect((await wm.undoMerge()).ok).toBe(true)
    expect((await git(root, ["rev-parse", "HEAD"])).stdout.trim()).toBe(head)
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export const a = 1\nexport const b = 2\nexport const c = 3\n")
    expect(existsSync(join(root, "new.ts"))).toBe(false)
    expect((await git(root, ["status", "--porcelain"])).stdout.trimEnd().split("\n").sort()).toEqual([" M README.md", "?? notes.txt"])
  })

  test("merge is left uncommitted when the user has uncommitted edits in the same file", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "a.ts"), "export const a = 10\nexport const b = 2\nexport const c = 3\n")
    writeFileSync(join(root, "a.ts"), "export const a = 1\nexport const b = 2\nexport const c = 30\n")
    const m = await wm.merge("a1")
    expect(m.status).toBe("merged")
    expect(m.detail).toContain("uncommitted")
    expect((await git(root, ["log", "--oneline"])).stdout.trim().split("\n").length).toBe(1)
    expect(readFileSync(join(root, "a.ts"), "utf8")).toBe("export const a = 10\nexport const b = 2\nexport const c = 30\n")
  })

  test("no conflict warning for a change that is already in the other worker's base", async () => {
    const lines = (o: Record<number, string> = {}) => `${Array.from({ length: 8 }, (_, i) => o[i] ?? `line ${i}`).join("\n")}\n`
    writeFileSync(join(root, "f.txt"), lines())
    await git(root, ["add", "-A"])
    await git(root, ["commit", "-q", "-m", "f"])
    const wm = new WorkspaceManager(root, cfg({ merge: "working-tree" }), "run_x")
    const w1 = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(w1.path, "f.txt"), lines({ 1: "one" }))
    expect((await wm.merge("a1")).status).toBe("merged")
    // the user touches something else, then a second worker starts (its base has a1's change)
    writeFileSync(join(root, "other.txt"), "user\n")
    const w2 = await wm.create("a2", "codex-2", "worktree")
    expect(readFileSync(join(w2.path, "f.txt"), "utf8")).toBe(lines({ 1: "one" }))
    // a1 keeps working right next to its merged line; a2 edits far away
    writeFileSync(join(w1.path, "f.txt"), lines({ 1: "one", 2: "two" }))
    writeFileSync(join(w2.path, "f.txt"), lines({ 1: "one", 6: "six" }))
    await wm.refresh("a1")
    await wm.refresh("a2")
    expect(await wm.conflictsFor("a1")).toEqual([])
    expect(await wm.conflictsFor("a2")).toEqual([])
    // a real overlap is still reported
    writeFileSync(join(w2.path, "f.txt"), lines({ 1: "one", 2: "deux" }))
    await wm.refresh("a2")
    expect(await wm.conflictsFor("a1")).toEqual([{ with: "a2", files: ["f.txt"] }])
  })

  test("diff stats count every line of large new and modified files", async () => {
    const wm = new WorkspaceManager(root, cfg(), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    writeFileSync(join(ws.path, "big.ts"), Array.from({ length: 300 }, (_, i) => `export const x${i} = ${i}`).join("\n") + "\n")
    writeFileSync(join(ws.path, "a.ts"), Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n") + "\n")
    const r = await wm.refresh("a1")
    expect(r?.files.find((f) => f.path === "big.ts")).toEqual({ path: "big.ts", added: 300, removed: 0 })
    expect(r?.files.find((f) => f.path === "a.ts")).toEqual({ path: "a.ts", added: 120, removed: 3 })
  })
})

void symlinkSync

describe("dependency folders: clone → install → symlink", () => {
  const tmp = () => mkdtempSync(join(tmpdir(), "baton-dep-"))
  const project = () => {
    const p = tmp()
    mkdirSync(join(p, "node_modules", "dep"), { recursive: true })
    writeFileSync(join(p, "node_modules", "dep", "index.js"), "x")
    return p
  }

  test("installCommand picks the package manager from the lockfile (package dir first, then the project root)", () => {
    const p = tmp()
    const pkg = join(p, "packages", "app")
    mkdirSync(pkg, { recursive: true })
    expect(installCommand(p, pkg)).toBeUndefined() // no package.json: nothing to install
    writeFileSync(join(pkg, "package.json"), "{}")
    expect(installCommand(p, pkg)).toBeUndefined() // no lockfile anywhere
    for (const [lock, cmd] of [
      ["package-lock.json", "npm"],
      ["yarn.lock", "yarn"],
      ["pnpm-lock.yaml", "pnpm"],
      ["bun.lock", "bun"],
    ] as const) {
      const d = tmp()
      writeFileSync(join(d, "package.json"), "{}")
      writeFileSync(join(d, lock), "")
      expect(installCommand(d, d)).toEqual([cmd, "install"])
    }
    writeFileSync(join(p, "pnpm-lock.yaml"), "") // monorepo: lockfile at the root
    expect(installCommand(p, pkg)).toEqual(["pnpm", "install"])
    writeFileSync(join(pkg, "yarn.lock"), "") // the package's own lockfile wins
    expect(installCommand(p, pkg)).toEqual(["yarn", "install"])
  })

  test("copy-on-write clone first", async () => {
    const p = project()
    const wt = tmp()
    const calls: string[][] = []
    const ok = await cloneDir(join(p, "node_modules"), join(wt, "node_modules"), {
      cwd: wt,
      rel: "node_modules",
      projectRoot: p,
      platform: "linux",
      runner: async (argv) => {
        calls.push(argv)
        return { code: 0 }
      },
    })
    expect(ok).toBe(true)
    expect(calls).toEqual([["cp", "--reflink=auto", "-R", join(p, "node_modules"), join(wt, "node_modules")]])
  })

  test("clone fails → the project's package manager installs into the worktree", async () => {
    const p = project()
    writeFileSync(join(p, "bun.lock"), "")
    const wt = tmp()
    writeFileSync(join(wt, "package.json"), "{}")
    const calls: { argv: string[]; cwd: string }[] = []
    const ok = await cloneDir(join(p, "node_modules"), join(wt, "node_modules"), {
      cwd: wt,
      rel: "node_modules",
      projectRoot: p,
      platform: "darwin",
      runner: async (argv, cwd) => {
        calls.push({ argv, cwd })
        if (argv[0] === "cp") {
          mkdirSync(join(wt, "node_modules", "half")) // a half-done copy is cleaned up
          return { code: 1 }
        }
        mkdirSync(join(wt, "node_modules", "dep"), { recursive: true })
        return { code: 0 }
      },
    })
    expect(ok).toBe(true)
    expect(calls.map((c) => c.argv[0])).toEqual(["cp", "bun"])
    expect(calls[1]).toEqual({ argv: ["bun", "install"], cwd: wt })
    expect(existsSync(join(wt, "node_modules", "half"))).toBe(false)
    expect(existsSync(join(wt, "node_modules", "dep"))).toBe(true)
  })

  test("clone and install both fail (or no cp on this platform and no lockfile) → false, nothing left behind", async () => {
    const p = project()
    writeFileSync(join(p, "package-lock.json"), "")
    const wt = tmp()
    writeFileSync(join(wt, "package.json"), "{}")
    const calls: string[] = []
    const failing = async (argv: string[]) => {
      calls.push(argv[0] as string)
      mkdirSync(join(wt, "node_modules"), { recursive: true })
      return { code: 1 }
    }
    const o = { cwd: wt, rel: "node_modules", projectRoot: p, runner: failing }
    expect(await cloneDir(join(p, "node_modules"), join(wt, "node_modules"), { ...o, platform: "linux" })).toBe(false)
    expect(calls).toEqual(["cp", "npm"])
    expect(existsSync(join(wt, "node_modules"))).toBe(false)
    // windows: no cp attempt, straight to the install
    calls.length = 0
    expect(await cloneDir(join(p, "node_modules"), join(wt, "node_modules"), { ...o, platform: "win32" })).toBe(false)
    expect(calls).toEqual(["npm"])
    // a runner that throws (binary missing) is just a failure
    const boom = async (): Promise<{ code: number }> => {
      throw new Error("ENOENT")
    }
    expect(await cloneDir(join(p, "node_modules"), join(wt, "node_modules"), { ...o, platform: "linux", runner: boom })).toBe(false)
  })

  test("other linked dirs are never installed; files can't be cloned", async () => {
    const p = tmp()
    mkdirSync(join(p, ".venv"))
    writeFileSync(join(p, "tool.bin"), "x")
    const wt = tmp()
    const calls: string[] = []
    const runner = async (argv: string[]) => {
      calls.push(argv[0] as string)
      return { code: 1 }
    }
    expect(await cloneDir(join(p, ".venv"), join(wt, ".venv"), { cwd: wt, rel: ".venv", projectRoot: p, platform: "linux", runner })).toBe(false)
    expect(calls).toEqual(["cp"])
    expect(await cloneDir(join(p, "tool.bin"), join(wt, "tool.bin"), { cwd: wt, rel: "tool.bin", projectRoot: p, runner })).toBe(false)
  })

  test("the workspace falls back to the old symlink when a linked path can't be cloned", async () => {
    writeFileSync(join(root, "tool.bin"), "x")
    const wm = new WorkspaceManager(root, cfg({ link: ["tool.bin"], clone: ["tool.bin"] }), "run_x")
    const ws = await wm.create("a1", "codex-1", "worktree")
    expect(lstatSync(join(ws.path, "tool.bin")).isSymbolicLink()).toBe(true)
    expect((await wm.refresh("a1"))?.files).toEqual([])
  })
})
