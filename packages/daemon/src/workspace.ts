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
import { basename, dirname, join, resolve } from "node:path"
import type { BatonConfig } from "@batonsh/kernel"
import { stateDir } from "@batonsh/kernel"
import { shellCommand } from "@batonsh/protocol"
import {
  applyPatch,
  branchExists,
  commitTree,
  diffPatch,
  diffStat,
  type FileStat,
  git,
  headCommit,
  isAncestor,
  isGitRepo,
  mergeBase,
  mergeTree,
  repoPrefix,
  repoPrefixSync,
  snapshotCommit,
  snapshotTree,
  treeOf,
} from "./git.ts"

export interface Workspace {
  agentId: string
  agentName: string
  mode: "worktree" | "shared"
  /** The agent's working directory: the worktree root plus the project's prefix inside its repo. */
  path: string
  /** Root of the git worktree (== path unless the project is a subdirectory of its repo). */
  root?: string
  branch?: string
  /** Commit the agent's work is measured against (moves forward after each merge/rebase). */
  base?: string
  /** Paths symlinked/copied in from the project — never part of the agent's changes. */
  exclude: string[]
  files: FileStat[]
  merged: boolean
  /** Latest snapshot commit of the worktree (for conflict checks). */
  snapshot?: string
  /** Git tree hash of the latest snapshot (set by refresh). */
  tree?: string
  /** Ports reserved for this worktree. */
  ports?: number[]
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

export interface MergeOptions {
  onStage?: (s: "verifying") => void
  /** Called inside the merge queue right after the refresh; a returned string blocks the merge with that detail. */
  gate?: (ws: Workspace) => string | undefined
}

export class WorkspaceManager {
  readonly byAgent = new Map<string, Workspace>()
  private queue: Promise<unknown> = Promise.resolve()
  /** Landed merges, newest last (for undo). */
  private history: { agentId: string; agentName: string; before: string; after: string; prevBase?: string; files: FileStat[] }[] = []
  private repo: boolean | undefined
  private loc: { prefix: string; top: string } | undefined

  constructor(
    readonly projectRoot: string,
    private cfg: Cfg,
    private runId: string,
  ) {}

  private allocatePorts(): number[] {
    if (this.cfg.ports <= 0) return []
    const used = new Set([...this.byAgent.values()].flatMap((w) => w.ports ?? []))
    for (let slot = 0; slot < 500; slot++) {
      const block = Array.from({ length: this.cfg.ports }, (_, i) => this.cfg.port_base + slot * 10 + i)
      if (!block.some((p) => used.has(p))) return block
    }
    return []
  }

  /** Environment for an agent working in this workspace (ports, paths). */
  env(agentId: string): Record<string, string> {
    const ws = this.byAgent.get(agentId)
    const out: Record<string, string> = {}
    if (!ws) return out
    ws.ports?.forEach((p, i) => {
      out[`BATON_PORT_${i}`] = String(p)
    })
    if (ws.ports?.length) out.PORT = String(ws.ports[0])
    if (ws.mode === "worktree") out.BATON_WORKTREE = ws.path
    return out
  }

  configure(cfg: Cfg) {
    this.cfg = cfg
  }

  async isRepo(): Promise<boolean> {
    this.repo ??= await isGitRepo(this.projectRoot)
    return this.repo
  }

  /** The project's position inside its repository (it may be a subdirectory, e.g. in a monorepo). */
  private async location(): Promise<{ prefix: string; top: string }> {
    if (!this.loc) {
      const { prefix, cdup } = await repoPrefix(this.projectRoot)
      this.loc = { prefix, top: resolve(this.projectRoot, cdup || ".") }
    }
    return this.loc
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
    let wtRoot = join(root, slug)
    for (let i = 2; existsSync(wtRoot); i++) wtRoot = join(root, `${slug}-${i}`)
    // the name may be reused (agent killed and respawned, resumed run): pick a free branch too
    const branchStem = `baton/${this.runId.slice(-6)}/${slug}`
    let branch = branchStem
    for (let i = 2; await branchExists(this.projectRoot, branch); i++) branch = `${branchStem}-${i}`
    const exclude = this.cfg.link.filter((l) => existsSync(join(this.projectRoot, l)))
    // base = the project as it is now (committed + uncommitted), so agents start from what you see
    const base = await snapshotCommit(this.projectRoot, `baton base for ${agentName}`, undefined, exclude)
    await git(this.projectRoot, ["worktree", "add", "-q", "-b", branch, wtRoot, base])
    // the agent works in the project's subdirectory of the worktree (monorepo package etc.)
    const { prefix } = await this.location()
    const path = prefix ? join(wtRoot, prefix.replace(/\/+$/, "")) : wtRoot
    mkdirSync(path, { recursive: true })
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
    const ws: Workspace = {
      agentId,
      agentName,
      mode: "worktree",
      path,
      root: wtRoot,
      branch,
      base,
      exclude,
      files: [],
      merged: false,
      ports: this.allocatePorts(),
    }
    this.byAgent.set(agentId, ws)
    if (this.cfg.setup) {
      const r = await runShell(this.cfg.setup, path, 600_000).catch((e) => ({ code: -1, output: String(e) }))
      if (r.code !== 0) {
        // don't leak the worktree/branch of a workspace nobody will use
        this.byAgent.delete(agentId)
        await git(this.projectRoot, ["worktree", "remove", "--force", wtRoot], { allowFail: true })
        await git(this.projectRoot, ["branch", "-D", branch], { allowFail: true })
        throw new Error(`workspace setup \`${this.cfg.setup}\` failed: ${tail(r.output)}`)
      }
    }
    return ws
  }

  adopt(agentId: string, agentName: string, path: string, branch?: string, base?: string): Workspace {
    const exclude = [...this.cfg.link, ...this.cfg.copy].filter((l) => existsSync(join(path, l)))
    const loc = existsSync(path) ? repoPrefixSync(path) : undefined
    const root = loc?.cdup ? resolve(path, loc.cdup) : path
    const ws: Workspace = { agentId, agentName, mode: "worktree", path, root, branch, base, exclude, files: [], merged: false, ports: this.allocatePorts() }
    this.byAgent.set(agentId, ws)
    return ws
  }

  /** Recompute the agent's changes (files, +/-) and refresh its snapshot commit. */
  async refresh(agentId: string): Promise<Workspace | undefined> {
    const ws = this.byAgent.get(agentId)
    if (ws?.mode !== "worktree" || !ws.base || !existsSync(ws.path)) return ws
    const tree = await snapshotTree(ws.path, ws.exclude)
    ws.files = await diffStat(ws.path, ws.base, tree)
    ws.snapshot = await commitTree(ws.path, tree, [ws.base], `baton snapshot ${ws.agentName}`)
    ws.tree = tree
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
      const base = await this.pairBase(me, other)
      const r = await mergeTree(this.projectRoot, base, me.snapshot, other.snapshot).catch(() => undefined)
      if (r && !r.clean) out.push({ with: other.agentId, files: r.conflicts.length ? r.conflicts : overlap })
    }
    return out
  }

  /**
   * Merge base for predicting conflicts between two worktrees that may have branched from
   * different project snapshots (or moved forward after merges).
   */
  private async pairBase(me: Workspace, other: Workspace): Promise<string> {
    const mine = me.base as string
    if (!other.base || other.base === mine || (await treeOf(this.projectRoot, mine)) === (await treeOf(this.projectRoot, other.base))) return mine
    // one base contains the other: the older one is the common ancestor
    if (await isAncestor(this.projectRoot, mine, other.base)) return mine
    if (await isAncestor(this.projectRoot, other.base, mine)) return other.base
    return (await mergeBase(this.projectRoot, me.snapshot as string, other.snapshot as string)) ?? mine
  }

  async patch(agentId: string, paths: string[] = []): Promise<string> {
    const ws = await this.refresh(agentId)
    if (!ws?.base || !ws.snapshot) return ""
    return diffPatch(ws.path, ws.base, ws.snapshot, paths, true)
  }

  /** Queue a merge of the agent's changes into the project working tree. */
  merge(agentId: string, opts: MergeOptions = {}): Promise<MergeOutcome> {
    const run = async (): Promise<MergeOutcome> => {
      const ws = await this.refresh(agentId)
      if (!ws) return { status: "failed", files: [], detail: "no workspace" }
      if (ws.mode !== "worktree" || !ws.base || !ws.snapshot || !ws.tree)
        return { status: "failed", files: [], detail: "agent works directly in the project (shared workspace) — nothing to merge" }
      if (ws.files.length === 0) return { status: "empty", files: [] }
      const blocked = opts.gate?.(ws)
      if (blocked) return { status: "failed", files: ws.files, detail: blocked }
      // exactly this tree is what gets verified and merged
      const tree = ws.tree
      if (this.cfg.verify) {
        opts.onStage?.("verifying")
        const r = await runShell(this.cfg.verify, ws.path, 900_000)
        if (r.code !== 0) return { status: "failed", files: ws.files, detail: `verify \`${this.cfg.verify}\` failed:\n${tail(r.output)}` }
        const after = await snapshotTree(ws.path, ws.exclude)
        if (after !== tree) return { status: "failed", files: ws.files, detail: "workspace changed during verify (agent still editing?); retry the merge" }
      }
      const wtRoot = ws.root ?? ws.path
      const { top } = await this.location()
      // commit the agent's work on its branch (in the worktree)
      const commit = await commitTree(ws.path, tree, [(await headCommit(ws.path)) ?? ws.base], `baton: ${ws.agentName}`)
      if (ws.branch) await git(ws.path, ["update-ref", `refs/heads/${ws.branch}`, commit])
      // move the worktree's HEAD *and index* to the new commit; the working tree is untouched
      await git(wtRoot, ["reset", "-q", commit])
      // merge against the project *as it is now*
      const current = await snapshotCommit(this.projectRoot, "baton merge target", undefined, this.cfg.link)
      const merged = await mergeTree(this.projectRoot, ws.base, current, commit)
      if (!merged.clean || !merged.tree)
        return { status: "conflict", files: ws.files, conflicts: merged.conflicts, detail: `conflicts in ${merged.conflicts.join(", ")}` }
      // patch paths are relative to the repository top level, so apply it there
      const patch = await diffPatch(this.projectRoot, current, merged.tree)
      const check = await applyPatch(top, patch, true)
      if (check.code !== 0) return { status: "failed", files: ws.files, detail: `project changed while merging; retry (${check.stderr.trim()})` }
      const applied = await applyPatch(top, patch)
      if (applied.code !== 0) return { status: "failed", files: ws.files, detail: applied.stderr.trim() }
      const files = ws.files
      const afterCommit = await commitTree(this.projectRoot, merged.tree, [current], `baton merged ${ws.agentName}`)
      this.history.push({ agentId, agentName: ws.agentName, before: current, after: afterCommit, prevBase: ws.base, files })
      ws.base = commit
      ws.files = []
      ws.snapshot = undefined
      ws.tree = undefined
      ws.merged = true
      return { status: "merged", commit, files }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p.catch((e) => ({ status: "failed" as const, files: [], detail: e instanceof Error ? e.message : String(e) }))
  }

  /**
   * Undo the most recent merge (optionally: the most recent of one agent). Three-way, so edits
   * made after the merge are kept. The agent's changes become unmerged again in its worktree.
   */
  undoMerge(agentId?: string): Promise<{ ok: boolean; agentName?: string; files: string[]; detail?: string }> {
    const run = async () => {
      const idx = agentId ? this.history.map((h) => h.agentId).lastIndexOf(agentId) : this.history.length - 1
      const h = this.history[idx]
      if (!h) return { ok: false, files: [], detail: "nothing to undo" }
      const now = await snapshotCommit(this.projectRoot, "baton undo source", undefined, this.cfg.link)
      const r = await mergeTree(this.projectRoot, h.after, now, h.before)
      if (!r.clean || !r.tree)
        return {
          ok: false,
          agentName: h.agentName,
          files: r.conflicts,
          detail: `files changed since the merge conflict with the undo: ${r.conflicts.join(", ")}`,
        }
      const applied = await applyPatch((await this.location()).top, await diffPatch(this.projectRoot, now, r.tree))
      if (applied.code !== 0) return { ok: false, agentName: h.agentName, files: [], detail: applied.stderr.trim() }
      this.history.splice(idx, 1)
      const ws = this.byAgent.get(h.agentId)
      if (ws && h.prevBase) {
        ws.base = h.prevBase
        ws.merged = false
      }
      return { ok: true, agentName: h.agentName, files: h.files.map((f) => f.path) }
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  /** Bring the project's current state into the agent's worktree (to resolve conflicts there). */
  async sync(agentId: string): Promise<{ clean: boolean; conflicts: string[] }> {
    const ws = await this.refresh(agentId)
    if (ws?.mode !== "worktree" || !ws.base || !ws.snapshot) return { clean: true, conflicts: [] }
    const current = await snapshotCommit(this.projectRoot, "baton sync source", undefined, this.cfg.link)
    const r = await mergeTree(this.projectRoot, ws.base, ws.snapshot, current)
    if (!r.tree) return { clean: false, conflicts: r.conflicts }
    // write the merged tree (conflict markers included) into the worktree, new base = current project
    const patch = await diffPatch(ws.path, ws.snapshot, r.tree)
    const applied = await applyPatch(ws.root ?? ws.path, patch)
    if (applied.code !== 0) throw new Error(`sync failed: ${applied.stderr.trim()}`)
    ws.base = current
    await this.refresh(agentId)
    return { clean: r.clean, conflicts: r.conflicts }
  }

  /** Remove the agent's worktree according to `workspace.cleanup`. */
  async remove(agentId: string): Promise<{ kept: boolean; reason?: string }> {
    const ws = this.byAgent.get(agentId)
    this.byAgent.delete(agentId)
    if (ws?.mode !== "worktree") return { kept: false }
    let hasChanges = false
    if (this.cfg.cleanup === "never") return { kept: true, reason: "cleanup = never" }
    try {
      if (this.cfg.cleanup === "merged" && existsSync(ws.path) && ws.base) {
        const tree = await snapshotTree(ws.path, ws.exclude)
        hasChanges = (await diffStat(ws.path, ws.base, tree)).length > 0
      }
    } catch (e) {
      // can't tell whether there's unmerged work: never throw it away
      const msg = e instanceof Error ? e.message : String(e)
      // git's own complaint is the last line; the command before it is long and says nothing
      const why = msg.trim().split("\n").filter(Boolean).at(-1) ?? msg
      return { kept: true, reason: `couldn't check ${ws.path} for unmerged work, so it was kept (branch ${ws.branch}): ${why}` }
    }
    if (this.cfg.cleanup === "merged" && hasChanges) return { kept: true, reason: `unmerged changes kept in ${ws.path} (branch ${ws.branch})` }
    const wtRoot = ws.root ?? ws.path
    await git(this.projectRoot, ["worktree", "remove", "--force", wtRoot], { allowFail: true })
    if (ws.branch) await git(this.projectRoot, ["branch", "-D", ws.branch], { allowFail: true })
    try {
      rmdirSync(dirname(wtRoot)) // only succeeds when no other worktrees remain
    } catch {}
    return { kept: false }
  }
}

async function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  const proc = Bun.spawn(shellCommand(cmd), { windowsHide: true, cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, output: `${out}${err}` }
}

function tail(s: string, lines = 30): string {
  return s.trim().split("\n").slice(-lines).join("\n")
}
