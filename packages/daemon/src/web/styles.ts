/**
 * The web view's look: black, quiet, dense where it helps. A light touch of skeuomorphism:
 * raised controls catch a hairline of light on their top edge, inputs and code sit in
 * recessed wells, and status lights glow like LEDs. Nothing else is decorated.
 */
export const STYLES = `
:root {
  color-scheme: dark;
  --bg: #000; --bg-1: #060606; --bg-2: #0b0b0b;
  --surface: #0f0f0f; --surface-2: #151515; --surface-3: #1c1c1c; --surface-4: #242424;
  --line: rgba(255,255,255,.065); --line-2: rgba(255,255,255,.1); --line-3: rgba(255,255,255,.16);
  --text: #f3f3f3; --text-2: #b8b8b8; --text-3: #808080; --text-4: #575757;
  --accent: #ff7b3a; --accent-2: #ff9a5c; --accent-ink: #1b0b02; --accent-soft: rgba(255,123,58,.12);
  --ok: #3fd98a; --warn: #ffb648; --err: #ff5d5a; --info: #67b7ff; --violet: #b49cff;
  --ok-soft: rgba(63,217,138,.1); --warn-soft: rgba(255,182,72,.1); --err-soft: rgba(255,93,90,.1); --info-soft: rgba(103,183,255,.1);
  --r-xs: 5px; --r-sm: 7px; --r: 10px; --r-lg: 14px; --r-xl: 18px;
  --edge: inset 0 1px 0 rgba(255,255,255,.055);
  --raise: 0 1px 0 rgba(0,0,0,.9), 0 1px 3px rgba(0,0,0,.6);
  --float: 0 18px 50px rgba(0,0,0,.75), 0 2px 8px rgba(0,0,0,.6);
  --well: inset 0 1px 2px rgba(0,0,0,.9), inset 0 0 0 1px rgba(255,255,255,.035);
  --sans: "Inter", "InterVariable", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI Variable Text", "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --mono: "JetBrains Mono", "Cascadia Code", "SF Mono", ui-monospace, Menlo, Consolas, "Liberation Mono", monospace;
  --side: 272px; --insp: 340px; --bar: 56px;
  --ease: cubic-bezier(.2,.7,.2,1);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); }
body { font: 14px/1.55 var(--sans); -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility;
  font-feature-settings: "cv11", "ss01", "ss03"; overflow: hidden; }
button, input, textarea, select { font: inherit; color: inherit; }
button { cursor: pointer; -webkit-tap-highlight-color: transparent; }
a { color: var(--accent-2); text-decoration: none; } a:hover { text-decoration: underline; text-underline-offset: 2px; }
::selection { background: rgba(255,123,58,.32); }
.num { font-variant-numeric: tabular-nums; }
.mono { font-family: var(--mono); font-size: 12.5px; }
.dim { color: var(--text-3); } .faint { color: var(--text-4); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
svg.i { width: 16px; height: 16px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
svg.i.sm { width: 14px; height: 14px; } svg.i.xs { width: 12px; height: 12px; }
:focus-visible { outline: 2px solid rgba(255,123,58,.55); outline-offset: 2px; border-radius: var(--r-sm); }
::-webkit-scrollbar { width: 10px; height: 10px; } ::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #1d1d1d; border-radius: 10px; border: 3px solid var(--bg); } ::-webkit-scrollbar-thumb:hover { background: #2a2a2a; }

/* ── layout ── */
.app { display: grid; grid-template-columns: var(--side) minmax(0, 1fr) var(--insp); height: 100dvh; }
.app.no-insp { grid-template-columns: var(--side) minmax(0, 1fr); }
.app.no-insp .insp { display: none; }
.side { background: var(--bg-1); border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; position: relative; }
.insp { background: var(--bg-1); border-left: 1px solid var(--line); overflow-y: auto; min-height: 0; }
.scroll { flex: 1; overflow-y: auto; overscroll-behavior: contain; scroll-behavior: auto; }
.content { max-width: 860px; margin: 0 auto; padding: 18px 28px 28px; }
.tabbar { display: none; }

/* ── sidebar ── */
.brand { display: flex; align-items: center; gap: 10px; padding: 16px 16px 12px; }
.mark { width: 26px; height: 26px; border-radius: 8px; display: grid; place-items: center; color: var(--accent-ink); font-weight: 800; font-size: 14px;
  background: linear-gradient(180deg, #ff9a5c, #ff6f2a); box-shadow: inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(0,0,0,.25), 0 2px 6px rgba(255,111,42,.25); }
.wordmark { font-weight: 700; letter-spacing: -.01em; font-size: 15px; }
.brand .led { margin-left: auto; }
.project { margin: 0 12px 12px; padding: 10px 12px; border-radius: var(--r); background: var(--surface); border: 1px solid var(--line); box-shadow: var(--edge); }
.project .pn { font-weight: 600; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.project .pb { display: flex; align-items: center; gap: 6px; color: var(--text-3); font-size: 12px; margin-top: 2px; }
.project .pb span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nav { padding: 0 8px; display: grid; gap: 1px; }
.nav button, .agent-link { display: flex; align-items: center; gap: 10px; width: 100%; border: 0; background: transparent; color: var(--text-2); padding: 7px 10px; border-radius: var(--r-sm); text-align: left; font-size: 13.5px; }
.nav button:hover, .agent-link:hover { background: var(--surface-2); color: var(--text); }
.nav button.on, .agent-link.on { background: var(--surface-3); color: var(--text); box-shadow: var(--edge); }
.nav .count { margin-left: auto; font-size: 11.5px; color: var(--text-3); }
.nav .count.hot { color: var(--accent-ink); background: var(--accent); padding: 0 6px; border-radius: 999px; font-weight: 700; min-width: 18px; text-align: center; box-shadow: inset 0 1px 0 rgba(255,255,255,.3); }
.side-h { display: flex; align-items: center; justify-content: space-between; padding: 16px 18px 6px; color: var(--text-4); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
.side-h button { border: 0; background: none; color: var(--text-3); padding: 2px; border-radius: var(--r-xs); } .side-h button:hover { color: var(--text); background: var(--surface-2); }
.agents-nav { flex: 1; overflow-y: auto; padding: 0 8px 8px; display: grid; gap: 1px; align-content: start; }
.agent-link { align-items: flex-start; padding: 7px 10px; }
.agent-link .led { margin-top: 6px; }
.agent-link .al { min-width: 0; flex: 1; }
.agent-link .an { display: flex; align-items: baseline; gap: 6px; }
.agent-link .an b { font-weight: 600; font-size: 13px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-link .an small { color: var(--text-4); font-size: 11.5px; white-space: nowrap; }
.agent-link .ad { display: block; color: var(--text-3); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-link .an { min-width: 0; }
.agent-link .tick { margin-left: auto; font-size: 11px; color: var(--text-4); }
.side-foot { border-top: 1px solid var(--line); padding: 12px 14px; display: grid; gap: 10px; }
.stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 6px 8px; box-shadow: var(--edge); min-width: 0; }
.stat b { display: block; font-size: 12.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.stat > span { font-size: 10.5px; color: var(--text-4); text-transform: uppercase; letter-spacing: .05em; }
.viewers { display: flex; align-items: center; gap: 6px; color: var(--text-3); font-size: 12px; }
.avatar { width: 20px; height: 20px; border-radius: 50%; display: inline-grid; place-items: center; font-size: 10px; font-weight: 700; background: var(--surface-3); color: var(--text-2);
  box-shadow: var(--edge), 0 0 0 2px var(--bg-1); }

/* ── LEDs: status lights with a touch of glow ── */
.led { width: 8px; height: 8px; border-radius: 50%; flex: none; display: inline-block; background: radial-gradient(circle at 35% 30%, #6a6a6a, #3a3a3a 60%, #2a2a2a);
  box-shadow: inset 0 0 0 1px rgba(0,0,0,.4); }
.led.ok, .led.ready { background: radial-gradient(circle at 35% 30%, #b8ffd9, var(--ok) 55%, #1f8f55); box-shadow: 0 0 6px rgba(63,217,138,.55); }
.led.busy, .led.starting { background: radial-gradient(circle at 35% 30%, #ffe2bd, var(--accent) 55%, #b4481a); box-shadow: 0 0 7px rgba(255,123,58,.6); animation: pulse 1.6s var(--ease) infinite; }
.led.awaiting_approval, .led.warn { background: radial-gradient(circle at 35% 30%, #fff0cc, var(--warn) 55%, #a86d14); box-shadow: 0 0 7px rgba(255,182,72,.6); animation: pulse 1.1s var(--ease) infinite; }
.led.error, .led.err { background: radial-gradient(circle at 35% 30%, #ffd0cf, var(--err) 55%, #9e2523); box-shadow: 0 0 7px rgba(255,93,90,.6); }
.led.exited { background: radial-gradient(circle at 35% 30%, #4a4a4a, #262626); box-shadow: none; }
.led.lg { width: 10px; height: 10px; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) { .led { animation: none !important; } }

/* ── controls ── */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 32px; padding: 0 12px; border-radius: var(--r-sm); font-weight: 550; font-size: 13px;
  color: var(--text); border: 1px solid var(--line-2); background: linear-gradient(180deg, #1b1b1b, #131313); box-shadow: var(--edge), var(--raise); white-space: nowrap;
  transition: background .12s, border-color .12s, transform .06s; }
.btn:hover { background: linear-gradient(180deg, #212121, #171717); border-color: var(--line-3); }
.btn:active { transform: translateY(.5px); box-shadow: var(--well); background: #111; }
.btn:disabled { opacity: .45; cursor: default; }
.btn.pri { color: var(--accent-ink); border-color: #ff8d52; background: linear-gradient(180deg, #ff9257, #f56a24); box-shadow: inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.6); }
.btn.pri:hover { background: linear-gradient(180deg, #ff9c66, #ff732e); }
.btn.go { color: #032012; border-color: #5ce39e; background: linear-gradient(180deg, #5be6a0, #2fc477); box-shadow: inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(0,0,0,.18), 0 1px 3px rgba(0,0,0,.6); }
.btn.go:hover { background: linear-gradient(180deg, #6aeeac, #35cf80); }
.btn.bad { color: var(--err); }
.btn.bad:hover { background: linear-gradient(180deg, #2a1312, #1c0d0c); border-color: rgba(255,93,90,.35); }
.btn.ghost { background: transparent; border-color: transparent; box-shadow: none; color: var(--text-2); }
.btn.ghost:hover { background: var(--surface-2); color: var(--text); }
.btn.sm { height: 26px; padding: 0 9px; font-size: 12px; border-radius: var(--r-xs); gap: 5px; }
.btn.icon { width: 32px; padding: 0; } .btn.sm.icon { width: 26px; }
kbd { font: 500 11px/1 var(--mono); color: var(--text-3); padding: 3px 5px; border-radius: 4px; background: var(--surface-2); border: 1px solid var(--line-2); box-shadow: inset 0 -1px 0 rgba(0,0,0,.6); }

/* the autonomy switch: a recessed track with a raised thumb */
.switch { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; padding: 3px; margin: 0 12px 10px; border-radius: var(--r); background: #050505; box-shadow: var(--well); }
.switch button { border: 0; background: transparent; color: var(--text-3); font-size: 12px; font-weight: 550; padding: 5px 0; border-radius: 7px; transition: color .12s, background .12s; }
.switch button:hover { color: var(--text); }
.switch button.on { color: var(--text); background: linear-gradient(180deg, #232323, #191919); box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 1px 2px rgba(0,0,0,.8); }
.switch button.on.yolo { color: #fff; background: linear-gradient(180deg, #ff6b67, #d63a37); }
.switch button.on.auto { color: var(--warn); }
.switch button.on.ask { color: var(--info); }

/* ── top bar of the main column ── */
.bar { height: var(--bar); flex: none; display: flex; align-items: center; gap: 12px; padding: 0 20px; border-bottom: 1px solid var(--line); background: rgba(0,0,0,.82);
  backdrop-filter: saturate(140%) blur(12px); position: relative; z-index: 3; }
.bar h1 { font-size: 15px; font-weight: 650; margin: 0; letter-spacing: -.01em; display: flex; align-items: center; gap: 9px; min-width: 0; }
.bar h1 span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bar .sub { color: var(--text-3); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.bar .acts { margin-left: auto; display: flex; gap: 6px; align-items: center; flex: none; }
.bar .back { display: none; }
.chip { display: inline-flex; align-items: center; gap: 5px; height: 22px; padding: 0 8px; border-radius: 999px; font-size: 11.5px; color: var(--text-2); background: var(--surface-2);
  border: 1px solid var(--line); white-space: nowrap; }
.chip.ok { color: var(--ok); background: var(--ok-soft); border-color: rgba(63,217,138,.18); }
.chip.warn { color: var(--warn); background: var(--warn-soft); border-color: rgba(255,182,72,.2); }
.chip.err { color: var(--err); background: var(--err-soft); border-color: rgba(255,93,90,.2); }
.chip.info { color: var(--info); background: var(--info-soft); border-color: rgba(103,183,255,.2); }
.chip.acc { color: var(--accent-2); background: var(--accent-soft); border-color: rgba(255,123,58,.22); }

.banner { display: flex; align-items: center; gap: 10px; padding: 8px 20px; font-size: 12.5px; color: var(--warn); background: var(--warn-soft); border-bottom: 1px solid rgba(255,182,72,.15); }

/* ── conversation ── */
.conv > * { min-width: 0; }
.blk { padding: 6px 0; }
.who { display: flex; align-items: center; gap: 8px; margin: 14px 0 6px; font-size: 12.5px; color: var(--text-3); }
.who b { color: var(--text); font-weight: 650; font-size: 13px; }
.who time { margin-left: auto; font-size: 11.5px; color: var(--text-4); }
.face { width: 22px; height: 22px; border-radius: 7px; display: grid; place-items: center; font-size: 11px; font-weight: 750; color: #000; flex: none;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.35), inset 0 -1px 0 rgba(0,0,0,.2); }
.msg { color: var(--text); font-size: 14.5px; line-height: 1.62; overflow-wrap: anywhere; }
.msg.clamp { max-height: 420px; overflow: hidden; position: relative; }
.msg.clamp::after { content: ""; position: absolute; inset: auto 0 0 0; height: 90px; background: linear-gradient(transparent, var(--bg)); pointer-events: none; }
.more { margin-top: 6px; }
.prompt { margin: 18px 0 8px; padding: 12px 14px; border-radius: var(--r-lg); background: linear-gradient(180deg, #141414, #0f0f0f); border: 1px solid var(--line-2); box-shadow: var(--edge), var(--raise); }
.prompt .ph { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-3); margin-bottom: 4px; }
.prompt .ph b { color: var(--accent-2); font-weight: 650; }
.prompt .pt { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14.5px; }
.thought { margin: 4px 0; }
.thought > button { display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; color: var(--text-3); font-size: 12.5px; padding: 3px 0; }
.thought > button:hover { color: var(--text-2); }
.thought .tb { margin: 4px 0 6px 2px; padding-left: 12px; border-left: 2px solid var(--surface-4); color: var(--text-3); font-size: 13.5px; font-style: italic; }
.thought .pv { color: var(--text-4); font-style: italic; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 520px; display: inline-block; vertical-align: bottom; }
.live { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; padding: 9px 12px; border-radius: var(--r); font-size: 13px; color: var(--text-2);
  background: linear-gradient(90deg, rgba(255,123,58,.07), transparent 70%); border: 1px solid rgba(255,123,58,.14); }
.live span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 12.5px; }
.note { display: flex; align-items: center; gap: 8px; color: var(--text-3); font-size: 12.5px; margin: 6px 0; }
.note::before, .note::after { content: ""; flex: 1; height: 1px; background: var(--line); }
.note span { max-width: 80%; text-align: center; overflow-wrap: anywhere; }
.alert { display: flex; gap: 10px; align-items: flex-start; margin: 8px 0; padding: 10px 12px; border-radius: var(--r); font-size: 13.5px; overflow-wrap: anywhere; }
.alert.err { background: var(--err-soft); border: 1px solid rgba(255,93,90,.2); color: #ffb3b1; }
.alert.warn { background: var(--warn-soft); border: 1px solid rgba(255,182,72,.2); color: #ffd99c; }
.alert svg { margin-top: 2px; }
.sep { display: flex; align-items: center; gap: 10px; margin: 22px 0 8px; color: var(--text-4); font-size: 11.5px; letter-spacing: .04em; }
.sep::after { content: ""; flex: 1; height: 1px; background: var(--line); }

/* handoffs: what agents send each other */
.ho { margin: 10px 0; border-radius: var(--r-lg); background: var(--surface); border: 1px solid var(--line); box-shadow: var(--edge); overflow: hidden; }
.ho-h { display: flex; align-items: center; gap: 8px; padding: 9px 12px; font-size: 12.5px; color: var(--text-3); flex-wrap: wrap; }
.ho-h b { color: var(--text); font-weight: 650; }
.ho-h .arrow { color: var(--text-4); }
.ho-h .chips { margin-left: auto; display: flex; gap: 5px; flex-wrap: wrap; }
.ho-b { padding: 0 12px 10px; font-size: 13.5px; }
.ho-b .msg { font-size: 13.5px; }
.ho.result.ok { border-color: rgba(63,217,138,.16); } .ho.result.failed { border-color: rgba(255,93,90,.22); }
.checks { display: grid; gap: 4px; padding: 0 12px 10px; }
.check { display: flex; align-items: center; gap: 8px; font-size: 12.5px; padding: 6px 9px; border-radius: var(--r-sm); background: #070707; box-shadow: var(--well); }
.check code { font-family: var(--mono); font-size: 12px; color: var(--text-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.check.ok svg { color: var(--ok); } .check.bad svg { color: var(--err); }

/* tool calls */
.tools { margin: 6px 0; border-radius: var(--r); border: 1px solid var(--line); background: var(--bg-2); overflow: hidden; }
.tools-h { display: flex; align-items: center; gap: 8px; width: 100%; border: 0; background: transparent; padding: 7px 10px; color: var(--text-3); font-size: 12.5px; text-align: left; }
.tools-h:hover { background: var(--surface); color: var(--text-2); }
.tools-h .chev { transition: transform .15s var(--ease); }
.tools.open > .tools-h .chev { transform: rotate(90deg); }
.tools-h .tsum { display: flex; gap: 6px; margin-left: auto; }
.tools-b { border-top: 1px solid var(--line); }
.tl { border-top: 1px solid var(--line); } .tl:first-child { border-top: 0; }
.tl-h { display: flex; align-items: center; gap: 9px; width: 100%; border: 0; background: transparent; padding: 6px 10px; text-align: left; min-height: 32px; color: var(--text-2); }
.tl-h:hover { background: var(--surface); }
.tl-h .ico { color: var(--text-3); }
.tl-verb { font-size: 13px; font-weight: 550; color: var(--text); white-space: nowrap; }
.tl-tgt { font-family: var(--mono); font-size: 12px; color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; flex: 1 1 auto; }
.tl-sum { font-size: 12px; color: var(--text-4); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 38%; flex: 0 1 auto; }
.tl-st { flex: none; display: grid; place-items: center; width: 16px; }
.tl-st.completed { color: var(--ok); } .tl-st.failed { color: var(--err); }
.tl.coord .tl-verb { color: var(--text-3); font-weight: 500; } .tl.coord .ico { color: var(--text-4); }
.tl.failed .tl-verb { color: #ffb3b1; }
.tl-b { padding: 2px 10px 10px 35px; }
.spin { width: 12px; height: 12px; border-radius: 50%; border: 1.6px solid rgba(255,123,58,.25); border-top-color: var(--accent); animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.term { position: relative; margin: 4px 0 0; border-radius: var(--r-sm); background: #030303; box-shadow: var(--well); }
.term pre { margin: 0; padding: 9px 11px; font: 12px/1.5 var(--mono); color: #cfcfcf; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; }
.term .tf { display: flex; align-items: center; gap: 8px; padding: 5px 8px 5px 11px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--text-4); }
.term .tf .btn { margin-left: auto; }
.diff { margin: 6px 0 0; border-radius: var(--r-sm); overflow: hidden; background: #030303; box-shadow: var(--well); }
.diff-h { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font: 12px var(--mono); color: var(--text-2); border-bottom: 1px solid var(--line); }
.diff-h .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.plus { color: var(--ok); } .minus { color: var(--err); }
.diff-l { font: 12px/1.5 var(--mono); max-height: 380px; overflow: auto; }
.diff-l div { display: flex; white-space: pre-wrap; overflow-wrap: anywhere; padding: 0 10px 0 0; }
.diff-l div::before { content: attr(data-s); flex: none; width: 22px; text-align: center; color: var(--text-4); user-select: none; }
.diff-l .a { background: rgba(63,217,138,.08); color: #c9f5dd; } .diff-l .a::before { color: var(--ok); }
.diff-l .d { background: rgba(255,93,90,.08); color: #ffcfcd; } .diff-l .d::before { color: var(--err); }
.diff-l .c { color: #8f8f8f; }
.diff-more { padding: 5px 10px; font-size: 11.5px; color: var(--text-4); border-top: 1px solid var(--line); }

/* markdown */
.md > :first-child { margin-top: 0; } .md > :last-child { margin-bottom: 0; }
.md p { margin: 0 0 10px; }
.md h3, .md h4, .md h5, .md h6 { margin: 18px 0 8px; font-weight: 650; letter-spacing: -.01em; line-height: 1.3; }
.md h3 { font-size: 18px; } .md h4 { font-size: 16px; } .md h5 { font-size: 14.5px; } .md h6 { font-size: 13px; color: var(--text-2); text-transform: uppercase; letter-spacing: .05em; }
.md ul, .md ol { margin: 0 0 10px; padding-left: 22px; } .md li { margin: 3px 0; } .md li > ul, .md li > ol { margin: 4px 0; }
.md li::marker { color: var(--text-4); }
.md li.task { list-style: none; margin-left: -20px; display: flex; gap: 8px; align-items: baseline; }
.md .box { width: 14px; height: 14px; border-radius: 4px; flex: none; display: inline-grid; place-items: center; font-size: 10px; transform: translateY(2px);
  background: #050505; box-shadow: var(--well); color: var(--ok); }
.md li.task.done { color: var(--text-3); }
.md code { font: 12.5px var(--mono); padding: 1px 5px; border-radius: 5px; background: var(--surface-3); border: 1px solid var(--line); color: #ffd0b5; overflow-wrap: anywhere; }
.md pre { position: relative; margin: 6px 0 12px; padding: 12px 14px; border-radius: var(--r); background: #030303; box-shadow: var(--well); overflow: auto; }
.md pre code { padding: 0; border: 0; background: none; color: #d6d6d6; font-size: 12.5px; line-height: 1.55; white-space: pre; overflow-wrap: normal; }
.md pre[data-lang]::before { content: attr(data-lang); position: absolute; top: 6px; right: 40px; font: 10.5px var(--mono); color: var(--text-4); text-transform: lowercase; }
.md pre .copy { position: absolute; top: 5px; right: 6px; opacity: 0; transition: opacity .12s; }
.md pre:hover .copy { opacity: 1; }
.md blockquote { margin: 6px 0 10px; padding: 2px 0 2px 12px; border-left: 2px solid var(--accent); color: var(--text-2); }
.md hr { border: 0; height: 1px; background: var(--line-2); margin: 14px 0; }
.md strong { font-weight: 650; color: #fff; } .md em { color: var(--text-2); } .md del { color: var(--text-4); }
.md .tbl { overflow-x: auto; margin: 6px 0 12px; border-radius: var(--r); border: 1px solid var(--line-2); }
.md table { border-collapse: collapse; width: 100%; font-size: 13px; }
.md th { text-align: left; font-weight: 600; color: var(--text-2); background: var(--surface-2); padding: 7px 10px; border-bottom: 1px solid var(--line-2); white-space: nowrap; }
.md td { padding: 6px 10px; border-top: 1px solid var(--line); vertical-align: top; }
.md tr:hover td { background: rgba(255,255,255,.015); }

/* ── cards (inbox, agents, changes) ── */
.h2 { display: flex; align-items: center; gap: 10px; margin: 6px 0 14px; }
.h2 h2 { font-size: 13px; font-weight: 600; margin: 0; color: var(--text-3); letter-spacing: .02em; }
.h2 .line { flex: 1; height: 1px; background: var(--line); }
.cards { display: grid; gap: 10px; }
.card { border-radius: var(--r-lg); background: linear-gradient(180deg, #121212, #0d0d0d); border: 1px solid var(--line); box-shadow: var(--edge), var(--raise); padding: 14px 16px; position: relative; }
.card.sel { border-color: rgba(255,123,58,.45); box-shadow: var(--edge), 0 0 0 3px rgba(255,123,58,.08); }
.card.click { cursor: pointer; transition: border-color .12s, background .12s; } .card.click:hover { border-color: var(--line-3); }
.card-k { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 650; letter-spacing: .05em; text-transform: uppercase; color: var(--text-3); }
.card-k .ago { margin-left: auto; text-transform: none; letter-spacing: 0; font-weight: 450; color: var(--text-4); }
.card h3 { margin: 6px 0 2px; font-size: 15px; font-weight: 600; letter-spacing: -.005em; line-height: 1.4; overflow-wrap: anywhere; }
.card .well { margin: 10px 0 0; padding: 10px 12px; border-radius: var(--r-sm); background: #040404; box-shadow: var(--well); font: 12.5px/1.5 var(--mono); color: var(--text-2);
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
.card .acts { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; align-items: center; }
.card .acts .hint { margin-left: auto; display: flex; gap: 4px; align-items: center; color: var(--text-4); font-size: 11.5px; }
.k-approval { color: var(--warn); } .k-plan { color: var(--violet); } .k-failed, .k-merge, .k-conflict, .k-budget { color: var(--err); }
.k-ready { color: var(--ok); } .k-stalled, .k-looping, .k-scope { color: var(--warn); }
.empty { text-align: center; color: var(--text-3); padding: 56px 20px; }
.empty .ei { width: 44px; height: 44px; margin: 0 auto 14px; border-radius: 14px; display: grid; place-items: center; color: var(--text-3);
  background: linear-gradient(180deg, #161616, #0e0e0e); border: 1px solid var(--line-2); box-shadow: var(--edge), var(--raise); }
.empty b { display: block; color: var(--text); font-weight: 600; font-size: 15px; margin-bottom: 4px; }

.agrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.ac-top { display: flex; align-items: center; gap: 10px; }
.ac-top b { font-weight: 650; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ac-top .st { margin-left: auto; font-size: 11.5px; color: var(--text-3); white-space: nowrap; }
.ac-meta { color: var(--text-3); font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ac-now { margin-top: 10px; font: 12px var(--mono); color: var(--text-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 6px 8px; border-radius: var(--r-xs); background: #060606; box-shadow: var(--well); }
.ac-stats { display: flex; gap: 12px; margin-top: 10px; font-size: 12px; color: var(--text-3); }
.meter { height: 4px; border-radius: 4px; background: #060606; box-shadow: var(--well); margin-top: 10px; overflow: hidden; }
.meter i { display: block; height: 100%; border-radius: 4px; background: linear-gradient(90deg, #ff6f2a, #ffa86c); }

.files { display: grid; grid-template-columns: minmax(0, 1fr); margin-top: 10px; border-radius: var(--r-sm); background: #050505; box-shadow: var(--well); overflow: hidden; }
.file { display: flex; align-items: center; gap: 10px; padding: 5px 10px; font: 12px var(--mono); border-top: 1px solid var(--line); }
.file:first-child { border-top: 0; }
.file .p { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); }
.file .p i { font-style: normal; color: var(--text-4); }
.file .num { flex: none; }

/* ── inspector ── */
.insp-s { padding: 16px; border-bottom: 1px solid var(--line); }
.insp-s h4 { margin: 0 0 10px; font-size: 11px; font-weight: 600; letter-spacing: .07em; text-transform: uppercase; color: var(--text-4); display: flex; align-items: center; gap: 8px; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; font-size: 12.5px; }
.kv dt { color: var(--text-3); } .kv dd { margin: 0; text-align: right; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tasks { display: grid; gap: 4px; }
.task { display: flex; gap: 9px; align-items: flex-start; font-size: 13px; padding: 6px 8px; border-radius: var(--r-sm); }
.task:hover { background: var(--surface); }
.task .tb2 { flex: 1; min-width: 0; } .task small { display: block; color: var(--text-4); font-size: 11.5px; }
.task .tick2 { margin-top: 3px; width: 14px; height: 14px; border-radius: 4px; flex: none; background: #050505; box-shadow: var(--well); display: grid; place-items: center; }
.task.done .tick2 { color: var(--ok); } .task.done .tb2 { color: var(--text-3); }
.task.running .tick2::after { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 6px var(--accent); }
.task.failed .tick2 { color: var(--err); }

/* ── composer ── */
.composer { flex: none; padding: 10px 20px 16px; background: linear-gradient(transparent, var(--bg) 22%); position: relative; z-index: 2; }
.cbox { max-width: 860px; margin: 0 auto; border-radius: var(--r-xl); background: #0a0a0a; border: 1px solid var(--line-2); box-shadow: var(--well), 0 10px 30px rgba(0,0,0,.6); transition: border-color .15s; }
.cbox:focus-within { border-color: rgba(255,123,58,.4); }
.cbox textarea { display: block; width: 100%; border: 0; outline: 0; resize: none; background: transparent; padding: 12px 14px 4px; font-size: 14.5px; line-height: 1.5; max-height: 220px; min-height: 46px; }
.cbox textarea::placeholder { color: var(--text-4); }
.crow { display: flex; align-items: center; gap: 8px; padding: 6px 8px 8px 10px; }
.to { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px; border-radius: 999px; font-size: 12px; color: var(--text-2); background: var(--surface-2); border: 1px solid var(--line); }
.to b { color: var(--text); font-weight: 600; }
.crow .grow { flex: 1; } .crow .hint { color: var(--text-4); font-size: 11.5px; display: flex; gap: 4px; align-items: center; }
.send { width: 32px; height: 32px; border-radius: 10px; }
.suggest { z-index: 6; position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(100% - 6px); width: min(860px, calc(100% - 40px)); max-height: 260px; overflow-y: auto; padding: 5px;
  border-radius: var(--r-lg); background: #111; border: 1px solid var(--line-2); box-shadow: var(--float); }
.sg { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: var(--r-sm); font-size: 13px; cursor: pointer; }
.sg.on, .sg:hover { background: var(--surface-3); }
.sg b { font-family: var(--mono); font-size: 12.5px; font-weight: 500; } .sg span { color: var(--text-3); font-size: 12.5px; }

.jump { position: absolute; left: 50%; bottom: 110px; transform: translateX(-50%); z-index: 4; }

/* ── palette, dialogs, toasts ── */
.scrim { position: fixed; inset: 0; background: rgba(0,0,0,.6); backdrop-filter: blur(3px); z-index: 20; display: flex; justify-content: center; align-items: flex-start; padding-top: 14vh; }
.pal { width: min(620px, calc(100vw - 32px)); border-radius: var(--r-xl); background: #0e0e0e; border: 1px solid var(--line-2); box-shadow: var(--float), var(--edge); overflow: hidden; }
.pal input { width: 100%; border: 0; outline: 0; background: transparent; padding: 15px 18px; font-size: 15px; border-bottom: 1px solid var(--line); }
.pal-l { max-height: 52vh; overflow-y: auto; padding: 6px; }
.pal-g { padding: 8px 10px 4px; font-size: 11px; color: var(--text-4); text-transform: uppercase; letter-spacing: .06em; }
.pal-i { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r-sm); font-size: 13.5px; color: var(--text-2); cursor: pointer; }
.pal-i.on { background: var(--surface-3); color: var(--text); box-shadow: var(--edge); }
.pal-i small { margin-left: auto; color: var(--text-4); font-size: 12px; }
.dlg { width: min(420px, calc(100vw - 32px)); border-radius: var(--r-xl); background: #0e0e0e; border: 1px solid var(--line-2); box-shadow: var(--float), var(--edge); padding: 22px; }
.dlg h3 { margin: 0 0 6px; font-size: 17px; } .dlg p { margin: 0 0 16px; color: var(--text-3); font-size: 13.5px; }
.field { width: 100%; height: 40px; padding: 0 12px; border-radius: var(--r); border: 1px solid var(--line-2); background: #050505; box-shadow: var(--well); outline: 0; font-size: 14px; }
.field:focus { border-color: rgba(255,123,58,.45); }
.dlg .acts { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
.toasts { position: fixed; right: 18px; bottom: 18px; display: grid; gap: 8px; z-index: 30; pointer-events: none; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; max-width: min(440px, calc(100vw - 36px)); padding: 10px 14px; border-radius: var(--r); font-size: 13px;
  background: #151515; border: 1px solid var(--line-2); box-shadow: var(--float), var(--edge); animation: rise .2s var(--ease); }
.toast.err { border-color: rgba(255,93,90,.3); color: #ffc1bf; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
.gate { min-height: 100dvh; display: grid; place-items: center; padding: 24px; }
.gate .card { max-width: 420px; text-align: center; padding: 28px; }
.gate .mark { margin: 0 auto 14px; width: 40px; height: 40px; border-radius: 12px; font-size: 20px; }

/* ── narrow screens: one column, tabs at the bottom ── */
@media (max-width: 1180px) { .app { grid-template-columns: var(--side) minmax(0, 1fr); } .insp { display: none; } }
@media (max-width: 820px) {
  body { font-size: 15px; }
  .app, .app.no-insp { grid-template-columns: minmax(0, 1fr); height: calc(100dvh - 58px - env(safe-area-inset-bottom)); }
  .side { display: none; }
  .app.menu .side { display: flex; position: fixed; inset: 0 0 calc(58px + env(safe-area-inset-bottom)) 0; z-index: 15; width: 100%; }
  .bar { padding: 0 12px; padding-top: env(safe-area-inset-top); height: calc(var(--bar) + env(safe-area-inset-top)); }
  .bar .back { display: inline-flex; }
  .bar { gap: 8px; }
  .bar h1 { flex: 1 1 auto; }
  .bar .sub { display: none; }
  .bar .acts .btn.sm { padding: 0 8px; }
  .content { padding: 12px 14px 20px; }
  .composer { padding: 8px 10px 10px; }
  .crow .hint { display: none; }
  .tabbar { display: grid; grid-template-columns: repeat(4, 1fr); position: fixed; left: 0; right: 0; bottom: 0; height: calc(58px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom); background: rgba(6,6,6,.94); backdrop-filter: blur(14px); border-top: 1px solid var(--line); z-index: 16; }
  .tabbar button { border: 0; background: none; color: var(--text-4); display: grid; place-items: center; align-content: center; gap: 3px; font-size: 10.5px; font-weight: 550; position: relative; }
  .tabbar button.on { color: var(--text); }
  .tabbar button.on svg { color: var(--accent); }
  .tabbar .dot { position: absolute; top: 8px; left: calc(50% + 6px); min-width: 16px; height: 16px; border-radius: 8px; padding: 0 4px; font-size: 10px; display: grid; place-items: center;
    background: var(--accent); color: var(--accent-ink); font-weight: 750; }
  .tl-sum { display: none; }
  .bar kbd, .bar [data-palette] { display: none; }
  .tl-b { padding-left: 10px; }
  .agrid { grid-template-columns: 1fr; }
  .toasts { left: 12px; right: 12px; bottom: calc(70px + env(safe-area-inset-bottom)); }
  .md pre .copy { opacity: 1; }
  .jump { bottom: 96px; }
}
`
