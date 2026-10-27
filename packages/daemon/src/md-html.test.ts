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

test("what agents write: code with a language, nested and task lists, tables, quotes", () => {
  const h = mdToHtml(
    [
      "```ts",
      "const a = 1 < 2",
      "```",
      "- top",
      "  - nested `x`",
      "- [x] done",
      "- [ ] todo",
      "",
      "3. three",
      "4. four",
      "",
      "| file | +/- |",
      "|:-----|----:|",
      "| a.ts | **+3** |",
      "",
      "> one",
      "> two",
    ].join("\n"),
  )
  expect(h).toContain('<pre data-lang="ts"><code>const a = 1 &lt; 2</code></pre>')
  expect(h).toContain("<ul><li>top<ul><li>nested <code>x</code></li></ul></li>")
  expect(h).toContain('<li class="task done"><span class="box">✓</span> done</li>')
  expect(h).toContain('<li class="task"><span class="box"></span> todo</li>')
  expect(h).toContain('<ol start="3"><li>three</li><li>four</li></ol>')
  expect(h).toContain('<th style="text-align:right">+/-</th>')
  expect(h).toContain('<td style="text-align:right"><strong>+3</strong></td>')
  expect(h).toContain("<blockquote>one<br>two</blockquote>")
  // every list closes
  expect(h.split("<ul>").length).toBe(h.split("</ul>").length)
  expect(h.split("<li").length).toBe(h.split("</li>").length)
})

test("a table cell or a code language can't inject markup either", () => {
  const h = mdToHtml('| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | ok |\n```"><script>\nx\n```')
  expect(h).not.toContain("<img")
  expect(h).not.toContain("<script")
})
