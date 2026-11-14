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
import { git, userIdentity } from "./git.ts"
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
  // "/" and, for local paths on Windows, "\\"
  const m = /[:/\\]([^/:\\]+)[/\\]([^/\\]+?)(?:\.git)?[/\\]?$/.exec(url.trim())
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
    const p = Bun.spawnSync(["gh", "auth", "token"], { windowsHide: true, stdout: "pipe", stderr: "ignore" })
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
  /** Where this branch forked from what the PR targets (the upstream / remote base), when known locally. */
  fork?: string
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
  const cwd = rt.projectRoot
  const names = (out: string) => out.split("\0").filter(Boolean)
  // all paths relative to the project (like the merge events' files), also in a monorepo subdirectory
  const changed = new Set([
    ...names((await git(cwd, ["diff", "-z", "--name-only", "--relative", "HEAD", "--", "."], { allowFail: true })).stdout),
    ...names((await git(cwd, ["ls-files", "-z", "--others", "--exclude-standard", "--", "."])).stdout),
  ])
  const head = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim()
  const remote = rt.config.github.remote
  const onRemote = (await git(cwd, ["ls-remote", "--heads", remote, head], { allowFail: true })).stdout.trim() !== ""
  const base = head !== "HEAD" && onRemote ? head : (await api<{ default_branch: string }>(rt, "GET", `/repos/${repo.owner}/${repo.repo}`)).default_branch
  // merges land as commits by default (workspace.merge = "commit"): committed-but-unpushed ones count too —
  // measured from the upstream, else from the remote's copy of the PR base (a branch never pushed has no upstream)
  let fork: string | undefined
  for (const ref of ["@{upstream}", `refs/remotes/${remote}/${base}`]) {
    const r = await git(cwd, ["merge-base", "HEAD", ref], { allowFail: true })
    if (r.code === 0 && r.stdout.trim()) {
      fork = r.stdout.trim()
      break
    }
  }
  if (fork) for (const f of names((await git(cwd, ["diff", "-z", "--name-only", "--relative", fork, "HEAD", "--", "."])).stdout)) changed.add(f)
  const files = [...merged].filter((f) => changed.has(f)).sort()
  if (!files.length) throw new Error("nothing to open a PR with: no merged changes from this run are left uncommitted or unpushed")
  const issue = linked.get(rt)
  const firstTask = (() => {
    const id = rt.state.orchestratorId
    const it = id ? rt.state.feed(id).items.find((x) => x.kind === "user" && !x.text.startsWith("[baton]")) : undefined
    return it && it.kind === "user" ? (it.text.split("\n")[0] ?? "") : ""
  })()
  const prTitle = title?.trim() || (issue ? `${issue.title} (#${issue.number})` : firstTask.slice(0, 72) || "Changes from Baton")
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
  return { repo, branch: `baton/${slug(prTitle)}-${rt.runId.slice(-6).toLowerCase()}`, base, title: prTitle, body: lines.join("\n"), files, issue, fork }
}

/** Commit (via a temporary index), push a new branch and open the pull request. */
export async function openPr(rt: Runtime, title?: string): Promise<{ url: string; number: number; branch: string; files: string[]; warning?: string }> {
  if (!(await githubToken(rt))) throw new Error("no GitHub token: set GITHUB_TOKEN (or github.token) — needed to open pull requests")
  const plan = await planPr(rt, title)
  const cwd = rt.projectRoot
  const identity = await userIdentity(cwd)
  const message = `${plan.title}\n\n${plan.issue ? `Closes #${plan.issue.number}\n\n` : ""}Made with Baton.`
  // the plan's files as they are on disk, on top of `parent`
  const build = async (parent: string): Promise<string> => {
    const dir = mkdtempSync(join(tmpdir(), "baton-pr-"))
    const env = { GIT_INDEX_FILE: join(dir, "index"), ...identity }
    try {
      await git(cwd, ["read-tree", parent], { env })
      for (const f of plan.files) {
        if (existsSync(join(cwd, f))) await git(cwd, ["update-index", "--add", "--", f], { env })
        else await git(cwd, ["update-index", "--force-remove", "--", f], { env })
      }
      const tree = (await git(cwd, ["write-tree"], { env })).stdout.trim()
      if (tree === (await git(cwd, ["rev-parse", `${parent}^{tree}`])).stdout.trim()) return parent
      return (await git(cwd, ["commit-tree", tree, "-p", parent, "-m", message], { env })).stdout.trim()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const headSha = (await git(cwd, ["rev-parse", "HEAD"])).stdout.trim()
  let commit = await build(headSha)
  // everything is committed already (Baton's merge commits): one commit with only the plan's files on
  // the fork point — not every unpushed commit on the branch (the user's own included)
  if (commit === headSha && plan.fork) commit = await build(plan.fork)
  // the pushed commit's unpushed ancestry: say so if that carries commits that aren't Baton merges
  let warning: string | undefined
  const log = await git(cwd, ["log", "--format=%h %s", `${commit}^@`, "--not", `--remotes=${rt.config.github.remote}`], { allowFail: true })
  const foreign = log.stdout
    .split("\n")
    .filter(Boolean)
    .filter((l) => !/^\S+ baton: /.test(l))
  if (log.code === 0 && foreign.length)
    warning = `the PR also contains ${foreign.length} unpushed commit${foreign.length === 1 ? "" : "s"} that ${foreign.length === 1 ? "isn't a Baton merge" : "aren't Baton merges"}: ${foreign.slice(0, 5).join("; ")}${foreign.length > 5 ? "; …" : ""}`
  await git(cwd, ["push", rt.config.github.remote, `${commit}:refs/heads/${plan.branch}`])
  const pr = await api<{ html_url: string; number: number }>(rt, "POST", `/repos/${plan.repo.owner}/${plan.repo.repo}/pulls`, {
    title: plan.title,
    head: plan.branch,
    base: plan.base,
    body: plan.body,
    draft: rt.config.github.draft,
  })
  rt.emit({ type: "orch.note", data: { text: `opened pull request #${pr.number}: ${pr.html_url}${warning ? ` — warning: ${warning}` : ""}` } })
  return { url: pr.html_url, number: pr.number, branch: plan.branch, files: plan.files, ...(warning ? { warning } : {}) }
}
