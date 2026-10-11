/**
 * Build the website: a landing page + docs/*.md + CHANGELOG → dist/site (static, light/dark,
 * works without JavaScript). Published to GitHub Pages by .github/workflows/docs.yml.
 *   bun scripts/docs.ts [--repo owner/name]
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { BATON_VERSION } from "../packages/protocol/src/version.ts"

const REPO = process.argv.includes("--repo") ? process.argv[process.argv.indexOf("--repo") + 1] : (process.env.BATON_REPO ?? "k6w/baton")
const OUT = "dist/site"
const GH = `https://github.com/${REPO}`
const [OWNER = "k6w", NAME = "baton"] = REPO.split("/")
const SITE = `https://${OWNER}.github.io/${NAME}`
// the site serves install.sh too: a shorter line to copy
const INSTALL = `curl -fsSL ${SITE}/install.sh | sh`
const INSTALL_WIN = `irm ${SITE}/install.ps1 | iex`

/** The install command, with a macOS/Linux | Windows switch (CSS only). `id` keeps two of them apart. */
const installBox = (id: string) => `<div class="inst">
<input type="radio" name="os-${id}" id="unix-${id}" checked><label for="unix-${id}">macOS · Linux</label>
<input type="radio" name="os-${id}" id="win-${id}"><label for="win-${id}">Windows</label>
<div class="install unix"><code>${esc(INSTALL)}</code><button class="btn" data-copy="${esc(INSTALL)}" aria-label="Copy the install command">${icon("copy")}</button></div>
<div class="install win"><code class="ps">${esc(INSTALL_WIN)}</code><button class="btn" data-copy="${esc(INSTALL_WIN)}" aria-label="Copy the install command">${icon("copy")}</button></div>
</div>`

/** [file, page, nav title, section]; order = sidebar order. */
const PAGES: [string, string, string, string][] = [
  ["docs/quickstart.md", "quickstart", "Quickstart", "Start here"],
  ["docs/concepts.md", "concepts", "How Baton works", "Start here"],
  ["docs/troubleshooting.md", "troubleshooting", "Troubleshooting & FAQ", "Start here"],
  ["docs/roles.md", "roles", "Roles, skills & notes", "Guides"],
  ["docs/workspaces.md", "workspaces", "Workspaces & reviews", "Guides"],
  ["docs/agents.md", "agents", "Agents & providers", "Guides"],
  ["docs/remote.md", "remote", "Phone & web", "Guides"],
  ["docs/integrations.md", "integrations", "Teams & GitHub", "Guides"],
  ["docs/native-agent.md", "native-agent", "The Baton agent", "Guides"],
  ["docs/a2a.md", "a2a", "A2A", "Guides"],
  ["docs/configuration.md", "configuration", "Configuration", "Reference"],
  ["docs/cli.md", "cli", "Command line", "Reference"],
  ["docs/keybindings.md", "keybindings", "Keybindings", "Reference"],
  ["docs/themes.md", "themes", "Themes & styles", "Reference"],
  ["docs/sdk.md", "sdk", "SDK & protocol", "Reference"],
  ["CHANGELOG.md", "changelog", "Changelog", "Reference"],
]
const SIDE_ICONS: Record<string, string> = {
  quickstart: "rocket",
  concepts: "book-open",
  roles: "users",
  troubleshooting: "life-buoy",
  workspaces: "git-branch",
  agents: "bot",
  remote: "smartphone",
  integrations: "github",
  "native-agent": "sparkles",
  a2a: "network",
  configuration: "settings-2",
  cli: "terminal",
  keybindings: "keyboard",
  themes: "palette",
  sdk: "code-xml",
  changelog: "scroll-text",
}
const byFile = new Map<string, string>([["README.md", "index"], ...PAGES.map(([f, p]): [string, string] => [f.replace(/^docs\//, ""), p])])

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

/** A Lucide icon (docs/assets/icons, ISC), inlined so it follows the text color. */
function icon(name: string, cls = "i"): string {
  const svg = readFileSync(`docs/assets/icons/${name}.svg`, "utf8").replace(/<!--[\s\S]*?-->/g, "")
  return svg
    .replace(/<svg[\s\S]*?>/, (open) => open.replace(/class="[^"]*"/, `class="${cls}" aria-hidden="true"`).replace(/\s(width|height)="[^"]*"/g, ""))
    .replace(/\n\s*/g, " ")
    .trim()
}

/** An agent logo (docs/assets/agents, LobeHub, MIT). */
function agentLogo(file: string): string {
  return readFileSync(`docs/assets/agents/${file}.svg`, "utf8")
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace(/\s(width|height|style)="[^"]*"/g, "")
    .replace("<svg", '<svg class="logo" aria-hidden="true"')
}

/** [name, logo file or lucide icon] for the agents strip. */
const AGENTS: [string, string][] = [
  ["Claude Code", "claude-color"],
  ["Codex", "openai"],
  ["OpenCode", "opencode"],
  ["Gemini CLI", "gemini-color"],
  ["Cursor", "cursor"],
  ["GitHub Copilot", "githubcopilot"],
  ["Goose", "goose"],
  ["Qwen Code", "qwen-color"],
  ["Kiro", "kiro"],
  ["Cline", "cline"],
  ["Kimi", "kimi-color"],
  ["Amp", "amp"],
  ["OpenHands", "openhands-color"],
  ["Junie", "junie-color"],
  ["Mistral Vibe", "mistral-color"],
  ["Aider & any CLI", "lucide:terminal"],
  ["Any ACP agent", "lucide:plug"],
  ["A2A agents", "lucide:workflow"],
]
const agentChip = ([name, art]: [string, string]) => `<span>${art.startsWith("lucide:") ? icon(art.slice(7), "logo") : agentLogo(art)}${esc(name)}</span>`

const LOGO = `<svg class="mark" viewBox="0 0 96 96" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f0883e"/><stop offset="1" stop-color="#1f6feb"/></linearGradient></defs><rect width="96" height="96" rx="24" fill="url(#g)"/><path d="M26 33 L42 48 L26 63" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><rect x="48" y="58" width="24" height="8" rx="4" fill="#fff"/></svg>`

const CSS = `
:root{color-scheme:light dark;--bg:#ffffff;--bg2:#f6f8fa;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--soft:#eef1f4;--code:#f6f8fa;--accent:#0969da;--warm:#bc4c00;--card:#ffffff;--shadow:0 1px 2px #1f232814,0 8px 24px #1f23280f}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--bg2:#010409;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--soft:#161b22;--code:#161b22;--accent:#4493f8;--warm:#f0883e;--card:#0d1117;--shadow:0 8px 30px #0008}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%;scroll-padding-top:72px}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","Inter",system-ui,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,pre,kbd{font-family:ui-monospace,SFMono-Regular,"JetBrains Mono",Menlo,monospace}
kbd{font-size:12.5px;border:1px solid var(--line);border-bottom-width:2px;border-radius:6px;padding:1px 6px;background:var(--soft)}
.mark{width:28px;height:28px;flex:none}
header.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:20px;height:60px;padding:0 24px;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
header.top .brand{display:flex;align-items:center;gap:10px;color:var(--fg);font-weight:700;font-size:18px}
header.top .brand:hover{text-decoration:none}
header.top .ver{font:500 12px ui-monospace,Menlo,monospace;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 8px}
header.top nav{margin-left:auto;display:flex;gap:22px;font-size:15px}
header.top nav a{color:var(--muted)}header.top nav a:hover{color:var(--fg);text-decoration:none}
/* docs layout */
.docs{display:grid;grid-template-columns:260px minmax(0,1fr);max-width:1240px;margin:0 auto}
aside{position:sticky;top:60px;height:calc(100vh - 60px);overflow:auto;padding:28px 18px 40px;border-right:1px solid var(--line)}
aside .sec{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:18px 10px 6px}
aside .sec:first-child{margin-top:0}
aside a{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:6px;color:var(--fg);font-size:14.5px}
aside a svg.i{width:16px;height:16px;color:var(--muted)}aside a.on svg.i{color:var(--accent)}
aside a:hover{background:var(--soft);text-decoration:none}
aside a.on{background:var(--soft);font-weight:600;box-shadow:inset 3px 0 0 var(--accent)}
main.doc{padding:44px 56px 96px;max-width:880px;width:100%}
.doc h1{font-size:38px;line-height:1.15;letter-spacing:-.02em;margin:0 0 18px}
.doc h2{font-size:24px;margin:44px 0 12px;padding-top:12px;border-top:1px solid var(--line);letter-spacing:-.01em}
.doc h3{font-size:18px;margin:28px 0 8px}
.doc h2,.doc h3{position:relative}.anchor{position:absolute;left:-1.1em;opacity:0;color:var(--muted)}.doc h2:hover .anchor,.doc h3:hover .anchor{opacity:1}
.doc p,.doc li{color:var(--fg)}.doc li+li{margin-top:4px}
.doc code{font-size:13.5px;background:var(--code);border:1px solid var(--line);padding:1px 5px;border-radius:6px}
.doc pre{background:var(--code);padding:16px 18px;border-radius:10px;overflow:auto;border:1px solid var(--line);line-height:1.5}
.doc pre code{padding:0;background:none;border:0;font-size:13.5px}
.doc table{border-collapse:collapse;display:block;overflow:auto;margin:18px 0;font-size:15px}
.doc th,.doc td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}.doc td:first-child code{white-space:nowrap}.doc th{background:var(--soft)}
.doc blockquote{margin:16px 0;padding:10px 16px;border-left:3px solid var(--accent);background:var(--soft);border-radius:0 8px 8px 0;color:var(--muted)}
.doc details{border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}.doc summary{cursor:pointer}
.toc{font-size:14px;border:1px solid var(--line);border-radius:10px;padding:12px 18px;margin:0 0 28px;background:var(--soft)}.toc ul{margin:6px 0 0;padding-left:18px}.toc b{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.pager{display:flex;justify-content:space-between;gap:16px;margin-top:64px}
.pager a{flex:1;border:1px solid var(--line);border-radius:10px;padding:12px 16px;color:var(--fg)}.pager a:hover{border-color:var(--accent);text-decoration:none}
.pager small{display:block;color:var(--muted);font-size:12px}.pager .next{text-align:right}
.foot{margin-top:40px;color:var(--muted);font-size:14px;border-top:1px solid var(--line);padding-top:18px}
#menu{display:none}.menubtn{display:none}
/* landing */
.hero{max-width:1100px;margin:0 auto;padding:84px 24px 36px;text-align:center}
.pill{display:inline-flex;gap:8px;align-items:center;font-size:13px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 12px;background:var(--soft)}
.pill b{color:var(--fg)}
.hero h1{font-size:clamp(40px,6.4vw,72px);line-height:1.04;letter-spacing:-.035em;margin:22px 0 18px;font-weight:800}
.grad{background:linear-gradient(100deg,var(--warm),var(--accent));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p.lead{font-size:clamp(17px,2vw,21px);color:var(--muted);max-width:720px;margin:0 auto}
.install{display:flex;align-items:center;gap:10px;max-width:640px;margin:34px auto 0;padding:6px 6px 6px 16px;border:1px solid var(--line);border-radius:12px;background:var(--soft);box-shadow:var(--shadow)}
.install code{flex:1;overflow:auto;white-space:nowrap;font-size:14px;text-align:left}.install code::before{content:"$ ";color:var(--muted)}.install code.ps::before{content:"PS> "}
.inst{max-width:640px;margin:30px auto 0}.inst input{position:absolute;opacity:0;pointer-events:none}
.inst label{display:inline-block;font-size:13px;font-weight:600;color:var(--muted);padding:5px 12px;border-radius:8px 8px 0 0;cursor:pointer}
.inst input:checked+label{color:var(--fg);background:var(--soft);box-shadow:inset 0 -2px 0 var(--accent)}
.inst input:focus-visible+label{outline:2px solid var(--accent)}
.inst .install{margin:0}.inst .install.win{display:none}
.inst input[id^="win"]:checked~.install.win{display:flex}.inst input[id^="win"]:checked~.install.unix{display:none}
.btn{display:inline-flex;align-items:center;gap:8px;border-radius:9px;padding:9px 16px;font-weight:600;font-size:15px;border:1px solid var(--line);color:var(--fg);background:var(--card);cursor:pointer}
.btn:hover{text-decoration:none;border-color:var(--accent)}.btn.primary{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.ctas{display:flex;gap:12px;justify-content:center;margin-top:22px;flex-wrap:wrap}
.window{max-width:1140px;margin:46px auto 0;padding:0 24px}
.frame{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:#010409;box-shadow:0 30px 90px #0b0f1940,0 2px 6px #0003}
.frame .bar{height:36px;display:flex;align-items:center;gap:8px;padding:0 14px;background:#161b22;border-bottom:1px solid #30363d}
.frame .bar i{width:12px;height:12px;border-radius:50%;background:#30363d}.frame .bar span{margin-left:10px;font:12px ui-monospace,Menlo,monospace;color:#7d8590}
.frame img{display:block;width:100%;height:auto}
.caption{text-align:center;color:var(--muted);font-size:14px;margin-top:14px}
section.band{max-width:1100px;margin:0 auto;padding:84px 24px 0}
.band h2{font-size:clamp(28px,3.4vw,40px);letter-spacing:-.025em;line-height:1.1;margin:0 0 12px;text-align:center}
.band p.sub{color:var(--muted);text-align:center;max-width:640px;margin:0 auto 40px;font-size:18px}
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;counter-reset:s}
.step{border:1px solid var(--line);border-radius:14px;padding:22px;background:var(--card)}

.step h3,.card h3{margin:0 0 6px;font-size:17px}.step p,.card p{margin:0;color:var(--muted);font-size:15px}
.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.card{border:1px solid var(--line);border-radius:14px;padding:24px;background:var(--card)}
.card .ic{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;background:var(--soft);border:1px solid var(--line);margin-bottom:14px;color:var(--accent)}
.card .ic svg{width:20px;height:20px}
svg.i{width:18px;height:18px;flex:none}.btn svg.i{width:16px;height:16px}
.agents span{display:inline-flex;align-items:center;gap:9px}
svg.logo{width:20px;height:20px;flex:none;color:var(--fg)}
.step .ic{width:40px;height:40px;border-radius:10px;display:grid;place-items:center;background:var(--soft);border:1px solid var(--line);margin-bottom:14px;color:var(--accent)}.step .ic svg{width:20px;height:20px}
.step h3 small{display:block;font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px}
.agents{display:flex;flex-wrap:wrap;gap:10px;justify-content:center}
.agents span{border:1px solid var(--line);border-radius:999px;padding:8px 16px 8px 12px;font-size:15px;background:var(--soft)}
.dial{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.dial div{border:1px solid var(--line);border-radius:12px;padding:16px 18px}.dial b{display:block;margin-bottom:4px}.dial span{color:var(--muted);font-size:14.5px}
.final{text-align:center;padding:96px 24px 40px}
.final h2{font-size:clamp(28px,3.4vw,40px);letter-spacing:-.025em;margin:0 0 10px}
footer.site{border-top:1px solid var(--line);margin-top:72px;padding:28px 24px;color:var(--muted);font-size:14px;text-align:center}
footer.site a{color:var(--muted)}
@media (max-width:900px){.steps,.cards,.dial{grid-template-columns:1fr 1fr}}
@media (max-width:820px){
 header.top{padding:0 16px;gap:12px}header.top nav{gap:14px;font-size:14px}header.top nav .opt{display:none}
 .docs{display:block}aside{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line);padding:10px 16px}
 aside .links{display:none}#menu:checked~.links{display:block;padding-bottom:10px}
 .menubtn{display:block;cursor:pointer;color:var(--fg);font-weight:600;padding:6px 0}
 main.doc{padding:24px 16px 64px}.anchor{display:none}.hero{padding:52px 16px 20px}.window,section.band{padding-left:16px;padding-right:16px}
 .steps,.cards,.dial{grid-template-columns:1fr}.pager{flex-direction:column}
}
`

const COPY_JS = `<script>for(const b of document.querySelectorAll("[data-copy]"))b.addEventListener("click",()=>{navigator.clipboard?.writeText(b.dataset.copy).then(()=>{const h=b.innerHTML;b.innerHTML=${JSON.stringify(icon("check"))};setTimeout(()=>b.innerHTML=h,1400)})})</script>`

function head(title: string, description: string, path: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${SITE}/${path}">
<meta property="og:image" content="${SITE}/assets/social.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${SITE}/assets/social.png">
<link rel="icon" href="assets/logo.svg" type="image/svg+xml">
<style>${CSS}</style></head>`
}

const topbar = (here: string) => `<header class="top"><a class="brand" href="index.html">${LOGO}Baton</a><span class="ver">v${BATON_VERSION}</span>
<nav><a href="quickstart.html"${here === "docs" ? ' style="color:var(--fg)"' : ""}>Docs</a><a class="opt" href="concepts.html">How it works</a><a class="opt" href="${GH}/releases">Releases</a><a href="${GH}">GitHub</a></nav></header>`

rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

// ───────────────────────────── docs pages ─────────────────────────────
PAGES.forEach(([file, page, title], i) => {
  if (!existsSync(file)) throw new Error(`missing ${file}`)
  const md = readFileSync(file, "utf8")
  const { html, toc } = anchor(rewriteLinks(Bun.markdown.html(md, {})))
  const h2 = toc.filter((t) => t.level === 2)
  const tocHtml =
    h2.length >= 4 ? `<div class="toc"><b>On this page</b><ul>${h2.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join("")}</ul></div>` : ""
  const body = tocHtml ? html.replace(/(<\/h1>)/, `$1${tocHtml}`) : html
  let side = ""
  let section = ""
  for (const [, p, t, s] of PAGES) {
    if (s !== section) {
      side += `<div class="sec">${esc(s)}</div>`
      section = s
    }
    side += `<a${p === page ? ' class="on"' : ""} href="${p}.html">${icon(SIDE_ICONS[p] ?? "book-open")}${esc(t)}</a>`
  }
  const prev = PAGES[i - 1]
  const next = PAGES[i + 1]
  const pager = `<div class="pager">${prev ? `<a href="${prev[1]}.html"><small>Previous</small>${esc(prev[2])}</a>` : "<span></span>"}${
    next ? `<a class="next" href="${next[1]}.html"><small>Next</small>${esc(next[2])}</a>` : "<span></span>"
  }</div>`
  const firstPara =
    /<p>([\s\S]*?)<\/p>/
      .exec(html)?.[1]
      ?.replace(/<[^>]+>/g, "")
      .slice(0, 180) ?? ""
  writeFileSync(
    `${OUT}/${page}.html`,
    `${head(`${title} · Baton`, firstPara || "Baton: one terminal for all your coding agents.", `${page}.html`)}
<body>${topbar("docs")}<div class="docs"><aside><input type="checkbox" id="menu"><label class="menubtn" for="menu">☰ ${esc(title)}</label><div class="links">${side}</div></aside>
<main class="doc">${body}${pager}<div class="foot">Baton ${BATON_VERSION} · MIT · <a href="${GH}/edit/main/${file}">Edit this page on GitHub</a></div></main></div></body></html>
`,
  )
})

// ───────────────────────────── landing page ─────────────────────────────
const card = (ic: string, title: string, text: string) => `<div class="card"><div class="ic">${icon(ic)}</div><h3>${title}</h3><p>${text}</p></div>`
const landing = `${head("Baton: one terminal for all your coding agents", "Claude Code, Codex, OpenCode, Gemini and more, working together as one team on your code. Free and open source.", "")}
<body>${topbar("home")}
<div class="hero">
  <span class="pill"><b>v${BATON_VERSION}</b> · free & open source · macOS, Linux and Windows</span>
  <h1>One terminal for all<br>your <span class="grad">coding agents</span>.</h1>
  <p class="lead">Claude Code, Codex, OpenCode, Gemini and more, working together as one team on your code. They plan, split the work, review each other, and merge only what passes your tests.</p>
  ${installBox("top")}
  <div class="ctas"><a class="btn primary" href="quickstart.html">Get started ${icon("arrow-right")}</a><a class="btn" href="concepts.html">${icon("book-open")}How it works</a><a class="btn" href="${GH}">${icon("github")}GitHub</a></div>
</div>
<div class="window"><div class="frame"><div class="bar"><i></i><i></i><i></i><span>baton · my-app</span></div>
<img src="assets/demo.gif" alt="Baton running a lead agent and four workers from different vendors: they split a task, message each other, ask for approval and report back" width="1206" height="819"></div>
<p class="caption">A lead agent splits a task across Claude, Codex, Gemini and OpenCode. You approve one command, zoom into an agent, and turn the autonomy dial. (<code>baton demo</code>: simulated, no tokens.)</p></div>

<section class="band">
  <h2>How it works</h2>
  <p class="sub">You describe what you want. Your agents do the rest, in the open, with you in charge.</p>
  <div class="steps">
    <div class="step"><div class="ic">${icon("terminal")}</div><h3><small>Step 1</small>You ask</h3><p>Type a task in plain words. Talk to any agent directly with <code>@name</code>.</p></div>
    <div class="step"><div class="ic">${icon("sparkles")}</div><h3><small>Step 2</small>The lead plans</h3><p>An orchestrator agent splits the work and picks the right agents and models for each part.</p></div>
    <div class="step"><div class="ic">${icon("git-branch")}</div><h3><small>Step 3</small>Workers build</h3><p>Each worker edits its own git worktree, a private copy, and they message each other as they go.</p></div>
    <div class="step"><div class="ic">${icon("git-merge")}</div><h3><small>Step 4</small>Review, then merge</h3><p>A different vendor reviews every change. It merges into your project only after your tests pass.</p></div>
  </div>
</section>

<section class="band">
  <h2>Built for running many agents</h2>
  <p class="sub">Everything you need to trust a team of agents with real work.</p>
  <div class="cards">
    ${card("inbox", "One inbox", "Approvals, plans, stuck agents, conflicts: everything that needs you is in one place. <kbd>ctrl</kbd>+<kbd>a</kbd>, then approve with one key.")}
    ${card("shield-check", "Safe by default", "Private worktrees, cross-vendor reviews, your test gate, undo for every merge, and deny rules that hold even in YOLO mode.")}
    ${card("gauge", "One autonomy dial", "<kbd>shift</kbd>+<kbd>tab</kbd> switches every agent at once between normal, auto, YOLO and ask-first, even mid-run.")}
    ${card("messages-square", "Agents that talk", "A message bus between agents: they coordinate files, hand off work, and report results back automatically.")}
    ${card("smartphone", "From your phone", "<code>baton web --lan</code> shows a QR code: follow along, approve and send tasks from your phone. One-tap approvals from notifications.")}
    ${card("chart-column", "Learns who's good at what", "A track record per agent and task kind in your project. The lead uses it to pick agents, and cheaper ones win close calls.")}
  </div>
</section>

<section class="band">
  <h2>Every worker gets a real brief</h2>
  <p class="sub">A worker only knows what it's told. Roles, checks, skills and team memory make sure it's told the right things.</p>
  <div class="cards">
    ${card("users", "Roles", "Tester, reviewer, debugger, security, researcher, frontend, or your own. Each brings instructions, a model size and an access level; read-only roles can't edit, even in YOLO.")}
    ${card("badge-check", "Acceptance checks", "The lead sets a command like <code>bun test src/auth</code>. Baton runs it when the worker is done: the work counts only when it passes.")}
    ${card("brain", "Skills and team notes", "Skills in <code>.baton/skills</code> (or your <code>.claude/skills</code>) for every agent, and facts the team learns go into notes every new worker starts with.")}
  </div>
</section>

<section class="band">
  <h2>You decide how much freedom they get</h2>
  <p class="sub">One dial for every agent, the lead and the workers. Your own rules always apply.</p>
  <div class="dial">
    <div><b>◆ normal</b><span>Each agent's defaults: edits are fine, risky commands ask.</span></div>
    <div><b>↯ auto</b><span>They act on their own; destructive commands still ask.</span></div>
    <div><b>▲ yolo</b><span>No prompts, no sandbox. Your deny rules still apply.</span></div>
    <div><b>◇ ask</b><span>Every edit and command waits for you.</span></div>
  </div>
</section>

<section class="band">
  <h2>Works with the agents you already use</h2>
  <p class="sub">Baton runs the official tools with your own logins, through their real interfaces. Bring one agent or ten.</p>
  <div class="agents">${AGENTS.map(agentChip).join("")}<span>${LOGO.replace('class="mark"', 'class="logo"')}Baton's own agent: any model</span></div>
</section>

<section class="band">
  <h2>More than a terminal</h2>
  <p class="sub">Use it from scripts, from other tools, and from GitHub.</p>
  <div class="cards">
    ${card("terminal", "Scripts & CI", '<code>baton run "update the changelog" --approve all --json</code> runs a whole team headless.')}
    ${card("plug", "MCP & A2A", "<code>baton mcp</code> lets Claude Desktop or Cursor hand tasks to your team. <code>baton a2a</code> serves it to other agents.")}
    ${card("github", "GitHub", "<code>baton issue 42</code> starts from an issue, and <code>/pr</code> opens a draft pull request from what merged.")}
    ${card("history", "History & replay", "Every run is saved: resume it, replay it like a video, or export it as Markdown or HTML.")}
    ${card("palette", "Make it yours", "11 styles, ~50 themes (all WCAG-contrast), 5 layouts, and every key and setting explained in the app.")}
    ${card("code-xml", "SDKs", "Drive Baton from TypeScript or Python: start runs, stream events, answer approvals.")}
  </div>
</section>

<div class="final">
  <h2>Try it in a minute, for free</h2>
  <p class="sub" style="color:var(--muted);font-size:18px;margin:0 0 26px">Install, then run <code>baton demo</code>: simulated agents, no tokens, no setup.</p>
  ${installBox("bottom")}
  <div class="ctas"><a class="btn primary" href="quickstart.html">Read the quickstart ${icon("arrow-right")}</a><a class="btn" href="cli.html">${icon("terminal")}Command line</a><a class="btn" href="troubleshooting.html">FAQ</a></div>
</div>
<footer class="site">Baton ${BATON_VERSION} · MIT licensed · <a href="${GH}">GitHub</a> · <a href="changelog.html">Changelog</a> · <a href="${GH}/issues">Report an issue</a></footer>
${COPY_JS}</body></html>
`
writeFileSync(`${OUT}/index.html`, landing)

// assets (demo GIF, screenshot, social card, logo) and the installer (`curl …/install.sh | sh` works from the site too)
cpSync("docs/assets", `${OUT}/assets`, { recursive: true })
copyFileSync("install.sh", `${OUT}/install.sh`)
copyFileSync("install.ps1", `${OUT}/install.ps1`)
writeFileSync(`${OUT}/.nojekyll`, "")
console.log(`site: landing + ${PAGES.length} pages → ${OUT}`)
