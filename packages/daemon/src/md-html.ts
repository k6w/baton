/**
 * Safe Markdown → HTML for agent text in the web view and HTML exports.
 *
 * Everything is HTML-escaped first, so agent text can never inject markup; only the Markdown
 * we recognise becomes tags, and links must be http(s). Self-contained on purpose: the web page
 * embeds this exact function (`mdToHtml.toString()`), so it must not reference anything outside.
 *
 * Agents write a lot of a few things: fenced code (with a language), nested lists, task lists,
 * tables of results, file paths and `inline code`. Those get proper structure; anything else
 * stays readable text.
 */
export function mdToHtml(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  const inline = (s: string): string => {
    // code, links and bare URLs are set aside first: stars and underscores inside them aren't markup
    const kept: string[] = []
    const keep = (html: string) => {
      kept.push(html)
      return `\u0000${kept.length - 1}\u0000`
    }
    const link = (href: string, text: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
    let h = esc(s)
      .replace(/`([^`]+)`/g, (_m, c: string) => keep(`<code>${c}</code>`))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t: string, u: string) => keep(link(u, t)))
      .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"&])/g, (_m, p: string, u: string) => p + keep(link(u, u)))
    h = h
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      // underscores only at word edges: src/__init__.py and snake_case_names stay as they are
      .replace(/(^|[\s(>])__([^_\s][^_]*?)__(?=$|[\s).,;:!?<])/g, "$1<strong>$2</strong>")
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[\s(>])_([^_\s][^_]*?)_(?=$|[\s).,;:!?<])/g, "$1<em>$2</em>")
    // a link's text can hold code: put back until nothing is left
    for (let n = 0; n < 3 && h.includes("\u0000"); n++) h = h.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? "")
    return h
  }
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim())
  const isRule = (row: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(row)
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let para: string[] = []
  // open lists, innermost last: their kind and the indent of their items
  const lists: { kind: "ul" | "ol"; indent: number }[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`)
    para = []
  }
  const closeLists = (toIndent = -1) => {
    while (lists.length && lists[lists.length - 1]!.indent > toIndent) out.push(`</li></${lists.pop()!.kind}>`)
  }
  const endBlock = () => {
    flush()
    closeLists()
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)/.exec(line)
    if (fence) {
      endBlock()
      const body: string[] = []
      for (i++; i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```"); i++) body.push(lines[i] ?? "")
      const lang = (fence[2] ?? "").toLowerCase()
      out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(body.join("\n"))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      flush()
      if (!lists.length) continue
      // blank lines inside a list don't end it when the list goes on after them
      let j = i + 1
      while (j < lines.length && !(lines[j] ?? "").trim()) j++
      if (j >= lines.length || !/^\s*([-*+]|\d{1,3}[.)])\s+/.test(lines[j] ?? "")) closeLists()
      i = j - 1
      continue
    }
    if (line.includes("|") && isRule(lines[i + 1] ?? "") && cells(line).length > 1) {
      endBlock()
      const head = cells(line)
      const align = cells(lines[i + 1] ?? "").map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : ""))
      const th = head.map((c, j) => `<th${align[j] ? ` style="text-align:${align[j]}"` : ""}>${inline(c)}</th>`).join("")
      const rows: string[] = []
      for (i += 2; i < lines.length && (lines[i] ?? "").includes("|") && (lines[i] ?? "").trim(); i++) {
        const r = cells(lines[i] ?? "")
        rows.push(`<tr>${head.map((_c, j) => `<td${align[j] ? ` style="text-align:${align[j]}"` : ""}>${inline(r[j] ?? "")}</td>`).join("")}</tr>`)
      }
      i--
      out.push(`<div class="tbl"><table><thead><tr>${th}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`)
      continue
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      endBlock()
      const n = Math.min(6, (h[1] ?? "#").length + 2)
      // closing #s ("## Title ##"), without a regex that backtracks on long runs of spaces
      let t = (h[2] ?? "").trimEnd()
      let j = t.length
      while (j > 0 && t[j - 1] === "#") j--
      if (j < t.length && (j === 0 || /\s/.test(t[j - 1] ?? ""))) t = t.slice(0, j).trimEnd()
      out.push(`<h${n}>${inline(t)}</h${n}>`)
      continue
    }
    const li = /^(\s*)([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line)
    if (li && !/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      const indent = (li[1] ?? "").replace(/\t/g, "    ").length
      const kind = /\d/.test(li[2] ?? "") ? "ol" : "ul"
      closeLists(indent)
      const top = lists[lists.length - 1]
      if (top && top.indent === indent && top.kind !== kind) out.push(`</li></${lists.pop()!.kind}>`)
      const cur = lists[lists.length - 1]
      if (cur && cur.indent === indent) out.push("</li><li")
      else {
        const start = kind === "ol" ? Number.parseInt(li[2] ?? "1", 10) : 1
        out.push(`<${kind}${kind === "ol" && start !== 1 ? ` start="${start}"` : ""}><li`)
        lists.push({ kind, indent })
      }
      const box = li[3] ? (/x/i.test(li[3]) ? ' class="task done"><span class="box">✓</span> ' : ' class="task"><span class="box"></span> ') : ">"
      out.push(`${box}${inline(li[4] ?? "")}`)
      continue
    }
    // a wrapped line of a list item
    if (lists.length && /^\s+\S/.test(line) && !para.length) {
      out.push(` ${inline(line.trim())}`)
      continue
    }
    const q = /^\s{0,3}>\s?(.*)$/.exec(line)
    if (q) {
      endBlock()
      const body = [q[1] ?? ""]
      for (; /^\s{0,3}>/.test(lines[i + 1] ?? ""); i++) body.push((lines[i + 1] ?? "").replace(/^\s{0,3}>\s?/, ""))
      out.push(`<blockquote>${body.map(inline).join("<br>")}</blockquote>`)
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      endBlock()
      out.push("<hr>")
      continue
    }
    closeLists()
    para.push(line.trim())
  }
  endBlock()
  return out.join("")
}
