import { afterAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonConfig } from "@batonsh/kernel"
import { fetchIssue, issueTask, openPr, parseRemote, planPr } from "./github.ts"
import { handleInput } from "./input.ts"
import { Runtime } from "./runtime.ts"

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`)
  return r.stdout.toString().trim()
}

const pulls: Record<string, unknown>[] = []
const api = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (req.headers.get("authorization") !== "Bearer t0k") return Response.json({ message: "Bad credentials" }, { status: 401 })
    if (url.pathname === "/repos/acme/app/issues/7")
      return Response.json({
        number: 7,
        title: "Login button misaligned",
        body: "It's 2px off.",
        html_url: "https://github.com/acme/app/issues/7",
        labels: [{ name: "ui" }],
        comments: 1,
      })
    if (url.pathname === "/repos/acme/app/issues/7/comments") return Response.json([{ user: { login: "dana" }, body: "Only on Safari." }])
    if (url.pathname === "/repos/acme/app/pulls" && req.method === "POST") {
      pulls.push((await req.json()) as Record<string, unknown>)
      return Response.json({ number: 12, html_url: "https://github.com/acme/app/pull/12" })
    }
    return Response.json({ message: "Not Found" }, { status: 404 })
  },
})

const base = mkdtempSync(join(tmpdir(), "baton-gh-"))
const bare = join(base, "acme", "app.git")
mkdirSync(join(base, "acme"))
sh(base, "git", "init", "-q", "--bare", bare)
const root = join(base, "work")
mkdirSync(root)
sh(root, "git", "init", "-q", "-b", "main")
writeFileSync(join(root, "a.txt"), "one\n")
writeFileSync(join(root, "keep.txt"), "mine\n")
sh(root, "git", "add", ".")
sh(root, "git", "-c", "user.email=u@x", "-c", "user.name=U", "commit", "-qm", "init")
sh(root, "git", "remote", "add", "origin", bare)
sh(root, "git", "push", "-q", "origin", "main")

process.env.GITHUB_TOKEN = "t0k"
const rt = new Runtime({
  projectRoot: root,
  config: BatonConfig.parse({ bus: { heartbeat_s: 0 }, github: { api_url: `http://127.0.0.1:${api.port}` }, orchestrator: { agent: "mock" } }),
})
afterAll(async () => {
  await rt.close()
  api.stop(true)
  delete process.env.GITHUB_TOKEN
})

test("remote URLs", () => {
  expect(parseRemote("git@github.com:acme/app.git")).toEqual({ owner: "acme", repo: "app" })
  expect(parseRemote("https://github.com/acme/app")).toEqual({ owner: "acme", repo: "app" })
  expect(parseRemote(bare)).toEqual({ owner: "acme", repo: "app" })
})

test("an issue becomes the orchestrator's task", async () => {
  const issue = await fetchIssue(rt, "#7")
  expect(issue.comments[0]?.author).toBe("dana")
  expect(issueTask(issue)).toContain("Login button misaligned")
  const r = await handleInput(rt, "/issue 7")
  expect(r.output).toContain("issue #7")
})

test("a PR is built from merged files only, without touching the working tree, index or branch", async () => {
  // Baton merged a.txt; the user also has an unrelated uncommitted edit (keep.txt) and a staged file
  writeFileSync(join(root, "a.txt"), "one\ntwo\n")
  writeFileSync(join(root, "keep.txt"), "mine, edited\n")
  writeFileSync(join(root, "staged.txt"), "staged\n")
  sh(root, "git", "add", "staged.txt")
  rt.emit({ type: "agent.spawned", data: { agentId: "w1", name: "codex-1", adapter: "codex", cwd: root, approval: "ask" } }, "w1")
  rt.emit({ type: "workspace.merge", data: { status: "merged", files: ["a.txt"] } }, "w1")
  const plan = await planPr(rt)
  expect(plan.files).toEqual(["a.txt"])
  expect(plan.base).toBe("main")
  expect(plan.body).toContain("Closes #7")
  expect((await handleInput(rt, "/pr")).output).toContain("Run /pr confirm")
  const headBefore = sh(root, "git", "rev-parse", "HEAD")
  const r = await openPr(rt)
  expect(r.url).toBe("https://github.com/acme/app/pull/12")
  expect(pulls[0]).toMatchObject({ head: plan.branch, base: "main", draft: true, title: "Login button misaligned (#7)" })
  // the pushed branch has exactly the merged change
  expect(sh(bare, "git", "show", `${plan.branch}:a.txt`)).toBe("one\ntwo")
  expect(sh(bare, "git", "show", `${plan.branch}:keep.txt`)).toBe("mine")
  expect(sh(bare, "git", "diff", "--name-only", "main", plan.branch)).toBe("a.txt")
  // and nothing local moved
  expect(sh(root, "git", "rev-parse", "HEAD")).toBe(headBefore)
  expect(sh(root, "git", "rev-parse", "--abbrev-ref", "HEAD")).toBe("main")
  expect(sh(root, "git", "diff", "--cached", "--name-only")).toBe("staged.txt")
  expect(sh(root, "git", "status", "--porcelain", "a.txt")).toBe("M a.txt")
})
