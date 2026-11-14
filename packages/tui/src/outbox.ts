/**
 * Messages the user sent from the main input, as the orchestrator pane shows them.
 * The daemon only echoes a message (as a user line) when a turn starts with it, so a message sent
 * to a busy agent would be invisible: the TUI tracks it itself and hides its own copy once the
 * daemon's echo shows up.
 */
import type { FeedItem } from "@batonsh/kernel"
import type { Send } from "./state.ts"

/** Adapters that cannot take input mid-turn (the daemon queues it instead of steering). */
const NO_STEER = new Set(["opencode", "exec"])

export const canSteer = (adapter: string | undefined): boolean => !adapter || !NO_STEER.has(adapter)

/** Leading @mentions of a line ("@a @b text" → ["a", "b"]), or undefined for a plain message. */
export function mentionsOf(text: string): string[] | undefined {
  const out: string[] = []
  let rest = text
  for (let m = /^@([\w.:*-]+)[,\s]*/.exec(rest); m; m = /^@([\w.:*-]+)[,\s]*/.exec(rest)) {
    out.push(m[1]!)
    rest = rest.slice(m[0].length)
  }
  return out.length ? out : undefined
}

export type SendView = { send: Send; marker: "queued" | "steering" | undefined }

/**
 * Sends still worth showing, with their marker. `feed` is the lead's own items and `turn` its
 * current turn start (undefined when idle). A send whose text already appears as a user line (from
 * the daemon) is dropped so it is not shown twice; a steered one turns plain when its turn ends.
 */
export function pendingSends(sends: Send[], feed: FeedItem[], turn: number | undefined): SendView[] {
  const users = feed.filter((i): i is Extract<FeedItem, { kind: "user" }> => i.kind === "user")
  const claimed = new Set<string>()
  const out: SendView[] = []
  for (const send of sends) {
    if (!send.to) {
      const want = send.text.trim()
      const fresh = users.filter((u) => !claimed.has(u.id) && u.ts >= send.ts - 2000)
      // exact first; a substring only for long texts (the daemon may wrap them), so "yes" isn't swallowed by another line
      const echo = fresh.find((u) => u.text.trim() === want) ?? (want.length > 40 ? fresh.find((u) => u.text.includes(want)) : undefined)
      if (echo) {
        claimed.add(echo.id)
        continue
      }
    }
    const marker = send.mode === "queued" ? "queued" : send.mode === "steering" && turn !== undefined && turn === send.turn ? "steering" : undefined
    out.push({ send, marker })
  }
  return out
}

/** A plain message the daemon accepted but routed to nobody (reported as output, not as an error): it was not delivered. */
export const notDelivered = (r: { routedTo: string[] }): boolean => r.routedTo.length === 0
