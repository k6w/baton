/**
 * OpenTelemetry export (OTLP/HTTP JSON, no SDK dependency). One trace per run:
 *   invoke_agent <name>   — one span per agent turn (gen_ai.* attributes, token usage)
 *   └ execute_tool <tool> — one span per tool call
 * Content (prompts, outputs) is never exported. Enable with [telemetry] otlp_endpoint.
 */
import { createHash } from "node:crypto"
import { BATON_VERSION, type BatonEvent } from "@batonsh/protocol"
import type { Runtime } from "./runtime.ts"

type Attr = { key: string; value: { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean } }

interface Span {
  traceId: string
  spanId: string
  parentSpanId?: string
  name: string
  kind: number
  startTimeUnixNano: string
  endTimeUnixNano?: string
  attributes: Attr[]
  status?: { code: number; message?: string }
}

const hex = (s: string, len: number) => createHash("sha256").update(s).digest("hex").slice(0, len)
const nanos = (ms: number) => `${BigInt(Math.round(ms)) * 1_000_000n}`
const attr = (key: string, v: string | number | boolean | undefined): Attr | undefined =>
  v === undefined
    ? undefined
    : {
        key,
        value:
          typeof v === "string"
            ? { stringValue: v }
            : typeof v === "boolean"
              ? { boolValue: v }
              : Number.isInteger(v)
                ? { intValue: String(v) }
                : { doubleValue: v },
      }

export class TelemetryExporter {
  private open = new Map<string, Span>() // key: turn:<agent> | tool:<id>
  private done: Span[] = []
  private timer: ReturnType<typeof setInterval>
  private unsub: () => void
  private traceId: string

  constructor(
    private rt: Runtime,
    private endpoint: string,
  ) {
    this.traceId = hex(rt.runId, 32)
    this.unsub = rt.store.subscribe((e) => this.onEvent(e))
    this.timer = setInterval(() => void this.flush(), 5000)
    this.timer.unref?.()
  }

  private agentAttrs(agentId: string): Attr[] {
    const a = this.rt.state.agents.get(agentId)
    return [
      attr("gen_ai.operation.name", "invoke_agent"),
      attr("gen_ai.agent.name", a?.name),
      attr("gen_ai.agent.id", agentId),
      attr("gen_ai.system", a?.adapter),
      attr("gen_ai.request.model", a?.model),
      attr("baton.role", a?.isOrchestrator ? "orchestrator" : (a?.role ?? "worker")),
      attr("baton.label", a?.label),
      attr("baton.project", this.rt.state.projectName),
    ].filter(Boolean) as Attr[]
  }

  private onEvent(e: BatonEvent) {
    const aid = e.agentId
    if (!aid) return
    switch (e.type) {
      case "turn.started": {
        const a = this.rt.state.agents.get(aid)
        this.open.set(`turn:${aid}`, {
          traceId: this.traceId,
          spanId: hex(`${e.id}turn`, 16),
          name: `invoke_agent ${a?.name ?? aid}`,
          kind: 1,
          startTimeUnixNano: nanos(e.ts),
          attributes: this.agentAttrs(aid),
        })
        break
      }
      case "turn.completed":
      case "turn.interrupted": {
        const s = this.open.get(`turn:${aid}`)
        if (!s) break
        this.open.delete(`turn:${aid}`)
        const u = this.rt.state.agents.get(aid)?.usage
        s.endTimeUnixNano = nanos(e.ts)
        for (const x of [attr("gen_ai.usage.input_tokens", u?.input), attr("gen_ai.usage.output_tokens", u?.output), attr("baton.cost_usd", u?.costUsd)])
          if (x) s.attributes.push(x)
        const failed = e.type === "turn.completed" && e.data.stopReason === "error"
        s.status = failed ? { code: 2, message: "turn failed" } : e.type === "turn.interrupted" ? { code: 0, message: "interrupted" } : { code: 1 }
        this.done.push(s)
        break
      }
      case "tool.call": {
        const parent = this.open.get(`turn:${aid}`)
        this.open.set(`tool:${e.data.toolCallId}`, {
          traceId: this.traceId,
          spanId: hex(`${e.data.toolCallId}tool`, 16),
          parentSpanId: parent?.spanId,
          name: `execute_tool ${e.data.name}`,
          kind: 1,
          startTimeUnixNano: nanos(e.ts),
          attributes: [
            attr("gen_ai.operation.name", "execute_tool"),
            attr("gen_ai.tool.name", e.data.name),
            attr("baton.tool.kind", e.data.kind),
            attr("gen_ai.agent.id", aid),
          ].filter(Boolean) as Attr[],
        })
        break
      }
      case "tool.update": {
        if (e.data.status !== "completed" && e.data.status !== "failed") break
        const s = this.open.get(`tool:${e.data.toolCallId}`)
        if (!s) break
        this.open.delete(`tool:${e.data.toolCallId}`)
        s.endTimeUnixNano = nanos(e.ts)
        s.status = e.data.status === "failed" ? { code: 2 } : { code: 1 }
        this.done.push(s)
        break
      }
    }
  }

  async flush(): Promise<void> {
    if (!this.done.length) return
    const spans = this.done.splice(0)
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [attr("service.name", this.rt.config.telemetry.service_name), attr("baton.run_id", this.rt.runId)].filter(Boolean) },
          scopeSpans: [{ scope: { name: "baton", version: BATON_VERSION }, spans }],
        },
      ],
    }
    try {
      const url = `${this.endpoint.replace(/\/$/, "")}/v1/traces`
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...this.rt.config.telemetry.headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch (e) {
      this.rt.emit({ type: "log", data: { level: "debug", message: `otlp export failed: ${e instanceof Error ? e.message : e}` } })
    }
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    this.unsub()
    await this.flush()
  }
}
