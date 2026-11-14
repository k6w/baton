import { expect, test } from "bun:test"
import type { FeedItem } from "@batonsh/kernel"
import { mentionsOf, notDelivered, pendingSends } from "./outbox.ts"
import type { Send } from "./state.ts"

const send = (o: Partial<Send>): Send => ({ id: 1, text: "do it", ts: 10_000, mode: "queued", ...o })
const user = (text: string, ts: number): FeedItem => ({ kind: "user", id: `u${ts}`, text, ts })

test("queued stays queued until the daemon echoes it as a user line, then it is dropped", () => {
  expect(pendingSends([send({})], [], 5)[0]?.marker).toBe("queued")
  expect(pendingSends([send({})], [user("do it", 10_500)], undefined)).toEqual([])
  // an older line with the same text is not its echo
  expect(pendingSends([send({})], [user("do it", 100)], 5)).toHaveLength(1)
})

test("one echo only consumes one send", () => {
  const out = pendingSends([send({ id: 1 }), send({ id: 2 })], [user("do it", 10_500)], 5)
  expect(out.map((v) => v.send.id)).toEqual([2])
})

test("steering is marked during its turn and plain afterwards; direct messages are never matched", () => {
  const s = send({ mode: "steering", turn: 7 })
  expect(pendingSends([s], [], 7)[0]?.marker).toBe("steering")
  expect(pendingSends([s], [], 9)[0]?.marker).toBeUndefined()
  expect(pendingSends([s], [], undefined)[0]?.marker).toBeUndefined()
  const dm = send({ mode: "sent", to: ["codex-1"] })
  expect(pendingSends([dm], [user("do it", 10_500)], undefined)).toHaveLength(1)
})

test("mentionsOf", () => {
  expect(mentionsOf("@a @b hi")).toEqual(["a", "b"])
  expect(mentionsOf("hi @a")).toBeUndefined()
})

test("a short message is only matched by an exact line, a long one by a containing line", () => {
  const short = send({ text: "yes" })
  expect(pendingSends([short], [user("yes, and also refactor the parser", 10_500)], 5)).toHaveLength(1)
  expect(pendingSends([short], [user(" yes ", 10_500)], 5)).toEqual([])
  const long = send({ text: "please refactor the parser module and add tests for it" })
  expect(pendingSends([long], [user(`[baton] ${long.text}\n\n(extra)`, 10_500)], 5)).toEqual([])
})

test("a message routed to nobody counts as not delivered", () => {
  expect(notDelivered({ routedTo: [] })).toBe(true)
  expect(notDelivered({ routedTo: ["lead"] })).toBe(false)
})
