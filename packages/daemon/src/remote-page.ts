/**
 * The remote web app: one self-contained page (no external assets), black, for phones and
 * desktops alike. Talks to /api/* with the token from the URL fragment.
 * The parts live in ./web: the look (styles.ts), the icons (icons.ts) and the behaviour
 * (client.ts, embedded with toString() like the Markdown renderer).
 */
import { mdToHtml } from "./md-html.ts"
import { webClient } from "./web/client.ts"
import { ICON_SPRITE } from "./web/icons.ts"
import { STYLES } from "./web/styles.ts"

export const REMOTE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#000000">
<meta name="color-scheme" content="dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>baton</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#ff7b3a"/><text x="16" y="22.5" font-family="system-ui,sans-serif" font-size="18" font-weight="800" text-anchor="middle" fill="#1b0b02">b</text></svg>')}">
<style>${STYLES}</style>
</head>
<body>
${ICON_SPRITE}
<div class="app" id="app">
  <aside class="side">
    <div class="brand"><div class="mark">b</div><span class="wordmark">baton</span><span class="led warn" id="conn" title="Connecting…"></span></div>
    <div class="project" id="proj"></div>
    <div class="switch" id="auto" role="radiogroup" aria-label="Autonomy"></div>
    <nav class="nav" id="nav"></nav>
    <div class="side-h"><span>Agents</span><button type="button" data-cmd="/spawn " title="Start agents">${'<svg class="i sm"><use href="#i-plus"/></svg>'}</button></div>
    <div class="agents-nav" id="agentsNav"></div>
    <div class="side-foot" id="foot"></div>
  </aside>
  <section class="main">
    <header class="bar" id="bar"></header>
    <div id="banner"></div>
    <div class="scroll" id="scroll"><div class="content" id="content"></div></div>
    <button class="btn sm jump" id="jump" type="button" hidden>${'<svg class="i xs"><use href="#i-down"/></svg>'} Latest</button>
    <form class="composer" id="composer" autocomplete="off">
      <div class="suggest" id="suggest" hidden></div>
      <div class="cbox">
        <textarea id="text" rows="1" placeholder="Give the lead a task…" aria-label="Message"></textarea>
        <div class="crow"><span class="to" id="to"></span><span class="grow"></span><span class="hint"><kbd>Enter</kbd> send · <kbd>Shift Enter</kbd> new line · <kbd>@</kbd> agent · <kbd>/</kbd> command</span>
          <button class="btn pri icon send" type="submit" title="Send">${'<svg class="i"><use href="#i-send"/></svg>'}</button></div>
      </div>
    </form>
  </section>
  <aside class="insp" id="insp"></aside>
</div>
<nav class="tabbar" id="tabbar"></nav>
<div class="toasts" id="toasts" aria-live="polite"></div>
<div id="layer"></div>
<script>(${webClient.toString()})(${mdToHtml.toString()})</script>
</body>
</html>`
