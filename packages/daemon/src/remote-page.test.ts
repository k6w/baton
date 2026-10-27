import { expect, test } from "bun:test"
import { REMOTE_PAGE } from "./remote-page.ts"

test("the web page's script compiles and nothing in it closes the script tag early", () => {
  const scripts = [...REMOTE_PAGE.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "")
  expect(scripts.length).toBe(1)
  const js = scripts[0] ?? ""
  expect(() => new Function(js)).not.toThrow()
  // the page is one template: anything left unreplaced outside the script would show up as text
  expect(REMOTE_PAGE.replace(/<script>[\s\S]*?<\/script>/, "")).not.toContain("${")
  expect(REMOTE_PAGE).toContain('<symbol id="i-inbox"')
})

test("no external assets: everything the page needs is in it", () => {
  expect(REMOTE_PAGE).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/)
  expect(REMOTE_PAGE).not.toMatch(/@import|url\(https?:/)
})
