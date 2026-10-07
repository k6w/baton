import { expect, test } from "bun:test"
import { formatResults, parseDuckDuckGo, webSearch } from "./websearch.ts"

const DDG = `<div class="result results_links web-result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.com%2Fdocs%2Ftest&amp;rut=x">Test runner | <b>Bun</b> Docs</a>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x"><b>Bun&#x27;s</b> fast test runner</a></div>
<div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x.com">Ad</a></div>`

test("DuckDuckGo results are unwrapped, decoded, and ads dropped", () => {
  expect(parseDuckDuckGo(DDG)).toEqual([{ title: "Test runner | Bun Docs", url: "https://bun.com/docs/test", snippet: "Bun's fast test runner" }])
})

test("an API key picks its engine", async () => {
  const calls: string[] = []
  const fake = (async (u: string | URL, init?: RequestInit) => {
    calls.push(`${String(u)} ${JSON.stringify(init?.headers)}`)
    return Response.json({ web: { results: [{ title: "T", url: "https://t.dev", description: "<b>d</b>" }] } })
  }) as typeof fetch
  const r = await webSearch("q x", { env: { BRAVE_API_KEY: "k" }, fetch: fake })
  expect(r).toEqual({ engine: "brave", results: [{ title: "T", url: "https://t.dev", snippet: "d" }] })
  expect(calls[0]).toContain("q=q%20x")
  expect(calls[0]).toContain('"x-subscription-token":"k"')
  expect(formatResults("q", r)).toContain("1. T\n   https://t.dev\n   d")
})
