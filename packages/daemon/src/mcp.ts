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
        },
      },
      (a) =>
        guard(async () => {
          const n = a.count ?? 1
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
            })
            names.push(info.name)
          }
          return ok(`spawned: ${names.join(", ")}${a.task ? " (task dispatched)" : ""}`)
        }),
    )
  }

  if (isLead) {
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
