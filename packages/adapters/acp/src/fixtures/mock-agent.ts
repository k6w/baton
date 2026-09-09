#!/usr/bin/env bun
/**
 * Deterministic mock ACP agent for adapter tests. Behaviour is selected by the prompt text:
 *   "full"       thought + message chunks, plan, read via fs, edit with permission + fs write
 *                + diff, terminal command, usage — the main mapping scenario
 *   "slow"       streams chunks until cancelled
 *   "perm-wait"  asks for permission and waits (interrupt must answer `cancelled`)
 *   "outside"    tries to write outside the workspace
 *   "info"       replies with a JSON dump of what the client sent us
 *   "crash"      exits with code 3 mid-turn
 * Env: MOCK_REQUIRE_AUTH=1 makes session/new require authentication (method "mock-api-key"
 * succeeds when MOCK_API_KEY is set; "mock-oauth" always fails).
 */
import * as acp from "@agentclientprotocol/sdk"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"

interface State {
  cwd: string
  mcpServers: unknown[]
  model: string
  loadedFrom?: string
  resumedFrom?: string
  prompts: string[]
  cancel?: AbortController
}

const sessions = new Map<string, State>()
let authenticated = false
let initParams: acp.InitializeRequest | undefined

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function configOptions(model: string): acp.SessionConfigOption[] {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: model,
      options: [
        { value: "mock/fast", name: "Mock Fast" },
        { value: "mock/smart", name: "Mock Smart" },
      ],
    },
  ]
}

class MockAgent implements acp.Agent {
  constructor(private conn: acp.AgentSideConnection) {}

  async initialize(params: acp.InitializeRequest): Promise<acp.InitializeResponse> {
    initParams = params
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: false },
        promptCapabilities: { embeddedContext: true },
      },
      authMethods: [
        { id: "mock-oauth", name: "Login with browser", description: "Opens a browser" },
        { id: "mock-api-key", name: "API key", description: "Use MOCK_API_KEY" },
      ],
      agentInfo: { name: "mock-agent", version: "9.9.9" },
    }
  }

  async authenticate(params: acp.AuthenticateRequest): Promise<acp.AuthenticateResponse> {
    if (params.methodId === "mock-api-key" && process.env.MOCK_API_KEY) {
      authenticated = true
      return {}
    }
    throw acp.RequestError.authRequired(undefined, `method ${params.methodId} failed`)
  }

  async newSession(params: acp.NewSessionRequest): Promise<acp.NewSessionResponse> {
    if (process.env.MOCK_REQUIRE_AUTH === "1" && !authenticated) throw acp.RequestError.authRequired()
    const sessionId = `mock-${crypto.randomUUID()}`
    sessions.set(sessionId, { cwd: params.cwd, mcpServers: params.mcpServers, model: "mock/fast", prompts: [] })
    return { sessionId, configOptions: configOptions("mock/fast") }
  }

  async loadSession(params: acp.LoadSessionRequest): Promise<acp.LoadSessionResponse> {
    sessions.set(params.sessionId, { cwd: params.cwd, mcpServers: params.mcpServers, model: "mock/smart", loadedFrom: params.sessionId, prompts: [] })
    // replay history (the client must not surface this as new output)
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } } })
    await this.conn.sessionUpdate({ sessionId: params.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "REPLAYED" } } })
    return { configOptions: configOptions("mock/smart") }
  }

  async setSessionConfigOption(params: acp.SetSessionConfigOptionRequest): Promise<acp.SetSessionConfigOptionResponse> {
    const s = this.session(params.sessionId)
    if (params.configId !== "model") throw acp.RequestError.invalidParams()
    s.model = String(params.value)
    return { configOptions: configOptions(s.model) }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    sessions.get(params.sessionId)?.cancel?.abort()
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const s = this.session(params.sessionId)
    const text = params.prompt.map((b) => (b.type === "text" ? b.text : "")).join("")
    s.prompts.push(text)
    s.cancel = new AbortController()
    const signal = s.cancel.signal
    const cmd = text.trim().split("\n").pop()?.trim() ?? ""
    const sid = params.sessionId
    const say = (t: string, messageId?: string) =>
      this.conn.sessionUpdate({ sessionId: sid, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t }, messageId } })

    switch (cmd) {
      case "full":
        return this.full(sid, s)
      case "slow": {
        for (let i = 0; i < 200 && !signal.aborted; i++) {
          await say(`tick${i} `)
          await sleep(20)
        }
        return { stopReason: signal.aborted ? "cancelled" : "end_turn" }
      }
      case "perm-wait": {
        await this.conn.sessionUpdate({
          sessionId: sid,
          update: { sessionUpdate: "tool_call", toolCallId: "wait-1", title: "Run rm -rf build", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } },
        })
        const r = await this.conn.requestPermission({
          sessionId: sid,
          toolCall: { toolCallId: "wait-1" },
          options: [
            { optionId: "yes", name: "Yes", kind: "allow_once" },
            { optionId: "no", name: "No", kind: "reject_once" },
          ],
        })
        await say(`outcome=${r.outcome.outcome}`)
        return { stopReason: r.outcome.outcome === "cancelled" ? "cancelled" : "end_turn" }
      }
      case "outside": {
        try {
          await this.conn.writeTextFile({ sessionId: sid, path: "/tmp/baton-acp-mock-outside.txt", content: "nope" })
          await say("write-allowed")
        } catch (e) {
          await say(`write-rejected: ${(e as Error).message}`)
        }
        return { stopReason: "end_turn" }
      }
      case "info":
        await say(JSON.stringify({ init: initParams, mcpServers: s.mcpServers, model: s.model, loadedFrom: s.loadedFrom, prompts: s.prompts }))
        return { stopReason: "end_turn" }
      case "crash":
        await say("about to crash")
        setTimeout(() => process.exit(3), 10)
        await sleep(1000)
        return { stopReason: "end_turn" }
      default:
        await say(`echo: ${cmd}`)
        return { stopReason: "end_turn" }
    }
  }

  private async full(sid: string, s: State): Promise<acp.PromptResponse> {
    const up = (update: acp.SessionUpdate) => this.conn.sessionUpdate({ sessionId: sid, update })
    const notes = join(s.cwd, "notes.txt")

    await up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Let me " } })
    await up({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think." } })
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello " }, messageId: "m1" })
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" }, messageId: "m1" })
    await up({
      sessionUpdate: "plan",
      entries: [
        { content: "Read notes", status: "completed", priority: "high" },
        { content: "Fix typo", status: "in_progress", priority: "medium" },
        { content: "Run check", status: "pending", priority: "low" },
      ],
    })

    // read
    await up({ sessionUpdate: "tool_call", toolCallId: "read-1", title: "Read notes.txt", kind: "read", status: "in_progress", locations: [{ path: notes }] })
    const file = await this.conn.readTextFile({ sessionId: sid, path: notes })
    await up({ sessionUpdate: "tool_call_update", toolCallId: "read-1", status: "completed", content: [{ type: "content", content: { type: "text", text: file.content } }] })

    // edit with permission
    const fixed = file.content.replace("teh", "the")
    await up({
      sessionUpdate: "tool_call",
      toolCallId: "edit-1",
      title: "Edit notes.txt",
      kind: "edit",
      status: "pending",
      locations: [{ path: notes }],
      rawInput: { path: notes, old_string: "teh", new_string: "the" },
    })
    const perm = await this.conn.requestPermission({
      sessionId: sid,
      toolCall: { toolCallId: "edit-1", title: "Edit notes.txt" },
      options: [
        { optionId: "allow-1", name: "Allow", kind: "allow_once" },
        { optionId: "always-1", name: "Always", kind: "allow_always" },
        { optionId: "reject-1", name: "Reject", kind: "reject_once" },
      ],
    })
    if (perm.outcome.outcome === "selected" && perm.outcome.optionId !== "reject-1") {
      await up({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "in_progress" })
      await this.conn.writeTextFile({ sessionId: sid, path: notes, content: fixed })
      // agent also reports the diff itself — the client must not duplicate it
      await up({
        sessionUpdate: "tool_call_update",
        toolCallId: "edit-1",
        status: "completed",
        content: [{ type: "diff", path: notes, oldText: file.content, newText: fixed }],
      })
    } else {
      await up({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "failed" })
    }

    // terminal
    await up({ sessionUpdate: "tool_call", toolCallId: "exec-1", title: "Run echo", kind: "execute", status: "in_progress", rawInput: { command: "echo hi-from-term" } })
    const term = await this.conn.createTerminal({ sessionId: sid, command: "echo hi-from-term && echo err-line 1>&2", outputByteLimit: 4096 })
    await up({ sessionUpdate: "tool_call_update", toolCallId: "exec-1", content: [{ type: "terminal", terminalId: term.id }] })
    const exit = await term.waitForExit()
    const out = await term.currentOutput()
    await term.release()
    await up({
      sessionUpdate: "tool_call_update",
      toolCallId: "exec-1",
      status: exit.exitCode === 0 && out.output.includes("hi-from-term") ? "completed" : "failed",
    })

    await up({ sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: 0.01, currency: "USD" } })
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." }, messageId: "m2" })
    return { stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedReadTokens: 10, thoughtTokens: 5 } }
  }

  private session(id: string): State {
    const s = sessions.get(id)
    if (!s) throw acp.RequestError.invalidParams(undefined, `unknown session ${id}`)
    return s
  }
}

const stream = acp.ndJsonStream(
  Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
)
new acp.AgentSideConnection((conn) => new MockAgent(conn), stream)
