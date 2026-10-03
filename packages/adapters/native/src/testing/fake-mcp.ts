/** Test helper: a tiny stateless Streamable HTTP MCP server with three tools (one read-only). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

export interface FakeMcp {
  url: string
  calls: { tool: string; args: unknown; auth: string | null; start?: number; end?: number }[]
  stop(): void
}

export function fakeMcp(opts: { token?: string } = {}): FakeMcp {
  const calls: FakeMcp["calls"] = []
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization")
      if (opts.token && auth !== `Bearer ${opts.token}`) return new Response("unauthorized", { status: 401 })
      const mcp = new McpServer({ name: "fake", version: "1.0.0" }, { instructions: "Fake coordination tools for tests." })
      mcp.registerTool("add", { description: "Add two numbers", inputSchema: { a: z.number(), b: z.number() } }, async (a) => {
        calls.push({ tool: "add", args: a, auth })
        return { content: [{ type: "text", text: String(a.a + a.b) }] }
      })
      mcp.registerTool("send_message", { description: "Send a message to another agent", inputSchema: { to: z.string(), body: z.string() } }, async (a) => {
        calls.push({ tool: "send_message", args: a, auth })
        return { content: [{ type: "text", text: `sent to ${a.to}` }] }
      })
      mcp.registerTool(
        "lookup",
        { description: "Look something up (slow, read-only)", inputSchema: { key: z.string() }, annotations: { readOnlyHint: true } },
        async (a) => {
          const call = { tool: "lookup", args: a, auth, start: Date.now(), end: 0 }
          calls.push(call)
          await Bun.sleep(300)
          call.end = Date.now()
          return { content: [{ type: "text", text: `value of ${a.key}` }] }
        },
      )
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      await mcp.connect(transport)
      return await transport.handleRequest(req)
    },
  })
  return { url: `http://localhost:${server.port}/mcp`, calls, stop: () => server.stop(true) }
}
