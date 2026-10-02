/**
 * `baton mcp` — Baton as an MCP server (stdio), so another agent or app (Claude Desktop, Cursor,
 * Claude Code, …) can hand work to a Baton team and follow it: run a task, watch progress,
 * answer approvals, review diffs, merge. It drives the project's daemon like the TUI does.
 *
 *   claude mcp add baton -- baton mcp --root /path/to/project
 */
import { attentionItems, formatCost } from "@batonsh/kernel"
import type { BatonEvent } from "@batonsh/protocol"
import type { BatonClient, LiveRun } from "@batonsh/sdk"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"

type Result = { content: { type: "text"; text: string }[]; isError?: boolean }
const ok = (text: string): Result => ({ content: [{ type: "text", text }] })
const fail = (text: string): Result => ({ content: [{ type: "text", text }], isError: true })

async function guard(fn: () => Promise<Result> | Result): Promise<Result> {
  try {
    return await fn()
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}

export function statusText(live: LiveRun): string {
  const s = live.state
  const lines: string[] = [`project ${s.projectName}${s.branch ? `@${s.branch}` : ""} · autonomy ${s.autonomy} · ${formatCost(s.totals.costUsd)}`]
  const lead = s.orchestratorId ? s.agents.get(s.orchestratorId) : undefined
  if (lead) lines.push(`lead: ${lead.adapter} · ${lead.status}`)
  const workers = s.workers()
  lines.push(workers.length ? "agents:" : "agents: none")
  for (const a of workers) {
    const ws = s.workspaces.get(a.agentId)
    lines.push(
      `- ${a.name} (${a.adapter}${a.model ? `/${a.model}` : ""}) ${a.status}${a.label ? ` · ${a.label}` : ""}${ws?.files.length ? ` · ${ws.files.length} files +${ws.added} -${ws.removed} unmerged` : ""}`,
    )
  }
  const att = attentionItems(s)
  if (att.length) {
    lines.push("needs attention:")
    for (const a of att) lines.push(`- [${a.kind}] ${a.title}${a.requestId ? ` (request_id: ${a.requestId})` : ""}`)
  }
  return lines.join("\n")
}

function lastLeadMessage(live: LiveRun, since: number): string | undefined {
  const id = live.state.orchestratorId
  if (!id) return undefined
  const msgs = live.state.feed(id).items.filter((i) => i.kind === "message" && i.role === "assistant" && i.ts >= since)
  const last = msgs.at(-1)
  return last && last.kind === "message" ? last.text : undefined
}

/** Resolve when nobody is working any more, something needs a human, or the timeout hits. */
export function waitSettled(live: LiveRun, timeoutMs: number): Promise<"idle" | "attention" | "timeout"> {
  return new Promise((resolve) => {
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      const s = live.state
      if ([...s.approvals.values()].length || s.plan?.status === "proposed") return finish("attention")
      const busy = [...s.agents.values()].some((a) => a.status === "busy" || a.status === "starting" || a.status === "awaiting_approval")
      if (quietTimer) clearTimeout(quietTimer)
      // idle must hold for a moment: results hand work back to the lead right after a worker stops
      if (!busy) quietTimer = setTimeout(() => finish("idle"), 2500)
    }
    const finish = (r: "idle" | "attention" | "timeout") => {
      off()
      clearTimeout(timer)
      if (quietTimer) clearTimeout(quietTimer)
      resolve(r)
    }
    const off = live.onEvent((_e: BatonEvent) => check())
    const timer = setTimeout(() => finish("timeout"), timeoutMs)
    check()
  })
}

export function buildBatonMcp(client: BatonClient, live: LiveRun): McpServer {
  const server = new McpServer(
    { name: "baton", version: "0.1.0" },
    {
      instructions:
        "Baton runs a team of coding agents (Claude Code, Codex, OpenCode, Gemini…) on this project, each in its own git worktree, coordinated by a lead agent. Use run_task to hand over work, status/wait to follow it, answer for approvals, diff + merge to land changes.",
    },
  )
  const agent = (ref: string) => {
    const a = live.state.findAgent(ref)
    if (!a || a.status === "exited") throw new Error(`no agent "${ref}" — see status`)
    return a
  }

  server.registerTool(
    "run_task",
    {
      description:
        "Give the Baton lead a task. It plans, starts agents as needed and merges their work when reviewed. Waits up to wait_s seconds (default 600) for the team to finish or to need a human, then reports.",
      inputSchema: { task: z.string(), wait_s: z.number().min(0).max(3600).optional() },
    },
    (a) =>
      guard(async () => {
        const since = Date.now()
        await client.submit(a.task)
        const wait = a.wait_s ?? 600
        if (wait === 0) return ok(`task sent.\n\n${statusText(live)}`)
        const r = await waitSettled(live, wait * 1000)
        const said = lastLeadMessage(live, since)
        const head =
          r === "idle"
            ? "the team is done"
            : r === "attention"
              ? "the team needs a decision (see below; use answer)"
              : `still working after ${wait}s (use wait)`
        return ok(`${head}.\n${said ? `\nlead: ${said}\n` : ""}\n${statusText(live)}`)
      }),
  )

  server.registerTool("status", { description: "Agents, what they're doing, unmerged changes, and everything that needs a decision.", inputSchema: {} }, () =>
    guard(() => ok(statusText(live))),
  )

  server.registerTool(
    "wait",
    {
      description: "Wait until the team is idle or needs a decision (or timeout_s passes), then report status.",
      inputSchema: { timeout_s: z.number().min(1).max(3600).optional() },
    },
    (a) =>
      guard(async () => {
        const r = await waitSettled(live, (a.timeout_s ?? 300) * 1000)
        return ok(`${r}\n\n${statusText(live)}`)
      }),
  )

  server.registerTool("message", { description: "Send a message straight to one agent (or 'all').", inputSchema: { to: z.string(), text: z.string() } }, (a) =>
    guard(async () => {
      const r = await client.submit(`@${a.to.replace(/^@/, "")} ${a.text}`)
      return ok(`sent to ${r.routedTo.join(", ") || a.to}`)
    }),
  )

  server.registerTool(
    "answer",
    {
      description: "Answer a pending approval (request_id from status). allow = once, always = this exact command from now on, deny = refuse.",
      inputSchema: { request_id: z.string(), decision: z.enum(["allow", "always", "deny"]) },
    },
    (a) =>
      guard(async () => {
        const p = live.state.approvals.get(a.request_id)
        if (!p) return fail(`no pending request ${a.request_id} — see status`)
        const want = a.decision === "allow" ? "allow_once" : a.decision === "always" ? "allow_always" : "reject_once"
        const opt = p.options.find((o) => o.kind === want) ?? p.options.find((o) => o.kind.startsWith(want.split("_")[0]!))
        await client.respond(p.agentId, p.requestId, opt?.optionId ?? null)
        return ok(`${a.decision}: ${p.title}`)
      }),
  )

  server.registerTool("diff", { description: "The unified diff of an agent's unmerged changes.", inputSchema: { agent: z.string() } }, (a) =>
    guard(async () => {
      const { patch } = await client.call("workspace.diff", { agentId: agent(a.agent).agentId })
      return ok(patch.trim() ? (patch.length > 60_000 ? `${patch.slice(0, 60_000)}\n… (truncated)` : patch) : "(no changes)")
    }),
  )

  server.registerTool(
    "merge",
    { description: "Merge an agent's worktree changes into the project (three-way; your working tree only — you commit).", inputSchema: { agent: z.string() } },
    (a) =>
      guard(async () => {
        const r = await client.call("workspace.merge", { agentId: agent(a.agent).agentId })
        return r.status === "merged" ? ok(`merged ${r.files.length} file(s): ${r.files.join(", ")}`) : fail(`${r.status}${r.detail ? `: ${r.detail}` : ""}`)
      }),
  )

  server.registerTool(
    "set_autonomy",
    {
      description:
        "How freely every agent acts: normal (their own settings), ask (everyone asks first), auto (act, destructive commands ask), yolo (no prompts, no sandbox).",
      inputSchema: { level: z.enum(["normal", "ask", "auto", "yolo"]) },
    },
    (a) =>
      guard(async () => {
        const r = await client.call("run.autonomy", { mode: a.level })
        return ok(`autonomy: ${r.mode}${r.pending.length ? ` (${r.pending.join(", ")} keep their sandbox until restarted)` : ""}`)
      }),
  )

  server.registerTool("interrupt", { description: "Stop an agent's current turn ('all' for everyone).", inputSchema: { agent: z.string() } }, (a) =>
    guard(async () => {
      if (a.agent === "all") await client.submit("!all")
      else await client.interrupt(agent(a.agent).agentId)
      return ok(`interrupted ${a.agent}`)
    }),
  )

  return server
}

export async function runMcp(client: BatonClient): Promise<void> {
  const live = await client.live()
  const server = buildBatonMcp(client, live)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  // stdout belongs to the protocol from here on
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve()
    process.stdin.on("end", () => resolve())
    client.onClose(() => resolve())
  })
}
