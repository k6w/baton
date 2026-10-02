/**
 * Remote notifications (webhook / command) fired by the daemon, so you hear about approvals and
 * finished work even when no TUI is attached. Same events and rules as the TUI's notifications.
 */
import { noticeFor, projectName } from "@batonsh/kernel"
import { approvalLinks } from "./remote.ts"
import type { Runtime } from "./runtime.ts"

export function attachRemoteNotify(rt: Runtime): () => void {
  return rt.store.subscribe((e) => {
    const cfg = rt.config.notify
    if (!cfg.webhook && !cfg.command) return
    const n = noticeFor(e, rt.state)
    if (!n || !cfg.events.includes(n.kind)) return
    // approvals get one-tap Allow / Deny links when a phone can reach the web view
    const links = n.kind === "approval" && e.type === "permission.requested" && e.agentId ? approvalLinks(rt, e.agentId, e.data.requestId) : undefined
    const payload = {
      ...(links ? { actions: links } : {}),
      kind: n.kind,
      title: n.title,
      body: n.body,
      project: rt.state.projectName || projectName(rt.projectRoot),
      agent: e.agentId ? rt.state.agents.get(e.agentId)?.name : undefined,
      ts: e.ts,
    }
    if (cfg.webhook)
      void postWebhook(cfg.webhook, cfg.webhook_format, payload).catch((err) =>
        rt.emit({ type: "log", data: { level: "warn", message: `notify webhook: ${err}` } }),
      )
    if (cfg.command) {
      try {
        Bun.spawn(["sh", "-c", cfg.command], {
          cwd: rt.projectRoot,
          stdin: new TextEncoder().encode(JSON.stringify(payload)),
          stdout: "ignore",
          stderr: "ignore",
          env: { ...process.env, BATON_TITLE: payload.title, BATON_BODY: payload.body, BATON_KIND: payload.kind },
        })
      } catch (err) {
        rt.emit({ type: "log", data: { level: "warn", message: `notify command: ${err}` } })
      }
    }
  })
}

export async function postWebhook(
  url: string,
  format: "json" | "ntfy" | "slack",
  p: { title: string; body: string; kind: string; project: string; actions?: { allow: string; deny: string } },
): Promise<void> {
  const init: RequestInit =
    format === "ntfy"
      ? {
          method: "POST",
          body: p.body,
          headers: {
            Title: `${p.title} · ${p.project}`,
            Tags: p.kind === "approval" ? "warning" : p.kind === "error" ? "x" : "white_check_mark",
            // ntfy action buttons: tapping one POSTs the signed link back to the daemon
            ...(p.actions
              ? { Actions: `http, Allow, ${p.actions.allow}, method=POST, clear=true; http, Deny, ${p.actions.deny}, method=POST, clear=true` }
              : {}),
          },
        }
      : format === "slack"
        ? {
            method: "POST",
            body: JSON.stringify({
              text: `*${p.title}* (${p.project})\n${p.body}${p.actions ? `\n<${p.actions.allow}|Allow> · <${p.actions.deny}|Deny>` : ""}`,
            }),
            headers: { "content-type": "application/json" },
          }
        : { method: "POST", body: JSON.stringify(p), headers: { "content-type": "application/json" } }
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}
