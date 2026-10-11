/**
 * Build the documentation site: README + docs/*.md + CHANGELOG → dist/site/*.html (static, no
 * JavaScript, light/dark). Published to GitHub Pages by .github/workflows/docs.yml.
 *   bun scripts/docs.ts [--repo owner/name]
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { BATON_VERSION } from "../packages/protocol/src/version.ts"

const REPO = process.argv.includes("--repo") ? process.argv[process.argv.indexOf("--repo") + 1] : (process.env.BATON_REPO ?? "k6w/baton")
const OUT = "dist/site"
const GH = `https://github.com/${REPO}`

/** [file, page, nav title]; order = sidebar order. */
const PAGES: [string, string, string][] = [
  ["README.md", "index", "Overview"],
  ["docs/quickstart.md", "quickstart", "Quickstart"],
  ["docs/workspaces.md", "workspaces", "Workspaces & reviews"],
  ["docs/agents.md", "agents", "Agents & providers"],
  ["docs/configuration.md", "configuration", "Configuration"],
  ["docs/themes.md", "themes", "Themes & styles"],
  ["docs/keybindings.md", "keybindings", "Keybindings"],
  ["docs/remote.md", "remote", "Phone & web"],
  ["docs/integrations.md", "integrations", "Teams & integrations"],
  ["docs/native-agent.md", "native-agent", "The Baton agent"],
  ["docs/a2a.md", "a2a", "A2A"],
  ["docs/sdk.md", "sdk", "SDK & protocol"],
  ["docs/troubleshooting.md", "troubleshooting", "Troubleshooting & FAQ"],
  ["CHANGELOG.md", "changelog", "Changelog"],
]
const byFile = new Map(PAGES.map(([f, p]) => [f.replace(/^docs\//, ""), p]))

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const slug = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

/** Links between markdown files → pages; anything else in the repo → GitHub. */
function rewriteLinks(html: string): string {
  return html.replace(/href="([^"]+)"/g, (m, href: string) => {
    if (/^(https?:|mailto:|#)/.test(href)) return m
    const [path = "", hash] = href.split("#")
    const name = path.replace(/^(\.\/|\.\.\/)+/, "").replace(/^docs\//, "")
    const page = byFile.get(name)
    if (page) return `href="${page}.html${hash ? `#${hash}` : ""}"`
    return `href="${GH}/blob/main/${path.replace(/^(\.\/|\.\.\/)+/, "")}${hash ? `#${hash}` : ""}"`
  })
}

/** ids on h2/h3 (so links and the table of contents work); returns the toc. */
function anchor(html: string): { html: string; toc: { level: number; id: string; text: string }[] } {
  const toc: { level: number; id: string; text: string }[] = []
  const seen = new Map<string, number>()
  const out = html.replace(/<h([23])>([\s\S]*?)<\/h\1>/g, (_m, level: string, inner: string) => {
    let id = slug(inner) || "section"
    const n = seen.get(id) ?? 0
    seen.set(id, n + 1)
    if (n) id = `${id}-${n}`
    toc.push({ level: Number(level), id, text: inner.replace(/<[^>]+>/g, "") })
    return `<h${level} id="${id}"><a class="anchor" href="#${id}" aria-hidden="true">#</a>${inner}</h${level}>`
  })
  return { html: out, toc }
}

const CSS = `
:root{--bg:#fbfaf8;--fg:#1d1d1f;--muted:#6b6b70;--line:#e6e3dd;--code:#f2efe9;--accent:#c2410c;--side:#f6f4f0}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--fg:#e8e6e3;--muted:#9a9aa0;--line:#2a2a2e;--code:#1e1e22;--accent:#fb923c;--side:#18181b}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.wrap{display:grid;grid-template-columns:250px minmax(0,1fr);min-height:100vh}
nav{background:var(--side);border-right:1px solid var(--line);padding:24px 16px;position:sticky;top:0;height:100vh;overflow:auto}
nav .brand{font-weight:700;font-size:20px;color:var(--fg);display:block;margin:0 8px 4px}
nav .ver{color:var(--muted);font-size:13px;margin:0 8px 18px}
nav a.p{display:block;padding:5px 8px;border-radius:6px;color:var(--fg);font-size:15px}
nav a.p.on{background:var(--code);font-weight:600}
nav .ext{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}
main{padding:40px 48px 80px;max-width:900px;width:100%}
h1{font-size:34px;line-height:1.2;margin:0 0 16px}h2{margin-top:40px;padding-top:8px;border-top:1px solid var(--line)}
h2,h3{position:relative}.anchor{position:absolute;left:-1em;opacity:0;color:var(--muted)}h2:hover .anchor,h3:hover .anchor{opacity:1}
code{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--code);padding:14px 16px;border-radius:8px;overflow:auto;border:1px solid var(--line)}pre code{padding:0;background:none}
table{border-collapse:collapse;display:block;overflow:auto;margin:16px 0}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}th{background:var(--side)}
blockquote{margin:0;padding:0 16px;border-left:3px solid var(--line);color:var(--muted)}
.toc{font-size:14px;border:1px solid var(--line);border-radius:8px;padding:10px 16px;margin:0 0 24px}.toc ul{margin:4px 0;padding-left:18px}
.foot{margin-top:60px;color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:16px}
#menu{display:none}
@media (max-width:820px){.wrap{display:block}nav{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:12px 16px}
nav .links{display:none}#menu:checked~.links{display:block}nav label{float:right;cursor:pointer;color:var(--muted);margin-top:4px}
main{padding:24px 16px 60px}.anchor{display:none}}
@media (min-width:821px){nav label{display:none}}
`

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })
for (const [file, page, title] of PAGES) {
  if (!existsSync(file)) throw new Error(`missing ${file}`)
  const md = readFileSync(file, "utf8")
  const { html, toc } = anchor(rewriteLinks(Bun.markdown.html(md, {})))
  const h2 = toc.filter((t) => t.level === 2)
  const tocHtml =
    page !== "index" && h2.length >= 4
      ? `<div class="toc"><b>On this page</b><ul>${h2.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join("")}</ul></div>`
      : ""
  const body = tocHtml ? html.replace(/(<\/h1>)/, `$1${tocHtml}`) : html
  const nav = PAGES.map(([, p, t]) => `<a class="p${p === page ? " on" : ""}" href="${p}.html">${esc(t)}</a>`).join("")
  writeFileSync(
    `${OUT}/${page}.html`,
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${page === "index" ? "Baton: one terminal for all your coding agents" : `${esc(title)} · Baton`}</title>
<meta name="description" content="Baton runs Claude Code, Codex, OpenCode and more as one team in your terminal.">
<style>${CSS}</style></head>
<body><div class="wrap"><nav><a class="brand" href="index.html">Baton</a><div class="ver">v${BATON_VERSION}</div>
<input type="checkbox" id="menu"><label for="menu">menu</label><div class="links">${nav}
<div class="ext"><a class="p" href="${GH}">GitHub</a><a class="p" href="${GH}/releases">Releases</a></div></div></nav>
<main>${body}<div class="foot">Baton ${BATON_VERSION} · MIT · <a href="${GH}/edit/main/${file}">Edit this page</a></div></main></div></body></html>
`,
  )
}
// the recorded demo (docs/demo.tape → dist/demo.gif), when there is one
if (existsSync("dist/demo.gif")) {
  copyFileSync("dist/demo.gif", `${OUT}/demo.gif`)
  const index = readFileSync(`${OUT}/index.html`, "utf8")
  writeFileSync(
    `${OUT}/index.html`,
    index.replace(
      /<pre>[\s\S]*?<\/pre>/,
      '<img src="demo.gif" alt="Baton running a team of agents" style="width:100%;border-radius:8px;border:1px solid var(--line)">',
    ),
  )
}
// `curl …/install.sh | sh` also works from the site
copyFileSync("install.sh", `${OUT}/install.sh`)
writeFileSync(`${OUT}/.nojekyll`, "")
console.log(`docs: ${PAGES.length} pages → ${OUT}`)
