/**
 * Safe Markdown → HTML for agent text in the web view and HTML exports.
 *
 * Everything is HTML-escaped first, so agent text can never inject markup; only the Markdown
 * we recognise becomes tags, and links must be http(s). Self-contained on purpose: the web page
 * embeds this exact function (`mdToHtml.toString()`), so it must not reference anything outside.
 */
export function mdToHtml(src: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  const inline = (s: string): string => {
    const codes: string[] = []
    let h = esc(s).replace(/`([^`]+)`/g, (_m, c: string) => {
      codes.push(`<code>${c}</code>`)
      return `\u0000${codes.length - 1}\u0000`
    })
    h = h
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a: string, b: string) => `<strong>${a ?? b}</strong>`)
      .replace(/~~([^~]+)~~/g, "<del>$1</del>")
      .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"&])/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>')
    return h.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)] ?? "")
  }
  const lines = src.replace(/\r\n/g, "\n").split("\n")
  const out: string[] = []
  let list: "ul" | "ol" | "" = ""
  let para: string[] = []
  const flush = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`)
    para = []
  }
  const endList = () => {
    if (list) out.push(`</${list}>`)
    list = ""
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const fence = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      flush()
      endList()
      const body: string[] = []
      for (i++; i < lines.length && !(lines[i] ?? "").trim().startsWith(fence[1] ?? "```"); i++) body.push(lines[i] ?? "")
      out.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`)
      continue
    }
    if (!line.trim()) {
      flush()
      endList()
      continue
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      flush()
      endList()
      const n = Math.min(6, (h[1] ?? "#").length + 2)
      out.push(`<h${n}>${inline(h[2] ?? "")}</h${n}>`)
      continue
    }
    const li = /^\s*([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?(.*)$/.exec(line)
    if (li) {
      flush()
      const kind = /\d/.test(li[1] ?? "") ? "ol" : "ul"
      if (list !== kind) {
        endList()
        out.push(`<${kind}>`)
        list = kind
      }
      const box = li[2] ? (/x/i.test(li[2]) ? "☑ " : "☐ ") : ""
      out.push(`<li>${box}${inline(li[3] ?? "")}</li>`)
      continue
    }
    const q = /^\s{0,3}>\s?(.*)$/.exec(line)
    if (q) {
      flush()
      endList()
      out.push(`<blockquote>${inline(q[1] ?? "")}</blockquote>`)
      continue
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush()
      endList()
      out.push("<hr>")
      continue
    }
    endList()
    para.push(line.trim())
  }
  flush()
  endList()
  return out.join("")
}
