# Themes, styles & appearance

Baton separates **colors** (the theme) from **shapes** (the style). Any style works with any theme.

## Styles

`/style` (or settings → Looks → Style) opens a gallery: moving through it previews each style on the whole app and
in a miniature, Enter keeps it, Escape puts back exactly what you had.

| Style | Frames | Status bar | Background |
|---|---|---|---|
| `classic` (default) | rounded boxes, titles in the border | plain bar | theme |
| `modern` | filled title bars over raised panels | chips | theme |
| `minimal` | a title rule only | plain text | terminal |
| `accent` | a stripe in each agent's brand color | chips | theme |
| `tabs` | titles in filled tabs on single-line boxes | chips | theme |
| `neon` | heavy boxes glowing in each agent's color, tabbed titles | chips | theme |
| `retro` | double-line boxes, compact | plain bar | theme |
| `zen` | title rules, compact cards | plain text | terminal |

A style is a preset over these settings, each of which can be changed on its own (the style then shows as
`custom`):

| Setting | Options |
|---|---|
| `ui.frame` (`/frame`) | `line` boxes · `tab` titles in filled tabs · `bar` filled title bars · `minimal` title rule · `accent` colored stripe |
| `ui.border` | box lines for `line` / `tab` frames: `rounded single heavy double ascii none` |
| `ui.status_style` | `plain` bar · `blocks` (chips) · `powerline` (needs a Nerd / Powerline font) · `minimal` (text only) |
| `ui.background` (`/background`) | `theme`: Baton paints the theme background · `terminal`: no background at all — your terminal's color, transparency and blur show through |
| `ui.brand_borders` | tint every agent card with its brand color |
| `ui.spinner`, `ui.density` | as below |

`style = "modern"` in a config file is enough: style keys you don't set yourself follow the chosen style.

## Themes

Pick a theme live with `ctrl+t`: moving the selection previews the theme and Enter keeps it. You can also use
`/theme nord`, `baton theme set nord`, `[ui] theme = "nord"` or `BATON_THEME=nord`. `baton theme list` shows
them all with colour swatches.

**Built in:**
- `baton` (default) and `baton-light`
- Catppuccin: mocha, macchiato, frappé, latte
- Tokyo Night: night, storm, day
- Rosé Pine: main, moon, dawn
- Gruvbox: dark and light
- Nord, Dracula, Everforest
- Kanagawa: wave, dragon, lotus
- One Dark / One Light
- Solarized: dark and light
- GitHub: dark and light
- `high-contrast` and `mono`
- `system`: built from your terminal's own palette (read via OSC 4/10/11)

With `appearance = "auto"`, Baton asks the terminal whether its background is dark or light and switches to the
theme's counterpart if needed (for example mocha → latte).

## Theme files

Put JSON files in `~/.config/baton/themes/` or `<project>/.baton/themes/`. The file name is the theme name.
The format is OpenCode's, so **OpenCode themes work as-is**: Baton also reads `~/.config/opencode/themes/`.

```json
{
  "defs": { "ink": "#0f1117", "paper": "#e6e1cf", "ember": { "dark": "#ff8f40", "light": "#c2410c" } },
  "theme": {
    "background": "ink",
    "text": "paper",
    "primary": "ember",
    "agentClaude": "ember",
    "backgroundPanel": "none",
    "accent": 39
  }
}
```

A color value can be:
- a hex code
- a name from `defs`
- another token's name
- `{ "dark": …, "light": … }`
- an ANSI number from 0 to 255
- `"none"` (transparent)

Tokens you leave out fall back to Baton's default theme, so a theme can be three lines long.

**base16 / base24:** drop a scheme `.yaml` file (with `base00`…`base0F`) into the same folders. Hundreds of
schemes from [tinted-theming](https://github.com/tinted-theming/schemes) work this way.

## Tokens

| Group | Tokens |
|---|---|
| core | `primary secondary accent error warning success info text textMuted textSubtle` |
| surfaces | `background backgroundPanel backgroundElement backgroundOverlay border borderActive borderSubtle selection` |
| diffs | `diffAdded diffRemoved diffContext diffAddedBg diffRemovedBg diffLineNumber diffAddedLineNumberBg diffRemovedLineNumberBg` |
| agent states | `stateIdle stateBusy stateWaiting stateError stateDone spinner` |
| chrome | `statusBar statusText busTime busFrom busTo busBody mention toolName toolArgs thought` |
| agent brands | `agentClaude agentCodex agentOpencode agentGemini agentCursor agentCopilot agentAmp agentGoose agentQwen agentKiro agentDroid agentCline agentDefault` |

## Beyond colors

| Setting | Options |
|---|---|
| `ui.layout` (`ctrl+l`) | `grid`: orchestrator on top, agent cards and the bus below · `focus`: one agent zoomed · `swarm`: a one-line prompt and a dense grid · `wide`: orchestrator column on the left |
| `ui.border` | `rounded single heavy double ascii none` |
| `ui.icons` | `auto` (real logos when the terminal supports Kitty graphics or Sixel, otherwise Unicode) · `unicode` (✱ >_ ⌬ ✦ ◆ …) · `nerd` · `ascii` (`[CX]`) |
| `ui.render_style` | `native` (each agent looks like its own CLI: Claude `● Read(…)` / `⎿`, Codex `• Ran …` / `└`) · `unified` |
| `ui.spinner` | `star dots circle moon arc pulse bounce line diamond` |
| `ui.verbs` | your own spinner words (`Spelunking…`, `Wrangling…`) |
| `ui.density` | `comfy compact` |
| `ui.card_fields` | which fields an idle agent's card shows |
| `ui.status_left` / `ui.status_right` | format strings (see configuration.md) |
| `[agent_style.<adapter or name>]` | `icon`, `color`, `name_pattern` |

## Logos

Logos are drawn with the Kitty graphics protocol (kitty, Ghostty, WezTerm, Konsole, iTerm2, Warp) or Sixel
(foot, WezTerm, Windows Terminal, VS Code), as detected by OpenTUI. On other terminals Baton falls back to coloured glyphs.

Inside tmux, run `set -g allow-passthrough on` for logos to work. To turn logos off, set `BATON_NO_IMAGES=1` or `ui.icons = "unicode"`.
