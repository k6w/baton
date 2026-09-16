/**
 * Workspaces: every worker gets its own git worktree (outside the repo), branched from a
 * snapshot of the project *as it is right now* — uncommitted changes included. Changes come
 * back through a serialized merge queue: commit in the worktree → optional verify command →
 * three-way merge (git merge-tree) against a fresh snapshot of the project → the result is
 * applied to the user's working tree as a patch (their index is never touched).
 *
 * While agents work, overlapping edits are checked pairwise with merge-tree so conflicts are
 * reported *before* anyone tries to merge.
 */

import { createHash } from "node:crypto"
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmdirSync, symlinkSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import type { BatonConfig } from "@batonsh/kernel"
import { stateDir } from "@batonsh/kernel"
import { applyPatch, commitTree, diffPatch, diffStat, type FileStat, git, headCommit, isGitRepo, mergeTree, snapshotCommit, snapshotTree } from "./git.ts"

export interface Workspace {
  agentId: string
  agentName: string
  mode: "worktree" | "shared"
  path: string
  branch?: string
  /** Commit the agent's work is measured against (moves forward after each merge/rebase). */
  base?: string
  /** Paths symlinked/copied in from the project — never part of the agent's changes. */
  exclude: string[]
  files: FileStat[]
  merged: boolean
  /** Latest snapshot commit of the worktree (for conflict checks). */
  snapshot?: string
}

export interface MergeOutcome {
  status: "merged" | "failed" | "conflict" | "empty"
  commit?: string
  files: FileStat[]
  detail?: string
  conflicts?: string[]
}

type Cfg = BatonConfig["workspace"]

export function worktreeRoot(projectRoot: string, cfg: Cfg): string {
  if (cfg.dir) return cfg.dir
  const h = createHash("sha1").update(projectRoot).digest("hex").slice(0, 8)
  return join(stateDir(), "worktrees", `${basename(projectRoot)}-${h}`)
}

export class WorkspaceManager {
  readonly byAgent = new Map<string, Workspace>()
  private queue: Promise<unknown> = Promise.resolve()
  private repo: boolean | undefined

  constructor(
    readonly projectRoot: string,
    private cfg: Cfg,
    private runId: string,
  ) {}

  async isRepo(): Promise<boolean> {
    this.repo ??= await isGitRepo(this.projectRoot)
    return this.repo
  }

  /** Create the agent's workspace. Falls back to a shared workspace outside git repos. */
  async create(agentId: string, agentName: string, isolation: "worktree" | "shared"): Promise<Workspace> {
    if (isolation === "shared" || !(await this.isRepo())) {
      const ws: Workspace = { agentId, agentName, mode: "shared", path: this.projectRoot, exclude: [], files: [], merged: false }
      this.byAgent.set(agentId, ws)
      return ws
    }
    const root = worktreeRoot(this.projectRoot, this.cfg)
    mkdirSync(root, { recursive: true })
    const slug = agentName.replace(/[^\w.-]+/g, "-")
    let path = join(root, slug)
    for (let i = 2; existsSync(path); i++) path = join(root, `${slug}-${i}`)
    const exclude = this.cfg.link.filter((l) => existsSync(join(this.projectRoot, l)))
    // base = the project as it is now (committed + uncommitted), so agents start from what you see
    const base = await snapshotCommit(this.projectRoot, `baton base for ${agentName}`, undefined, exclude)
    const branch = `baton/${this.runId.slice(-6)}/${slug}`
    await git(this.projectRoot, ["worktree", "add", "-q", "-b", branch, path, base])
    for (const l of exclude) {
      const target = join(path, l)
      if (!existsSync(target)) symlinkSync(join(this.projectRoot, l), target, lstatSync(join(this.projectRoot, l)).isDirectory() ? "dir" : "file")
    }
    for (const f of this.cfg.copy) {
      const src = join(this.projectRoot, f)
      if (existsSync(src) && !existsSync(join(path, f))) {
        copyFileSync(src, join(path, f))
        exclude.push(f)
      }
    }
    const ws: Workspace = { agentId, agentName, mode: "worktree", path, branch, base, exclude, files: [], merged: false }
    this.byAgent.set(agentId, ws)
    if (this.cfg.setup) {
      const r = await runShell(this.cfg.setup, path, 600_000)
      if (r.code !== 0) throw new Error(`workspace setup \`${this.cfg.setup}\` failed: ${tail(r.output)}`)
    }
    return ws
  }

  /** Recompute the agent's changes (files, +/-) and refresh its snapshot commit. */
  async refresh(agentId: string): Promise<Workspace | undefined> {
    const ws = this.byAgent.get(agentId)
    if (!ws || ws.mode !== "worktree" || !ws.base || !existsSync(ws.path)) return ws
    const tree = await snapshotTree(ws.path, ws.exclude)
    ws.files = await diffStat(ws.path, ws.base, tree)
    ws.snapshot = await commitTree(ws.path, tree, [ws.base], `baton snapshot ${ws.agentName}`)
    if (ws.files.length) ws.merged = false
    return ws
  }

  /** Conflicts between this agent's changes and every other worktree's (predicted with merge-tree). */
  async conflictsFor(agentId: string): Promise<{ with: string; files: string[] }[]> {
    const me = this.byAgent.get(agentId)
    if (!me?.snapshot || !me.base || !me.files.length) return []
    const mine = new Set(me.files.map((f) => f.path))
    const out: { with: string; files: string[] }[] = []
    for (const other of this.byAgent.values()) {
      if (other.agentId === agentId || other.mode !== "worktree" || !other.snapshot || other.merged) continue
      const overlap = other.files.map((f) => f.path).filter((p) => mine.has(p))
      if (!overlap.length) continue
      // both branched from (possibly different) project snapshots: use my base as the merge base
      const r = await mergeTree(this.projectRoot, me.base, me.snapshot, other.snapshot).catch(() => undefined)
      if (r && !r.clean) out.push({ with: other.agentId, files: r.conflicts.length ? r.conflicts : overlap })
    }
    return out
  }

  async patch(agentId: string, paths: string[] = []): Promise<string> {
    const ws = await this.refresh(agentId)
    if (!ws?.base || !ws.snapshot) return ""
    return diffPatch(ws.path, ws.base, ws.snapshot, paths)
  }

  /** Queue a merge of the agent's changes into the project working tree. */
  merge(agentId: string, onStage?: (s: "verifying") => void): Promise<MergeOutcome> {
    const run = async (): Promise<MergeOutcome> => {
      const ws = await this.refresh(agentId)
      if (!ws) return { status: "failed", files: [], detail: "no workspace" }
      if (ws.mode !== "worktree" || !ws.base || !ws.snapshot)
        return { status: "failed", files: [], detail: "agent works directly in the project (shared workspace) — nothing to merge" }
      if (ws.files.length === 0) return { status: "empty", files: [] }
      if (this.cfg.verify) {
        onStage?.("verifying")
        const r = await runShell(this.cfg.verify, ws.path, 900_000)
        if (r.code !== 0) return { status: "failed", files: ws.files, detail: `verify \`${this.cfg.verify}\` failed:\n${tail(r.output)}` }
      }
      // commit the agent's work on its branch (in the worktree)
      const commit = await commitTree(ws.path, await snapshotTree(ws.path, ws.exclude), [(await headCommit(ws.path)) ?? ws.base], `baton: ${ws.agentName}`)
      await git(ws.path, ["update-ref", `refs/heads/${ws.branch}`, commit])
      await git(ws.path, ["reset", "-q", "--soft", commit]) // keep the worktree's HEAD on the new commit
      // merge against the project *as it is now*
      const current = await snapshotCommit(this.projectRoot, "baton merge target", undefined, this.cfg.link)
      const merged = await mergeTree(this.projectRoot, ws.base, current, commit)
      if (!merged.clean || !merged.tree)
        return { status: "conflict", files: ws.files, conflicts: merged.conflicts, detail: `conflicts in ${merged.conflicts.join(", ")}` }
      const patch = await diffPatch(this.projectRoot, current, merged.tree)
      const check = await applyPatch(this.projectRoot, patch, true)
      if (check.code !== 0) return { status: "failed", files: ws.files, detail: `project changed while merging; retry (${check.stderr.trim()})` }
      const applied = await applyPatch(this.projectRoot, patch)
      if (applied.code !== 0) return { status: "failed", files: ws.files, detail: applied.stderr.trim() }
      const files = ws.files
      ws.base = commit
      ws.files = []
      ws.snapshot = undefined
      ws.merged = true
      return { status: "merged", commit, files }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p.catch((e) => ({ status: "failed" as const, files: [], detail: e instanceof Error ? e.message : String(e) }))
  }

  /** Bring the project's current state into the agent's worktree (to resolve conflicts there). */
  async sync(agentId: string): Promise<{ clean: boolean; conflicts: string[] }> {
    const ws = await this.refresh(agentId)
    if (!ws || ws.mode !== "worktree" || !ws.base || !ws.snapshot) return { clean: true, conflicts: [] }
    const current = await snapshotCommit(this.projectRoot, "baton sync source", undefined, this.cfg.link)
    const r = await mergeTree(this.projectRoot, ws.base, ws.snapshot, current)
    if (!r.tree) return { clean: false, conflicts: r.conflicts }
    // write the merged tree (conflict markers included) into the worktree, new base = current project
    const patch = await diffPatch(ws.path, ws.snapshot, r.tree)
    const applied = await applyPatch(ws.path, patch)
    if (applied.code !== 0) throw new Error(`sync failed: ${applied.stderr.trim()}`)
    ws.base = current
    await this.refresh(agentId)
    return { clean: r.clean, conflicts: r.conflicts }
  }

  /** Remove the agent's worktree according to `workspace.cleanup`. */
  async remove(agentId: string): Promise<{ kept: boolean; reason?: string }> {
    const ws = this.byAgent.get(agentId)
    this.byAgent.delete(agentId)
    if (!ws || ws.mode !== "worktree") return { kept: false }
    let hasChanges = false
    try {
      if (existsSync(ws.path) && ws.base) {
        const tree = await snapshotTree(ws.path, ws.exclude)
        hasChanges = (await diffStat(ws.path, ws.base, tree)).length > 0
      }
    } catch {}
    const keep = this.cfg.cleanup === "never" || (this.cfg.cleanup === "merged" && hasChanges)
    if (keep) return { kept: true, reason: hasChanges ? `unmerged changes kept in ${ws.path} (branch ${ws.branch})` : "cleanup = never" }
    await git(this.projectRoot, ["worktree", "remove", "--force", ws.path], { allowFail: true })
    if (ws.branch) await git(this.projectRoot, ["branch", "-D", ws.branch], { allowFail: true })
    try {
      rmdirSync(dirname(ws.path)) // only succeeds when no other worktrees remain
    } catch {}
    return { kept: false }
  }
}

async function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(["sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, output: `${out}${err}` }
}

function tail(s: string, lines = 30): string {
  return s.trim().split("\n").slice(-lines).join("\n")
}
