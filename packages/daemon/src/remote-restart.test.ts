import { afterEach, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BatonConfig } from "@batonsh/kernel"
import { ensureRemote, stopRemote } from "./remote.ts"
import { Runtime } from "./runtime.ts"

const runtimes: Runtime[] = []
afterEach(async () => {
  for (const rt of runtimes.splice(0)) {
    stopRemote(rt)
    await rt.close()
  }
})
const setup = (remote: Record<string, unknown> = {}) => {
  const rt = new Runtime({ projectRoot: mkdtempSync(join(tmpdir(), "baton-web-")), config: BatonConfig.parse({ bus: { heartbeat_s: 0 }, remote }) })
  runtimes.push(rt)
  return rt
}

test("reopening /web keeps the running web view (phone access stays on, same link)", () => {
  const rt = setup()
  const phone = ensureRemote(rt, { lan: true })
  // esc, then /web again: no options → the same server, not a restart back to local-only
  expect(ensureRemote(rt, {})).toBe(phone)
  expect(ensureRemote(rt, {}).lan).toBe(true)
})

test("a restart whose old port is taken falls back to a free one; a configured port says so clearly", () => {
  const rt = setup()
  const first = ensureRemote(rt, {})
  const port = first.port
  stopRemote(rt)
  const squatter = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("other program") })
  try {
    // a restart (lan → local) while something else holds the old port
    const lan = ensureRemote(rt, { lan: true })
    const back = ensureRemote(rt, { lan: false })
    expect(back.port).toBeGreaterThan(0)
    expect(back.lan).toBe(false)
    expect(lan.port).toBeGreaterThan(0)
    stopRemote(rt)
    const fixed = setup({ port })
    expect(() => ensureRemote(fixed, {})).toThrow(`port ${port} is in use by another program`)
  } finally {
    squatter.stop(true)
  }
})
