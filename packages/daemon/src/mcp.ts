/**
 * Baton MCP server — injected into every agent session so heterogeneous agents can talk
 * to each other and the orchestrator can spawn/steer workers. Stateless Streamable HTTP;
 * the per-agent token in the URL path is the caller's identity.
 */

import { addNote, formatAgentLoad, formatCost, readSkill, roleFor, searchNotes } from "@batonsh/kernel"
import { BATON_VERSION } from "@batonsh/protocol"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"
import { hostAllowed, misdirected } from "./host-guard.ts"
import type { AgentRuntime, Runtime } from "./runtime.ts"
import { pickForTask } from "./scores.ts"

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean }

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] })
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true })

async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn()
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

/**
 * How long a blocking tool call (wait_for_results, read_inbox wait_s) may be held open. Many MCP clients give up
 * on a request after ~60 s (the MCP SDK default) unless the server sends progress notifications;
 * the call then reports "timed out" to the model while the server keeps waiting and consumes the
 * results into a response nobody reads. So: clients that asked for progress (a progressToken)
 * get keep-alive notifications and the full timeout; adapters known to allow long tool calls
 * (codex: tool_timeout_sec=1900 in adapters/codex/src/config.ts; mock: plain fetch, no timeout)
 * are held for the full timeout; everyone else (Claude Code included: its tool calls time out
 * after ~60 s without progress) gets an honest "still waiting" reply before their client would
 * time out. Mutable for tests.
 */
export const waitTuning = {
  progressMs: 15_000,
  shortHoldMs: 50_000,
  longHoldAdapters: new Set(["codex", "mock"]),
}

const secs = (ms: number) => Math.round(ms / 1000)

/** How long this caller's request may be held: the full `wantMs`, or a slice its client survives. */
function holdFor(adapter: string, progressToken: unknown, wantMs: number): number {
  const long = progressToken !== undefined || waitTuning.longHoldAdapters.has(adapter)
  return long ? wantMs : Math.min(wantMs, waitTuning.shortHoldMs)
}

/** Send `notifications/progress` every waitTuning.progressMs while a long call is held (keeps the client's request alive). */
function keepAlive(
  extra: { _meta?: { progressToken?: string | number }; sendNotification: (n: never) => Promise<void> } | undefined,
  total: number,
  message: (elapsedMs: number) => string,
): () => void {
  const progressToken = extra?._meta?.progressToken
  if (!extra || progressToken === undefined) return () => {}
  const started = performance.now()
  const t = setInterval(() => {
    const el = performance.now() - started
    void extra
      .sendNotification({ method: "notifications/progress", params: { progressToken, progress: secs(el), total: secs(total), message: message(el) } } as never)
      .catch(() => {})
  }, waitTuning.progressMs)
  return () => clearInterval(t)
}
const ago = (ts: number) => {
  const s = Math.max(0, secs(Date.now() - ts))
  return s < 120 ? `${s}s` : `${Math.round(s / 60)}m`
}

/** Per-file `+added −removed` summary of a unified diff (git format). */
export function diffStat(diff: string): { path: string; added: number; removed: number; binary: boolean }[] {
  const files: { path: string; added: number; removed: number; binary: boolean }[] = []
  let cur: (typeof files)[number] | undefined
  let inHunk = false
  for (const line of diff.split("\n")) {
    const head = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
    if (head) {
      cur = { path: head[2] ?? head[1] ?? "?", added: 0, removed: 0, binary: false }
      files.push(cur)
      inHunk = false
      continue
    }
    if (!cur) continue
    if (line.startsWith("@@")) {
      inHunk = true
      continue
    }
    // `--- a/x` / `+++ b/x` are file headers only before the first hunk; inside one they're content
    if (!inHunk && (line.startsWith("+++ ") || line.startsWith("--- "))) continue
    if (line.startsWith("Binary files ")) cur.binary = true
    else if (line.startsWith("+")) cur.added++
    else if (line.startsWith("-")) cur.removed++
  }
  return files
}

/**
 * One page of `text`: at most `maxBytes` UTF-8 bytes from byte `offset`, ending on a line
 * boundary when possible (never inside a character). `next` is the offset of the following page.
 */
export function pageText(text: string, offset: number, maxBytes: number): { page: string; next: number | undefined; total: number } {
  const buf = Buffer.from(text, "utf8")
  const total = buf.length
  const start = Math.min(Math.max(0, offset), total)
  let end = Math.min(total, start + maxBytes)
  if (end < total) {
    const nl = buf.lastIndexOf(0x0a, end - 1)
    if (nl >= start) end = nl + 1
    // no newline in the window: cut, but not inside a multi-byte character
    else while (end > start && ((buf[end] ?? 0) & 0xc0) === 0x80) end--
  }
  return { page: buf.subarray(start, end).toString("utf8"), next: end < total ? end : undefined, total }
}

export function buildMcpServer(rt: Runtime, caller: AgentRuntime, signal?: AbortSignal): McpServer {
  const server = new McpServer({ name: "baton", version: BATON_VERSION }, { instructions: "Baton multi-agent coordination tools." })
  const me = caller.info.agentId
  const isLead = !!caller.info.isOrchestrator

  server.registerTool(
    "send_message",
    {
      description:
        "Send a message to another agent in this Baton session. `to` is an agent name (e.g. codex-2), 'orchestrator', '*' for everyone, or 'role:<role>'.",
      inputSchema: {
        to: z.string().describe("Recipient agent name, 'orchestrator', '*', or 'role:<name>'"),
        body: z.string().describe("Message text"),
        delivery: z
          .enum(["queue", "steer", "interrupt"])
          .optional()
          .describe("queue (default): delivered when the recipient is idle; steer: injected into its current turn; interrupt: stop it first"),
        kind: z.enum(["chat", "request", "reply"]).optional(),
      },
    },
    (a) => guard(() => ok(`sent (${rt.send({ from: me, to: a.to, body: a.body, delivery: a.delivery, kind: a.kind })})`)),
  )

  server.registerTool(
    "read_inbox",
    {
      description: "Read (and consume) messages addressed to you. Optionally wait up to `wait_s` seconds for one to arrive.",
      inputSchema: { wait_s: z.number().min(0).max(600).optional() },
    },
    (a, extra) =>
      guard(async () => {
        if (!a.wait_s) {
          const msgs = rt.drainInbox(me)
          return ok(msgs.length ? msgs.map((m) => `from ${m.fromName} [${m.kind}]:\n${m.body}`).join("\n\n---\n\n") : "(inbox empty)")
        }
        const started = performance.now()
        const wantMs = a.wait_s * 1000
        const holdMs = holdFor(caller.info.adapter, extra?._meta?.progressToken, wantMs)
        const stop = keepAlive(extra, wantMs, (el) => `waiting ${secs(el)}s for a message`)
        let msgs: Awaited<ReturnType<typeof rt.waitInbox>>
        try {
          msgs = await rt.waitInbox(me, holdMs, undefined, signal)
        } finally {
          stop()
        }
        if (msgs.length === 0) {
          const el = performance.now() - started
          return ok(
            el + 50 < wantMs
              ? `(inbox empty after ${secs(el)}s of wait_s ${a.wait_s}: returned early so your MCP client doesn't time out (~${secs(holdMs)}s per call) — call read_inbox again to keep waiting)`
              : `(inbox empty after ${secs(el)}s)`,
          )
        }
        return ok(msgs.map((m) => `from ${m.fromName} [${m.kind}]:\n${m.body}`).join("\n\n---\n\n"))
      }),
  )

  server.registerTool(
    "list_agents",
    { description: "List agents in this session with adapter, model, status, task label, progress and cost.", inputSchema: {} },
    () =>
      guard(() => {
        const rows = [...rt.state.agents.values()]
          .filter((a) => a.status !== "exited")
          .map((a) => {
            const pct = a.progress !== undefined ? ` ${Math.round(a.progress * 100)}%` : ""
            const you = a.agentId === me ? " (you)" : ""
            const row = `- ${a.name}${you}: ${a.adapter}${a.model ? `/${a.model}` : ""} · ${a.status}${pct}${a.label ? ` · "${a.label}"` : ""} · ${formatAgentLoad(a)} · ${formatCost(a.usage.costUsd)}`
            const asks = [...rt.state.approvals.values()].filter((p) => p.agentId === a.agentId)
            return asks.length
              ? `${row}\n${asks.map((p) => `    awaiting approval [${p.requestId}] ${p.title}${p.kind ? ` (${p.kind})` : ""} · ${ago(p.ts)} ago`).join("\n")}`
              : row
          })
        return ok(rows.join("\n") || "(no agents)")
      }),
  )

  server.registerTool(
    "report_progress",
    {
      description: "Report your progress to whoever assigned your task (shown live in the Baton UI).",
      inputSchema: { percent: z.number().min(0).max(100), note: z.string().optional() },
    },
    (a) =>
      guard(() => {
        const target = caller.info.parentId ?? rt.orchestrator()?.info.agentId
        if (!target || target === me) return ok("noted")
        rt.send({ from: me, to: target, body: `${Math.round(a.percent)}% done${a.note ? ` — ${a.note}` : ""}`, kind: "progress" })
        return ok("reported")
      }),
  )

  server.registerTool(
    "claim_files",
    {
      description:
        "Claim files or globs you are about to change so other agents keep off them (e.g. ['src/auth/**', 'README.md']). Fails if someone else holds an exclusive claim.",
      inputSchema: {
        paths: z.array(z.string()).min(1),
        exclusive: z.boolean().optional(),
        ttl_s: z.number().int().min(60).max(86400).optional(),
      },
    },
    (a) =>
      guard(() => {
        const r = rt.collab.claim(me, a.paths, a.exclusive ?? true, a.ttl_s ?? 1800)
        if (!r.ok)
          return fail(`already claimed: ${r.conflicts.map((c) => `${c.globs.join(", ")} by ${c.agent}`).join("; ")} — coordinate with them via send_message`)
        return ok(`claimed ${a.paths.join(", ")}${r.conflicts.length ? ` (shared with ${r.conflicts.map((c) => c.agent).join(", ")})` : ""}`)
      }),
  )

  server.registerTool(
    "release_files",
    { description: "Release your file claims (all of them, or the given paths).", inputSchema: { paths: z.array(z.string()).optional() } },
    (a) => guard(() => ok(`released ${rt.collab.release(me, a.paths)} claim(s)`)),
  )

  server.registerTool(
    "my_changes",
    { description: "Summary of the files you changed in your workspace (not yet merged into the project).", inputSchema: {} },
    () =>
      guard(async () => {
        const ws = await rt.collab.refresh(me)
        if (!ws) return ok("no workspace")
        if (ws.mode === "shared") return ok(`you work directly in ${ws.path} (shared workspace)`)
        return ok(ws.files.length ? ws.files.map((f) => `${f.path} +${f.added} −${f.removed}`).join("\n") : "no changes yet")
      }),
  )

  server.registerTool(
    "submit_review",
    {
      description: "Submit your verdict for the review you were asked to do.",
      inputSchema: {
        verdict: z.enum(["approve", "changes_requested"]),
        notes: z.string().describe("Specific, actionable findings (or why it is good to merge)"),
      },
    },
    (a) => guard(() => ok(`review submitted for ${rt.collab.submitReview(me, a.verdict, a.notes).author}`)),
  )

  // ───────────── skills and team notes (every agent; each can be switched off in [features]) ─────────────
  const f = rt.config.features
  if (f.skills) {
    server.registerTool(
      "list_skills",
      { description: "List the skills available in this project (name and what each is for). Load one with load_skill.", inputSchema: {} },
      () =>
        guard(() => {
          const skills = [...rt.skills().values()]
          if (!skills.length) return ok("(no skills: add folders with a SKILL.md to .baton/skills/)")
          return ok(skills.map((x) => `- ${x.name}: ${x.description}`).join("\n"))
        }),
    )

    server.registerTool(
      "load_skill",
      {
        description: "Load a skill's full instructions (and the list of files it comes with). Use it before the part of the work the skill covers.",
        inputSchema: { name: z.string() },
      },
      (a) =>
        guard(() => {
          const skill = rt.skills().get(a.name.toLowerCase())
          if (!skill) return fail(`no skill "${a.name}" (list_skills shows them)`)
          rt.emit({ type: "log", data: { level: "info", message: `[${caller.info.name}] loaded skill ${skill.name}` } }, me)
          return ok(readSkill(skill))
        }),
    )
  }

  if (rt.config.features.notes) {
    server.registerTool(
      "note",
      {
        description:
          "Save a short fact about this project for the whole team (and future agents): conventions, gotchas, commands, decisions. One sentence; not progress updates.",
        inputSchema: { text: z.string().describe("e.g. 'integration tests need DB_URL=postgres://localhost/test'") },
      },
      (a) => guard(() => ok(addNote(rt.projectRoot, caller.info.name, a.text) ? "noted" : "already noted")),
    )
    server.registerTool(
      "recall",
      {
        description: "Search the team notes (facts earlier agents recorded about this project). Without a query: all of them.",
        inputSchema: { query: z.string().optional() },
      },
      (a) =>
        guard(() => {
          const found = searchNotes(rt.projectRoot, a.query)
          return ok(found.length ? found.map((n) => `- ${n.text}${n.author ? ` (${n.author})` : ""}`).join("\n") : "(no matching notes)")
        }),
    )
  }

  if (isLead || rt.config.budget.max_depth > 0) {
    server.registerTool(
      "spawn_agent",
      {
        description: (() => {
          const roles = [...rt.roles().values()]
          const skills = [...rt.skills().values()]
          return `Start a new coding agent. adapter: one of ${rt.registry
            .list()
            .map((x) => x.id)
            .join(
              ", ",
            )} or a configured profile (${Object.keys(rt.config.agents).join(", ") || "none"}); omitted → the role's adapter or ${rt.config.defaults.worker}. With \`task\` it starts at once and its result comes back to you.
${
  roles.length ? `\nRoles (role:): ${roles.map((r) => `${r.name}${r.access === "read-only" ? " [read-only]" : ""} — ${r.description}`).join("; ")}.` : ""
}${skills.length ? `\nSkills (skills:): ${skills.map((x) => `${x.name} — ${x.description}`).join("; ")}.` : ""}
Give each worker what it needs to succeed: ${[f.roles && "a role", "the files it owns", f.acceptance && "an acceptance command that proves it is done", "and instructions only it needs"].filter(Boolean).join(", ")}.`
        })(),
        inputSchema: {
          adapter: z.string().optional().describe("Which agent CLI (omit to use the role's or the default worker)"),
          task: z.string().optional(),
          name: z.string().optional(),
          label: z.string().optional().describe("2-3 word task label shown on the agent's card"),
          model: z.string().optional(),
          ...(f.roles
            ? {
                role: z
                  .string()
                  .optional()
                  .describe("A role from the list (tester, reviewer, debugger, …): instructions, access and defaults for this kind of work"),
              }
            : {}),
          instructions: z.string().optional().describe("Extra instructions for this agent only (conventions, constraints, context it needs)"),
          ...(f.skills ? { skills: z.array(z.string()).optional().describe("Skills it starts with (it loads them with load_skill)") } : {}),
          files: z.array(z.string()).optional().describe("Files / globs it owns: claimed for it so others are warned off"),
          ...(f.acceptance
            ? { acceptance: z.string().optional().describe("A command that must pass before its result counts (e.g. 'bun test src/auth'). Baton runs it.") }
            : {}),
          access: z.enum(["read-only", "write"]).optional().describe("read-only: may not edit files (reviews, research, audits)"),
          count: z.number().int().min(1).max(10).optional().describe("Spawn several identical agents"),
          task_id: z.string().optional().describe("Plan task this agent works on (from plan_tasks)"),
          tier: z
            .enum(["small", "medium", "large"])
            .optional()
            .describe("Task difficulty → model via [routing]: small for mechanical edits, large for hard reasoning"),
          reason: z.string().optional().describe("Required when count > 1: why parallel agents help here (e.g. '3 independent modules, no shared files')"),
          isolation: z
            .enum(["worktree", "shared"])
            .optional()
            .describe("worktree (default): own git worktree, merge later · shared: edit the project directly"),
        },
      },
      (a) =>
        guard(async () => {
          const n = a.count ?? 1
          if (n > 1 && !a.reason?.trim())
            return fail("count > 1 needs a reason: say why parallel agents help (independent pieces, no shared files). Prefer one agent for coupled work.")
          // above the soft limit, the user decides (never the policy)
          const live = [...rt.agents.values()].filter((x) => !x.closing && !x.info.isOrchestrator).length
          const soft = rt.config.budget.soft_max_agents
          if (soft > 0 && live + n > soft) {
            const ok = await rt.askUser(
              me,
              `start ${n} more ${a.adapter} agent${n === 1 ? "" : "s"} (${live + n} total)?`,
              `${a.reason ?? "no reason given"}${a.task ? `\ntask: ${a.task.slice(0, 300)}` : ""}`,
              undefined,
              signal,
            )
            if (!ok) return fail(`the user declined starting more agents (${live} running). Reuse existing agents (send_message) or do it with fewer.`)
          }
          const names: string[] = []
          for (let i = 0; i < n; i++) {
            const info = await rt.spawn({
              adapter: a.adapter ?? "",
              instructions: a.instructions,
              skills: a.skills,
              files: a.files,
              acceptance: a.acceptance,
              access: a.access,
              name: a.name && n > 1 ? `${a.name}-${i + 1}` : a.name,
              label: a.label,
              model: a.model,
              role: a.role,
              parentId: me,
              prompt: a.task,
              taskId: a.task_id,
              tier: a.tier,
              isolation: a.isolation,
            })
            names.push(info.name)
          }
          const roleNote = a.role && !rt.roles().has(a.role.toLowerCase()) ? ` (note: no role "${a.role}" is defined; list_roles shows them)` : ""
          return ok(`spawned: ${names.join(", ")}${a.task ? " (task dispatched)" : ""}${roleNote}`)
        }),
    )
  }

  if (isLead) {
    if (f.roles)
      server.registerTool(
        "list_roles",
        {
          description: "The roles you can give workers (spawn_agent role:), with what each is for, its access, model size, acceptance check and skills.",
          inputSchema: {},
        },
        () =>
          guard(() =>
            ok(
              [...rt.roles().values()]
                .map(
                  (r) =>
                    `- ${r.name}: ${r.description}${r.access === "read-only" ? " · read-only" : ""}${r.tier ? ` · ${r.tier}` : ""}${r.adapter ? ` · ${r.adapter}` : ""}${r.acceptance ? ` · done when \`${r.acceptance}\` passes` : ""}${r.skills?.length ? ` · skills: ${r.skills.join(", ")}` : ""}${r.source !== "builtin" ? ` (${r.source})` : ""}`,
                )
                .join("\n"),
            ),
          ),
      )

    server.registerTool(
      "pick_agent",
      {
        description:
          "Who should do this task? Ranks the installed agents by their track record in THIS project on this kind of task (merged work, review verdicts, failures) and cost per success, and suggests a model tier. Use it before spawning for anything non-trivial.",
        inputSchema: { task: z.string(), candidates: z.array(z.string()).optional().describe("adapters to compare (default: every installed one)") },
      },
      (a) =>
        guard(async () => {
          const { kind, picks } = await pickForTask(rt, a.task, a.candidates)
          const lines = picks.map((p, i) => `${i + 1}. ${p.adapter}${p.model ? ` (${p.model})` : ""} — ${p.why}`)
          const role = roleFor(a.task)
          const roleLine = role && rt.roles().has(role) ? ` · suggested role: ${role}` : ""
          return ok(
            `task kind: ${kind} · suggested tier: ${picks[0]?.tier ?? "medium"}${roleLine}\n${lines.join("\n")}\nPrefer a different vendor than the author for reviews.`,
          )
        }),
    )

    const agentRef = (name: string) => {
      const t = rt.findAgent(name)
      if (!t) throw new Error(`no agent "${name}"`)
      return t
    }

    server.registerTool(
      "merge",
      {
        description:
          "Merge an agent's worktree changes into the project (three-way, runs workspace.verify first if configured). Returns merged files, or the conflicting files. Refuses while a review you asked for is unresolved, unless force is true.",
        inputSchema: {
          agent: z.string(),
          force: z.boolean().optional().describe("merge even though the latest review is pending, failed or asked for changes"),
        },
      },
      (a) =>
        guard(async () => {
          const t = agentRef(a.agent)
          const rv = await rt.collab.reviewState(t.info.agentId)
          if (!a.force && rv.state !== "none" && rv.state !== "approved") {
            const why = {
              pending: `${rv.reviewer} hasn't submitted its review of ${t.info.name} yet — wait_for_results first`,
              unfinished: `${rv.reviewer} stopped without reviewing ${t.info.name} (no verdict) — request_review with a different reviewer`,
              changes_requested: `${rv.reviewer} requested changes from ${t.info.name} — have them addressed and reviewed again`,
              stale: `${t.info.name} changed its work after ${rv.reviewer}'s review — request_review again`,
            }[rv.state]
            return fail(`not merged: ${why}. (Merge anyway with force: true and tell the user it was unreviewed.)`)
          }
          const r = await rt.collab.merge(t.info.agentId, me)
          if (r.status === "merged") return ok(`merged ${t.info.name}: ${r.files.map((f) => `${f.path} +${f.added} −${f.removed}`).join(", ")}`)
          if (r.status === "empty") return ok(`${t.info.name} has no changes to merge`)
          return fail(
            `${r.status}: ${r.detail ?? ""}${r.status === "conflict" ? ` — call sync("${t.info.name}") so the agent resolves them in its worktree, then merge again` : ""}`,
          )
        }),
    )

    server.registerTool(
      "sync",
      {
        description: "Bring the project's latest state into an agent's worktree; conflicts are left as markers and the agent is asked to resolve them.",
        inputSchema: { agent: z.string() },
      },
      (a) =>
        guard(async () => {
          const t = agentRef(a.agent)
          const r = await rt.collab.sync(t.info.agentId)
          return ok(
            r.clean
              ? `${t.info.name} is up to date with the project`
              : `${t.info.name} has conflicts in ${r.conflicts.join(", ")}; it was asked to resolve them`,
          )
        }),
    )

    server.registerTool(
      "get_diff",
      {
        description:
          "Unified diff of an agent's unmerged changes (optionally limited to paths). stat: true gives only the per-file +/− summary (start there for big changes). Long diffs come in pages: pass the returned next offset to read on.",
        inputSchema: {
          agent: z.string(),
          paths: z.array(z.string()).optional(),
          stat: z.boolean().optional().describe("only the per-file +added −removed summary"),
          offset: z.number().int().min(0).optional().describe("byte offset to start the page at (from the previous page's 'next offset')"),
          max_bytes: z.number().int().min(1000).max(100_000).optional().describe("page size (default 30000)"),
        },
      },
      (a) =>
        guard(async () => {
          const t = agentRef(a.agent)
          const d = await rt.collab.diff(t.info.agentId, a.paths ?? [])
          if (!d.trim()) return ok("(no changes)")
          if (a.stat) {
            const files = diffStat(d)
            const added = files.reduce((n, x) => n + x.added, 0)
            const removed = files.reduce((n, x) => n + x.removed, 0)
            const rows = files.map((x) => `${x.path} ${x.binary ? "(binary)" : `+${x.added} −${x.removed}`}`)
            return ok(`${rows.join("\n")}\n${files.length} file(s), +${added} −${removed}, ${Buffer.byteLength(d, "utf8")} bytes of diff`)
          }
          const { page, next, total } = pageText(d, a.offset ?? 0, a.max_bytes ?? 30_000)
          const start = Math.min(a.offset ?? 0, total)
          if (next === undefined && start === 0) return ok(page)
          const tail =
            next !== undefined
              ? `[bytes ${start}–${next} of ${total}; next offset ${next} of total ${total} — call get_diff again with offset: ${next}]`
              : `[bytes ${start}–${total} of ${total}; end of diff]`
          return ok(`${page}${page.endsWith("\n") || !page ? "" : "\n"}${tail}`)
        }),
    )

    server.registerTool(
      "request_review",
      {
        description:
          "Have another agent review an agent's changes (default reviewer: a different vendor, e.g. Codex reviews Claude). The verdict comes back to you as a result message.",
        inputSchema: { agent: z.string(), reviewer: z.string().optional().describe("adapter id, profile, or an existing agent's name") },
      },
      (a) =>
        guard(async () => {
          const t = agentRef(a.agent)
          const r = await rt.collab.requestReview(t.info.agentId, { reviewer: a.reviewer, requester: me })
          return ok(`${r.reviewer} is reviewing ${t.info.name}`)
        }),
    )

    server.registerTool(
      "plan_tasks",
      {
        description:
          "Record the task plan (a DAG) before dispatching. Shown to the user; if plan approval is enabled this waits for their decision. Then pass task_id to spawn_agent.",
        inputSchema: {
          tasks: z
            .array(
              z.object({
                id: z.string().optional(),
                title: z.string(),
                description: z.string().optional(),
                deps: z.array(z.string()).optional(),
                files: z.array(z.string()).optional(),
                acceptance: z.string().optional(),
              }),
            )
            .min(1),
        },
      },
      (a) =>
        guard(async () => {
          const r = await rt.whileBlocked(me, () => rt.collab.plan(a.tasks, undefined, signal))
          if (!r.approved) return fail(`plan rejected by the user${r.notes ? `: ${r.notes}` : ""} — revise it`)
          return ok(`plan recorded (${r.ids.join(", ")})${r.notes ? `; user notes: ${r.notes}` : ""}`)
        }),
    )

    server.registerTool(
      "update_task",
      {
        description: "Update a plan task's state.",
        inputSchema: {
          task_id: z.string(),
          state: z.enum(["submitted", "working", "input_required", "completed", "failed", "canceled", "rejected"]),
          note: z.string().optional(),
        },
      },
      (a) =>
        guard(() => {
          rt.collab.updateTask(a.task_id, a.state, a.note)
          return ok("ok")
        }),
    )

    server.registerTool(
      "wait_for_results",
      {
        description:
          "Wait until the given agents (default: every agent you dispatched work to) report results, or until timeout_s. Returns their results plus anything already queued in your inbox. If it returns 'still waiting', call it again.",
        inputSchema: { agents: z.array(z.string()).optional(), timeout_s: z.number().min(1).max(1800).optional() },
      },
      (a, extra) =>
        guard(async () => {
          const started = performance.now()
          const timeoutMs = (a.timeout_s ?? 600) * 1000
          for (const n of a.agents ?? []) agentRef(n)
          const wanted = new Set(
            (
              a.agents ??
              [...rt.agents.values()]
                .filter(
                  (x) => x.resultTo.has(me) || (x.busy && x.info.parentId === me) || caller.inbox.some((m) => m.kind === "result" && m.from === x.info.agentId),
                )
                .map((x) => x.info.name)
            ).map((n) => n.toLowerCase()),
          )
          const fmt = (msgs: { fromName: string; kind: string; body: string }[]) =>
            msgs.map((m) => `from ${m.fromName} [${m.kind}]:\n${m.body}`).join("\n\n---\n\n")
          if (wanted.size === 0) return ok(fmt(rt.drainInbox(me)) || "(nothing pending: no agent is working for you)")

          // The readiness check runs synchronously against the inbox before the waiter is
          // registered, so results queued earlier and results arriving during the wait are both seen.
          const holdMs = holdFor(caller.info.adapter, extra?._meta?.progressToken, timeoutMs)
          const busyNames = () => [...wanted].filter((w) => !caller.inbox.some((m) => m.kind === "result" && m.fromName.toLowerCase() === w))
          const stop = keepAlive(extra, timeoutMs, (el) => `waiting ${secs(el)}s for ${busyNames().join(", ") || "results"}`)
          let msgs: Awaited<ReturnType<typeof rt.waitInbox>>
          try {
            msgs = await rt.waitInbox(
              me,
              holdMs,
              (inbox) => [...wanted].every((w) => inbox.some((m) => m.kind === "result" && m.fromName.toLowerCase() === w)),
              signal,
            )
          } finally {
            stop()
          }
          const elapsed = performance.now() - started
          const pending = [...wanted].filter((w) => !msgs.some((m) => m.kind === "result" && m.fromName.toLowerCase() === w))
          const text = fmt(msgs) || "(no results yet)"
          if (!pending.length) return ok(text)
          const describe = (name: string) => {
            const t = rt.findAgent(name)
            const view = t && rt.state.agents.get(t.info.agentId)
            if (!t || !view) return name
            const asks = [...rt.state.approvals.values()].filter((p) => p.agentId === t.info.agentId)
            const ask = asks.length ? `, ${asks.length} approval(s) pending — list_approvals / answer_approval` : ""
            return `${t.info.name} (${view.status}${ask})`
          }
          const why =
            elapsed + 50 < timeoutMs
              ? ` — returned early so your MCP client doesn't time out (~${secs(holdMs)}s per call); call wait_for_results again to keep waiting`
              : " — timeout reached; call wait_for_results again to keep waiting"
          return ok(
            `${text}\n\nstill waiting after ${secs(elapsed)}s (of timeout_s ${secs(timeoutMs)}): ${pending.length} agent(s) not done: ${pending.map(describe).join(", ")}${why}`,
          )
        }),
    )

    server.registerTool(
      "list_approvals",
      {
        description:
          "Pending approval requests from your workers (an agent in awaiting_approval is blocked until one is answered): agent, request id, what it wants to run, age. Answer with answer_approval.",
        inputSchema: {},
      },
      () =>
        guard(() => {
          const pending = [...rt.state.approvals.values()].filter((p) => p.agentId !== me).sort((x, y) => x.ts - y.ts)
          if (!pending.length) return ok("(no pending approvals)")
          return ok(
            pending
              .map((p) => {
                const who = rt.state.agents.get(p.agentId)?.name ?? p.agentId
                const detail = p.detail ? `\n    ${p.detail.slice(0, 500).replace(/\n/g, "\n    ")}` : ""
                const opts = p.options.map((o) => o.kind).join(", ")
                return `- [${p.requestId}] ${who}: ${p.title}${p.kind ? ` (${p.kind})` : ""} · ${ago(p.ts)} ago · options: ${opts}${detail}`
              })
              .join("\n"),
          )
        }),
    )

    server.registerTool(
      "answer_approval",
      {
        description:
          "Allow or deny a worker's pending approval request (ids from list_approvals). always: true also remembers the decision for matching requests from now on.",
        inputSchema: {
          request_id: z.string(),
          allow: z.boolean(),
          always: z.boolean().optional().describe("remember this decision (allow_always / reject_always) when the agent offers it"),
        },
      },
      (a) =>
        guard(async () => {
          const p = rt.state.approvals.get(a.request_id)
          if (!p) return fail(`no pending approval "${a.request_id}" (already answered or timed out? list_approvals shows the current ones)`)
          if (p.agentId === me) return fail("that request is addressed to the user, not to you")
          if (p.kind === "delegate") return fail("that is a question for the user (not a tool approval); only they can answer it")
          const want = a.allow
            ? a.always
              ? ["allow_always", "allow_once"]
              : ["allow_once", "allow_always"]
            : a.always
              ? ["reject_always", "reject_once"]
              : ["reject_once", "reject_always"]
          const opt = want.map((k) => p.options.find((o) => o.kind === k)).find(Boolean)
          if (!opt) return fail(`request offers no ${a.allow ? "allow" : "deny"} option (options: ${p.options.map((o) => o.kind).join(", ")})`)
          await rt.resolvePermission(p.agentId, p.requestId, opt.optionId, "user", caller.info.name)
          const who = rt.state.agents.get(p.agentId)?.name ?? p.agentId
          return ok(`${opt.kind} → ${who}: ${p.title}`)
        }),
    )

    server.registerTool("interrupt_agent", { description: "Interrupt an agent's current turn.", inputSchema: { name: z.string() } }, (a) =>
      guard(async () => {
        const t = rt.findAgent(a.name)
        if (!t) return fail(`no agent "${a.name}"`)
        await rt.interrupt(t.info.agentId)
        return ok(`interrupted ${t.info.name}`)
      }),
    )

    server.registerTool("kill_agent", { description: "Stop and remove an agent.", inputSchema: { name: z.string() } }, (a) =>
      guard(async () => {
        const t = rt.findAgent(a.name)
        if (!t) return fail(`no agent "${a.name}"`)
        if (t.info.isOrchestrator) return fail("cannot kill the orchestrator")
        await rt.kill(t.info.agentId)
        return ok(`killed ${t.info.name}`)
      }),
    )

    server.registerTool(
      "set_label",
      { description: "Set the short task label shown on an agent's card.", inputSchema: { name: z.string(), label: z.string() } },
      (a) =>
        guard(() => {
          const t = rt.findAgent(a.name)
          if (!t) return fail(`no agent "${a.name}"`)
          rt.rename(t.info.agentId, undefined, a.label)
          return ok("ok")
        }),
    )
  }

  return server
}

function wantsProgress(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body]
  return msgs.some((m) => {
    const msg = m as { method?: unknown; params?: { _meta?: { progressToken?: unknown } } } | null | undefined
    return msg?.method === "tools/call" && msg.params?._meta?.progressToken !== undefined
  })
}

export interface McpHttpServer {
  url: string
  port: number
  stop(): void
}

export function startMcpServer(rt: Runtime, port = 0): McpHttpServer {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    idleTimeout: 0,
    async fetch(req) {
      if (!hostAllowed(req.headers.get("host"))) return misdirected()
      const url = new URL(req.url)
      // identity: the per-agent token, as a bearer header (preferred — never visible in `ps`) or in the path
      const m = /^\/mcp(?:\/([\w-]+))?\/?$/.exec(url.pathname)
      if (!m) return new Response("not found", { status: 404 })
      const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]
      const token = bearer ?? m[1]
      const caller = token ? [...rt.agents.values()].find((a) => a.token === token) : undefined
      if (!caller || caller.closing) return new Response("unknown agent token", { status: 401 })
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })
      // A request carrying a progressToken gets an SSE response so progress notifications (the
      // keep-alive for long waits) reach the client; everything else stays a plain JSON reply.
      const stream = wantsProgress(
        await req
          .clone()
          .json()
          .catch(() => undefined),
      )
      const mcp = buildMcpServer(rt, caller, req.signal)
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !stream })
      const close = () => queueMicrotask(() => void mcp.close().catch(() => {}))
      if (stream) {
        // the response streams after handleRequest returns: tear down once the final reply is sent
        const send = transport.send.bind(transport)
        transport.send = async (msg, opts) => {
          await send(msg, opts)
          if ("id" in msg && ("result" in msg || "error" in msg)) close()
        }
        req.signal.addEventListener("abort", close, { once: true })
      }
      await mcp.connect(transport)
      try {
        return await transport.handleRequest(req)
      } finally {
        // stateless: tear down after the response is produced
        if (!stream) close()
      }
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, port: server.port as number, stop: () => server.stop(true) }
}
