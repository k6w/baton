/**
 * GitHub: start a run from an issue, and open a pull request from what the run merged.
 *
 * The PR never touches your working tree, index or current branch: a commit is built through a
 * temporary index from HEAD plus the files Baton merged in this run (as they are now), pushed to a
 * fresh `baton/…` branch, and opened as a (draft) pull request through the REST API.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveSecret } from "@batonsh/kernel"
import { git } from "./git.ts"
import type { Runtime } from "./runtime.ts"

export interface RepoRef {
  owner: string
  repo: string
}

export interface Issue {
  number: number
  title: string
  body: string
  url: string
  labels: string[]
  comments: { author: string; body: string }[]
  repo: RepoRef
}

/** git@github.com:o/r.git · https://github.com/o/r(.git) · ssh://git@host/o/r → {owner, repo} */
export function parseRemote(url: string): RepoRef | undefined {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())
  return m ? { owner: m[1] as string, repo: m[2] as string } : undefined
}

export async function repoOf(rt: Runtime): Promise<RepoRef> {
  const remote = rt.config.github.remote
  const r = await git(rt.projectRoot, ["remote", "get-url", remote], { allowFail: true })
  const ref = r.code === 0 ? parseRemote(r.stdout) : undefined
  if (!ref) throw new Error(`no GitHub remote "${remote}" in this repository (git remote add ${remote} <url>, or set github.remote)`)
  return ref
}

export async function githubToken(rt: Runtime): Promise<string | undefined> {
  if (rt.config.github.token) return resolveSecret(rt.config.github.token)
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (env) return env
  if (Bun.which("gh")) {
    const p = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" })
    const t = p.stdout.toString().trim()
    if (p.exitCode === 0 && t) return t
  }
  return undefined
}

async function api<T>(rt: Runtime, method: string, path: string, body?: unknown): Promise<T> {
  const token = await githubToken(rt)
  const res = await fetch(`${rt.config.github.api_url.replace(/\/$/, "")}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "baton",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await res.text()
  if (!res.ok) {
    let msg = text
    try {
      const j = JSON.parse(text) as { message?: string; errors?: { message?: string }[] }
      msg = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(" — ")
    } catch {}
    if (res.status === 401 || (res.status === 404 && !token))
      throw new Error(`GitHub ${res.status}: ${msg || "unauthorized"} — set GITHUB_TOKEN (or github.token) with repo access`)
    throw new Error(`GitHub ${res.status}: ${msg}`)
  }
  return (text ? JSON.parse(text) : {}) as T
}

const linked = new WeakMap<Runtime, Issue>()

/** "123", "#123", "owner/repo#123" or an issue URL. */
export async function fetchIssue(rt: Runtime, ref: string): Promise<Issue> {
  let repo: RepoRef
  let number: number
  const url = /github\.[^/]+\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/.exec(ref)
  const short = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(ref)
  if (url) {
    repo = { owner: url[1] as string, repo: url[2] as string }
    number = Number(url[3])
  } else if (short) {
    repo = { owner: short[1] as string, repo: short[2] as string }
    number = Number(short[3])
  } else {
    number = Number(ref.replace(/^#/, ""))
    if (!Number.isInteger(number) || number <= 0) throw new Error(`not an issue: ${ref} (use 123, #123, owner/repo#123 or a URL)`)
    repo = await repoOf(rt)
  }
  const i = await api<{ number: number; title: string; body: string | null; html_url: string; labels: { name: string }[]; comments: number }>(
    rt,
    "GET",
    `/repos/${repo.owner}/${repo.repo}/issues/${number}`,
  )
  const comments = i.comments
    ? (await api<{ user: { login: string }; body: string }[]>(rt, "GET", `/repos/${repo.owner}/${repo.repo}/issues/${number}/comments?per_page=20`)).map(
        (c) => ({
          author: c.user.login,
          body: c.body,
        }),
      )
    : []
  const issue: Issue = { number: i.number, title: i.title, body: i.body ?? "", url: i.html_url, labels: i.labels.map((l) => l.name), comments, repo }
  linked.set(rt, issue)
  return issue
}

/** The issue as a task for the orchestrator. */
export function issueTask(i: Issue): string {
  const parts = [`Work on GitHub issue #${i.number}: ${i.title}`, i.url]
  if (i.labels.length) parts.push(`labels: ${i.labels.join(", ")}`)
  parts.push("", i.body.trim() || "(no description)")
  for (const c of i.comments.slice(-8)) parts.push("", `— comment by ${c.author}:`, c.body.trim())
  parts.push("", "Resolve it end to end (plan, implement, verify, review, merge). Finish with a short summary suitable for a pull request description.")
  return parts.join("\n")
}

export interface PrPlan {
  repo: RepoRef
  branch: string
  base: string
  title: string
  body: string
  files: string[]
  issue?: Issue
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40) || "changes"

/** What a PR would contain: files Baton merged in this run that still differ from HEAD. */
export async function planPr(rt: Runtime, title?: string): Promise<PrPlan> {
  const repo = await repoOf(rt)
  const merged = new Set<string>()
  const byAgent = new Map<string, Set<string>>()
  for (const e of rt.store.query({ runId: rt.runId, types: ["workspace.merge"] })) {
    if (e.type !== "workspace.merge" || e.data.status !== "merged") continue
    for (const f of e.data.files ?? []) {
      merged.add(f)
      const name = e.agentId ? (rt.state.agents.get(e.agentId)?.name ?? "agent") : "agent"
      if (!byAgent.has(name)) byAgent.set(name, new Set())
      byAgent.get(name)!.add(f)
    }
  }
  const changed = new Set(
    (await git(rt.projectRoot, ["status", "--porcelain", "-z", "--untracked-files=all", "--", "."])).stdout
      .split("\0")
      .filter(Boolean)
      .map((l) => l.slice(3)),
  )
  const files = [...merged].filter((f) => changed.has(f)).sort()
  if (!files.length) throw new Error("nothing to open a PR with: no merged changes from this run are left uncommitted")
  const issue = linked.get(rt)
  const firstTask = (() => {
    const id = rt.state.orchestratorId
    const it = id ? rt.state.feed(id).items.find((x) => x.kind === "user" && !x.text.startsWith("[baton]")) : undefined
    return it && it.kind === "user" ? (it.text.split("\n")[0] ?? "") : ""
  })()
  const prTitle = title?.trim() || (issue ? `${issue.title} (#${issue.number})` : firstTask.slice(0, 72) || "Changes from Baton")
  const head = (await git(rt.projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
  const onRemote = (await git(rt.projectRoot, ["ls-remote", "--heads", rt.config.github.remote, head], { allowFail: true })).stdout.trim() !== ""
  const base = head !== "HEAD" && onRemote ? head : (await api<{ default_branch: string }>(rt, "GET", `/repos/${repo.owner}/${repo.repo}`)).default_branch
  const lines: string[] = []
  if (issue) lines.push(`Closes #${issue.number}`, "")
  const lead = rt.state.orchestratorId
    ? rt.state
        .feed(rt.state.orchestratorId)
        .items.filter((x) => x.kind === "message" && x.role === "assistant")
        .at(-1)
    : undefined
  if (lead && lead.kind === "message") lines.push(lead.text.trim().slice(0, 3000), "")
  lines.push("### Agents")
  for (const [name, fs] of byAgent) {
    const a = [...rt.state.agents.values()].find((x) => x.name === name)
    lines.push(`- **${name}** (${a?.adapter ?? "?"}${a?.model ? ` · ${a.model}` : ""}): ${[...fs].join(", ")}`)
  }
  const reviews = rt.store.query({ runId: rt.runId, types: ["review.verdict"] })
  if (reviews.length) {
    lines.push("", "### Reviews")
    for (const r of reviews)
      if (r.type === "review.verdict")
        lines.push(
          `- ${rt.state.agents.get(r.data.reviewer)?.name ?? "reviewer"} on ${rt.state.agents.get(r.data.author)?.name ?? "author"}: **${r.data.verdict}**`,
        )
  }
  if (rt.config.workspace.verify) lines.push("", `Verified with \`${rt.config.workspace.verify}\` before each merge.`)
  lines.push("", "_Made with [Baton](https://github.com/k6w/baton) — a team of coding agents._")
  return { repo, branch: `baton/${slug(prTitle)}-${rt.runId.slice(-6).toLowerCase()}`, base, title: prTitle, body: lines.join("\n"), files, issue }
}

async function userIdentity(cwd: string): Promise<Record<string, string>> {
  const get = async (k: string) => (await git(cwd, ["config", k], { allowFail: true })).stdout.trim()
  const [name, email] = await Promise.all([get("user.name"), get("user.email")])
  return name && email ? { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email } : {}
}

/** Commit (via a temporary index), push a new branch and open the pull request. */
export async function openPr(rt: Runtime, title?: string): Promise<{ url: string; number: number; branch: string; files: string[] }> {
  if (!(await githubToken(rt))) throw new Error("no GitHub token: set GITHUB_TOKEN (or github.token) — needed to open pull requests")
  const plan = await planPr(rt, title)
  const cwd = rt.projectRoot
  const dir = mkdtempSync(join(tmpdir(), "baton-pr-"))
  const env = { GIT_INDEX_FILE: join(dir, "index"), ...(await userIdentity(cwd)) }
  let commit: string
  try {
    await git(cwd, ["read-tree", "HEAD"], { env })
    for (const f of plan.files) {
      if (existsSync(join(cwd, f))) await git(cwd, ["update-index", "--add", "--", f], { env })
      else await git(cwd, ["update-index", "--force-remove", "--", f], { env })
    }
    const tree = (await git(cwd, ["write-tree"], { env })).stdout.trim()
    const message = `${plan.title}\n\n${plan.issue ? `Closes #${plan.issue.number}\n\n` : ""}Made with Baton.`
    commit = (await git(cwd, ["commit-tree", tree, "-p", "HEAD", "-m", message], { env })).stdout.trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  await git(cwd, ["push", rt.config.github.remote, `${commit}:refs/heads/${plan.branch}`])
  const pr = await api<{ html_url: string; number: number }>(rt, "POST", `/repos/${plan.repo.owner}/${plan.repo.repo}/pulls`, {
    title: plan.title,
    head: plan.branch,
    base: plan.base,
    body: plan.body,
    draft: rt.config.github.draft,
  })
  rt.emit({ type: "orch.note", data: { text: `opened pull request #${pr.number}: ${pr.html_url}` } })
  return { url: pr.html_url, number: pr.number, branch: plan.branch, files: plan.files }
}
