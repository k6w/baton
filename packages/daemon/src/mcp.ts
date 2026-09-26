/**
 * Baton MCP server — injected into every agent session so heterogeneous agents can talk
 * to each other and the orchestrator can spawn/steer workers. Stateless Streamable HTTP;
 * the per-agent token in the URL path is the caller's identity.
 */

import { formatCost, formatTokens } from "@batonsh/kernel"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"
import type { AgentRuntime, Runtime } from "./runtime.ts"

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

export function buildMcpServer(rt: Runtime, caller: AgentRuntime): McpServer {
  const server = new McpServer({ name: "baton", version: "0.1.0" }, { instructions: "Baton multi-agent coordination tools." })
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
    (a) =>
      guard(async () => {
        const msgs = a.wait_s ? await rt.waitInbox(me, a.wait_s * 1000) : rt.drainInbox(me)
        if (msgs.length === 0) return ok("(inbox empty)")
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
            return `- ${a.name}${you}: ${a.adapter}${a.model ? `/${a.model}` : ""} · ${a.status}${pct}${a.label ? ` · "${a.label}"` : ""} · ${formatTokens(a.usage.input + a.usage.output)} tok · ${formatCost(a.usage.costUsd)}`
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

  if (isLead || rt.config.budget.max_depth > 0) {
    server.registerTool(
      "spawn_agent",
      {
        description: `Start a new coding agent. adapter: one of ${rt.registry
          .list()
          .map((a) => a.id)
          .join(
            ", ",
          )} or a configured profile name (${Object.keys(rt.config.agents).join(", ") || "none"}). If \`task\` is given it starts working immediately and its result is reported back to you.`,
        inputSchema: {
          adapter: z.string(),
          task: z.string().optional(),
          name: z.string().optional(),
          label: z.string().optional().describe("2-3 word task label shown on the agent's card"),
          model: z.string().optional(),
          role: z.string().optional(),
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
            )
            if (!ok) return fail(`the user declined starting more agents (${live} running). Reuse existing agents (send_message) or do it with fewer.`)
          }
          const names: string[] = []
          for (let i = 0; i < n; i++) {
            const info = await rt.spawn({
              adapter: a.adapter,
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
          return ok(`spawned: ${names.join(", ")}${a.task ? " (task dispatched)" : ""}`)
        }),
    )
  }

  if (isLead) {
    const agentRef = (name: string) => {
      const t = rt.findAgent(name)
      if (!t) throw new Error(`no agent "${name}"`)
      return t
    }

    server.registerTool(
      "merge",
      {
        description:
          "Merge an agent's worktree changes into the project (three-way, runs workspace.verify first if configured). Returns merged files, or the conflicting files.",
        inputSchema: { agent: z.string() },
      },
      (a) =>
        guard(async () => {
          const t = agentRef(a.agent)
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
        description: "Unified diff of an agent's unmerged changes (optionally limited to paths). Long diffs are truncated.",
        inputSchema: { agent: z.string(), paths: z.array(z.string()).optional() },
      },
      (a) =>
        guard(async () => {
          const t = agentRef(a.agent)
          const d = await rt.collab.diff(t.info.agentId, a.paths ?? [])
          if (!d.trim()) return ok("(no changes)")
          return ok(d.length > 60_000 ? `${d.slice(0, 60_000)}\n… [truncated, ${d.length} bytes]` : d)
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
          const r = await rt.collab.plan(a.tasks)
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
        description: "Wait until the given agents (default: every agent you dispatched work to) report results, or until timeout. Returns their results.",
        inputSchema: { agents: z.array(z.string()).optional(), timeout_s: z.number().min(1).max(1800).optional() },
      },
      (a) =>
        guard(async () => {
          const wanted = new Set(
            (a.agents ?? [...rt.agents.values()].filter((x) => x.resultTo.has(me) || (x.busy && x.info.parentId === me)).map((x) => x.info.name)).map((n) =>
              n.toLowerCase(),
            ),
          )
          if (wanted.size === 0)
            return ok(
              rt
                .drainInbox(me)
                .map((m) => `from ${m.fromName}:\n${m.body}`)
                .join("\n\n") || "(nothing pending)",
            )
          const seen = new Set<string>()
          const msgs = await rt.waitInbox(me, (a.timeout_s ?? 600) * 1000, (inbox) => {
            for (const m of inbox) if (m.kind === "result") seen.add(m.fromName.toLowerCase())
            return [...wanted].every((w) => seen.has(w))
          })
          const pending = [...wanted].filter((w) => !msgs.some((m) => m.kind === "result" && m.fromName.toLowerCase() === w))
          const text = msgs.map((m) => `from ${m.fromName} [${m.kind}]:\n${m.body}`).join("\n\n---\n\n")
          return ok(`${text || "(no results yet)"}${pending.length ? `\n\nstill working: ${pending.join(", ")}` : ""}`)
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
      const url = new URL(req.url)
      const m = /^\/mcp\/([\w-]+)\/?$/.exec(url.pathname)
      if (!m) return new Response("not found", { status: 404 })
      const caller = [...rt.agents.values()].find((a) => a.token === m[1])
      if (!caller || caller.closing) return new Response("unknown agent token", { status: 401 })
      if (req.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })
      const mcp = buildMcpServer(rt, caller)
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await mcp.connect(transport)
      try {
        return await transport.handleRequest(req)
      } finally {
        // stateless: tear down after the response is produced
        queueMicrotask(() => void mcp.close().catch(() => {}))
      }
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, port: server.port as number, stop: () => server.stop(true) }
}
