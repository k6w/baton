import { expect, test } from "bun:test"
import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startDaemon } from "./daemon.ts"

test("two daemons for one project: the second refuses instead of stealing the socket", async () => {
  process.env.BATON_CONFIG_DIR = mkdtempSync(join(tmpdir(), "baton-cfg-"))
  process.env.BATON_STATE_DIR = mkdtempSync(join(tmpdir(), "baton-state-"))
  const root = mkdtempSync(join(tmpdir(), "baton-lock-"))
  const socketPath = join(root, "d.sock")
  const overrides = { bus: { heartbeat_s: 0 }, orchestrator: { agent: "mock" } }
  const results = await Promise.allSettled([
    startDaemon({ projectRoot: root, socketPath, overrides }),
    startDaemon({ projectRoot: root, socketPath, overrides }),
  ])
  const ok = results.filter((r) => r.status === "fulfilled")
  const failed = results.filter((r) => r.status === "rejected")
  expect(ok.length).toBe(1)
  expect(String((failed[0] as PromiseRejectedResult).reason)).toContain("already")
  const d = (ok[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof startDaemon>>>).value
  expect(existsSync(socketPath)).toBe(true)
  await d.stop()
  // the lock is released: a new daemon starts fine
  const again = await startDaemon({ projectRoot: root, socketPath, overrides })
  await again.stop()
})
