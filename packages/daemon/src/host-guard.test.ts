import { expect, test } from "bun:test"
import { hostname } from "node:os"
import { hostAllowed, hostOf } from "./host-guard.ts"

test("Host header parsing", () => {
  expect(hostOf("127.0.0.1:4100")).toBe("127.0.0.1")
  expect(hostOf("[::1]:80")).toBe("::1")
  expect(hostOf("Evil.Example.:8080")).toBe("evil.example")
  expect(hostOf(null)).toBe("")
})

test("only IPs, localhost, this machine and configured names pass (DNS rebinding)", () => {
  for (const ok of ["127.0.0.1:1", "192.168.1.20:4500", "[::1]:3", "localhost:9", "app.localhost", hostname(), `${hostname().split(".")[0]}.local`])
    expect(hostAllowed(ok)).toBe(true)
  expect(hostAllowed("evil.example:4100")).toBe(false)
  expect(hostAllowed("baton.example.com")).toBe(false)
  expect(hostAllowed("baton.example.com", ["https://baton.example.com/a2a"])).toBe(true)
})
