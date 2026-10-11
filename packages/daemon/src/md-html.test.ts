import { expect, test } from "bun:test"
import { mdToHtml } from "./md-html.ts"

test("markdown becomes HTML; agent text can never inject markup", () => {
  const h = mdToHtml("## Done\n**hi** `a<b>` <script>alert(1)</script> [x](javascript:alert(1)) [ok](https://a.dev)\n- one\n```\n<b>raw</b>\n```")
  expect(h).toContain("<h4>Done</h4>")
  expect(h).toContain("<strong>hi</strong>")
  expect(h).toContain("<code>a&lt;b&gt;</code>")
  expect(h).not.toContain("<script>")
  expect(h).not.toContain('href="javascript')
  expect(h).toContain('<a href="https://a.dev"')
  expect(h).toContain("<ul><li>one</li></ul>")
  expect(h).toContain("<pre><code>&lt;b&gt;raw&lt;/b&gt;</code></pre>")
})

test("self-contained: the web page embeds it via toString()", () => {
  const fn = new Function(`return ${mdToHtml.toString()}`)() as typeof mdToHtml
  expect(fn("**x**")).toBe("<p><strong>x</strong></p>")
})
