/**
 * Low-level git plumbing for workspaces. Everything that reads the *working tree* goes
 * through a temporary index (GIT_INDEX_FILE), so the user's own staging area is never
 * touched; commits are created with commit-tree and a fixed identity, so this works even
 * when the user has no git identity configured.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const IDENTITY = {
  GIT_AUTHOR_NAME: "baton",
  GIT_AUTHOR_EMAIL: "baton@localhost",
  GIT_COMMITTER_NAME: "baton",
  GIT_COMMITTER_EMAIL: "baton@localhost",
}

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; allowFail?: boolean } = {}): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...IDENTITY, GIT_TERMINAL_PROMPT: "0", ...opts.env },
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  if (code !== 0 && !opts.allowFail) throw new Error(`git ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`)
  return { code, stdout, stderr }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"], { allowFail: true })
  return r.code === 0 && r.stdout.trim() === "true"
}

export async function headCommit(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })
  return r.code === 0 ? r.stdout.trim() : undefined
}

/** Tree object of the current working tree (tracked + untracked, honoring .gitignore). */
export async function snapshotTree(cwd: string, exclude: string[] = []): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "baton-idx-"))
  const env = { GIT_INDEX_FILE: join(dir, "index") }
  try {
    const head = await headCommit(cwd)
    if (head) await git(cwd, ["read-tree", head], { env })
    // symlinked dependency dirs are files to git (".gitignore: node_modules/" won't match) — exclude them
    // explicitly, but only where they aren't ignored already (git rejects pathspecs for ignored paths)
    const needed: string[] = []
    for (const e of exclude) if ((await git(cwd, ["check-ignore", "-q", e], { allowFail: true })).code !== 0) needed.push(e)
    await git(cwd, ["add", "-A", "--", ".", ...needed.map((e) => `:(exclude)${e}`)], { env })
    return (await git(cwd, ["write-tree"], { env })).stdout.trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function commitTree(cwd: string, tree: string, parents: string[], message: string): Promise<string> {
  const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", message]
  return (await git(cwd, args)).stdout.trim()
}

/** Commit object capturing the working tree right now (parent: HEAD, if any). */
export async function snapshotCommit(cwd: string, message: string, parent?: string, exclude: string[] = []): Promise<string> {
  const tree = await snapshotTree(cwd, exclude)
  const p = parent ?? (await headCommit(cwd))
  return commitTree(cwd, tree, p ? [p] : [], message)
}

export interface FileStat {
  path: string
  added: number
  removed: number
}

/** numstat between two tree-ish objects. Binary files count as 1/1. */
export async function diffStat(cwd: string, from: string, to: string): Promise<FileStat[]> {
  const r = await git(cwd, ["diff-tree", "-r", "--numstat", "--no-renames", from, to])
  const out: FileStat[] = []
  for (const line of r.stdout.split("\n")) {
    const m = /^(\S+)\t(\S+)\t(.+)$/.exec(line)
    if (!m) continue
    out.push({ path: m[3] as string, added: m[1] === "-" ? 1 : Number(m[1]), removed: m[2] === "-" ? 1 : Number(m[2]) })
  }
  return out
}

export async function diffPatch(cwd: string, from: string, to: string, paths: string[] = []): Promise<string> {
  return (await git(cwd, ["diff", "--binary", "--no-color", from, to, "--", ...paths])).stdout
}

export interface MergeTreeResult {
  clean: boolean
  tree?: string
  conflicts: string[]
}

/** Three-way merge of commits without touching any working tree (git ≥ 2.38). */
export async function mergeTree(cwd: string, base: string, ours: string, theirs: string): Promise<MergeTreeResult> {
  const r = await git(cwd, ["merge-tree", "--write-tree", "--name-only", "--no-messages", `--merge-base=${base}`, ours, theirs], { allowFail: true })
  const lines = r.stdout.split("\n").filter(Boolean)
  if (r.code === 0) return { clean: true, tree: lines[0], conflicts: [] }
  if (r.code === 1) return { clean: false, tree: lines[0], conflicts: [...new Set(lines.slice(1))] }
  throw new Error(`git merge-tree failed: ${r.stderr.trim()}`)
}

/** Apply a patch to a working tree only (never the index). */
export async function applyPatch(cwd: string, patch: string, check = false): Promise<GitResult> {
  if (!patch.trim()) return { code: 0, stdout: "", stderr: "" }
  return git(cwd, ["apply", "--binary", "--whitespace=nowarn", ...(check ? ["--check"] : []), "-"], { input: patch, allowFail: true })
}
