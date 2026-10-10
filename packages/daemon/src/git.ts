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
/**
 * Dependency and tool-cache folders are never an agent's work, even when a repo forgot to ignore
 * them. A reviewer running the tests (vitest writing node_modules/.vite, pytest __pycache__)
 * must not count as "changed after the review".
 */
export const CACHE_DIRS = ["node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", ".parcel-cache", ".gradle", ".venv"]
const CACHE_PATHSPECS = [...CACHE_DIRS.map((d) => `:(exclude,glob)**/${d}/**`), ":(exclude,glob)**/.DS_Store"]

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
    await git(cwd, ["add", "-A", "--", ".", ...needed.map((e) => `:(exclude)${e}`), ...CACHE_PATHSPECS], { env })
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

/**
 * numstat between two tree-ish objects. Binary files count as 1/1. Limited to (and paths relative
 * to) `cwd` when it is a subdirectory of the repository. NUL-separated, so any path name works.
 */
export async function diffStat(cwd: string, from: string, to: string): Promise<FileStat[]> {
  const r = await git(cwd, ["diff-tree", "-r", "-z", "--numstat", "--no-renames", "--relative", from, to])
  const out: FileStat[] = []
  for (const rec of r.stdout.split("\0")) {
    const m = /^(\S+)\t(\S+)\t([\s\S]+)$/.exec(rec)
    if (!m) continue
    out.push({ path: m[3] as string, added: m[1] === "-" ? 1 : Number(m[1]), removed: m[2] === "-" ? 1 : Number(m[2]) })
  }
  return out
}

/**
 * Patch between two tree-ish objects. Paths in the patch are relative to the repository top
 * level (what `git apply` expects); with `relative`, limited to and relative to `cwd` (for display).
 * Pathspecs in `paths` are relative to `cwd`.
 */
export async function diffPatch(cwd: string, from: string, to: string, paths: string[] = [], relative = false): Promise<string> {
  return (await git(cwd, ["diff", "--binary", "--no-color", ...(relative ? ["--relative"] : []), from, to, "--", ...paths])).stdout
}

/** Location of `cwd` inside its repository: `prefix` ("" or "sub/dir/") and `cdup` ("" or "../../"). */
export async function repoPrefix(cwd: string): Promise<{ prefix: string; cdup: string }> {
  const r = await git(cwd, ["rev-parse", "--show-prefix", "--show-cdup"])
  const [prefix = "", cdup = ""] = r.stdout.split("\n")
  return { prefix: prefix.trim(), cdup: cdup.trim() }
}

export function repoPrefixSync(cwd: string): { prefix: string; cdup: string } | undefined {
  const r = Bun.spawnSync(["git", "rev-parse", "--show-prefix", "--show-cdup"], { cwd, stdout: "pipe", stderr: "ignore", stdin: "ignore" })
  if (r.exitCode !== 0) return undefined
  const [prefix = "", cdup = ""] = r.stdout.toString().split("\n")
  return { prefix: prefix.trim(), cdup: cdup.trim() }
}

export async function branchExists(cwd: string, branch: string): Promise<boolean> {
  return (await git(cwd, ["show-ref", "--verify", "-q", `refs/heads/${branch}`], { allowFail: true })).code === 0
}

export async function isAncestor(cwd: string, ancestor: string, of: string): Promise<boolean> {
  return (await git(cwd, ["merge-base", "--is-ancestor", ancestor, of], { allowFail: true })).code === 0
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
  const r = await git(cwd, ["merge-base", a, b], { allowFail: true })
  return r.code === 0 ? r.stdout.trim() || undefined : undefined
}

export async function treeOf(cwd: string, commit: string): Promise<string | undefined> {
  const r = await git(cwd, ["rev-parse", "--verify", "-q", `${commit}^{tree}`], { allowFail: true })
  return r.code === 0 ? r.stdout.trim() : undefined
}

export interface MergeTreeResult {
  clean: boolean
  tree?: string
  conflicts: string[]
}

/**
 * Three-way merge of commits without touching any working tree (git ≥ 2.38). Conflict paths are
 * relative to `cwd` (git prints them that way from a subdirectory).
 */
export async function mergeTree(cwd: string, base: string, ours: string, theirs: string): Promise<MergeTreeResult> {
  const r = await git(cwd, ["merge-tree", "--write-tree", "-z", "--name-only", "--no-messages", `--merge-base=${base}`, ours, theirs], { allowFail: true })
  const lines = r.stdout.split("\0").filter(Boolean)
  if (r.code === 0) return { clean: true, tree: lines[0], conflicts: [] }
  if (r.code === 1) return { clean: false, tree: lines[0], conflicts: [...new Set(lines.slice(1))] }
  throw new Error(`git merge-tree failed: ${r.stderr.trim()}`)
}

/** Apply a patch to a working tree only (never the index). */
export async function applyPatch(cwd: string, patch: string, check = false): Promise<GitResult> {
  if (!patch.trim()) return { code: 0, stdout: "", stderr: "" }
  return git(cwd, ["apply", "--binary", "--whitespace=nowarn", ...(check ? ["--check"] : []), "-"], { input: patch, allowFail: true })
}
