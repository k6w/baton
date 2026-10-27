# Keybindings

Every action is a command with an id, and bindings are just data. To rebind, map ids to keys in `[keys]`:

```toml
[keys]
"app.palette" = ["ctrl+k"]
"pane.zoom" = ["z", "enter", "space"]
"toggle.icons" = "alt+i"            # commands without a default binding can get one
"app.shutdown" = []                 # unbind
```

Key syntax: modifiers `ctrl`, `alt` (`meta`, `option` and `cmd` are aliases) and `shift`, joined with `+`.
Avoid `ctrl+i`, `ctrl+m` and `ctrl+[`: terminals send them as Tab, Enter and Escape.
Names: letters, digits, symbols (`?`, `@`, `/`), `enter`, `escape`, `tab`, `space`, `backspace`, `up` /
`down` / `left` / `right`, `pageup` / `pagedown`, `home` / `end`, `f1`–`f12`.

**Contexts.** A binding is active in one context:
- `global`: everywhere. While you're typing, only bindings with modifier keys or special keys fire.
- `input`: the main input has focus.
- `grid`: an agent card has focus (press `tab`).
- `zoom`: one agent is zoomed.

The `?` overlay lists your current bindings and flags any conflicts.

| Command | Default | Context |
|---|---|---|
| `app.palette` | `ctrl+p`, `ctrl+k` | global |
| `app.help` | `?`, `f1` | grid |
| `app.quit` (stops all agents; `/quit` leaves them running) | `ctrl+c` ×2 | global |
| `app.shutdown` (stop daemon + agents) | `ctrl+q` | global |
| `inbox.open` (everything that needs you) / `approvals.allow` | `ctrl+a` / `ctrl+y` | global |
| `attention.next` (jump to the next ⚑) | `ctrl+n` | global |
| `settings.open` | `ctrl+s`, `f2` | global |
| `history.open` (past runs: resume, export) | `ctrl+r` | global |
| `costs.open` | `ctrl+e` | global |
| `guide.open`, `recipes.open`, `welcome.open` | (unbound; `/guide`, `/recipes`, `/welcome`) | global |
| `theme.pick` | `ctrl+t` | global |
| `style.pick` (style gallery), `toggle.background` | (unbound; `/style`, `/background`) | global |
| `autonomy.cycle` (normal → auto → YOLO → ask, every agent) | `shift+tab` | input |
| `autonomy.yolo` (toggle YOLO) | (unbound; `/yolo`) | global |
| `changes.open` (worker branches, diff, merge) | `ctrl+d` | global |
| `tasks.open` (task plan) | `ctrl+g` | global |
| `pane.diff` | `d` | grid |
| `layout.cycle` | `ctrl+l` | global |
| `focus.next` / `focus.prev` | `tab` / `shift+tab` | global |
| `focus.input` | `esc`, `i`, `/`, `@` | grid |
| `grid.left/right/up/down` | arrows, `hjkl` | grid |
| `grid.pageDown` / `grid.pageUp` | `pagedown` / `pageup` | global |
| `pane.peek` (peek & reply / answer its approval) | `space` | grid |
| `pane.zoom` | `z`, `enter` | grid |
| `pane.copyPath` (worktree path) | `o` | grid |
| `pane.message` | `m` (prefills `@name `) | grid |
| `pane.interrupt` / `pane.kill` | `x` / `shift+x` | grid |
| `zoom.close` | `escape`, `q`, `z` | zoom |
| `zoom.search` / `zoom.next` / `zoom.prev` | `/` / `n` / `shift+n` | zoom |
| `zoom.copy` / `zoom.copyAll` / `zoom.save` | `y` / `shift+y` / `w` | zoom |
| `zoom.top` / `zoom.bottom` | `g` / `shift+g` | zoom |
| `orch.interrupt` | `escape` (clears the input first) | input |
| `toggle.bus` / `toggle.thoughts` | `ctrl+b` / `ctrl+o` | global |
| `toggle.icons`, `toggle.border`, `toggle.look`, `toggle.density`, `toggle.animations` | (unbound; in the palette) | global |

In the approvals inbox: `a`/Enter allow once · `A` always allow · `d` deny · `D` always deny.
In Changes: Enter/`v` diff · `m` merge · `u` undo merge · `s` sync · `r` review.
In the inbox: `a`/`A`/`d`/`D` answer approvals, Enter jumps to anything else. In a peek: `a`/`d` answer, `r` reply, `z` zoom, `v` diff, `x` stop. In the diff view: `m` merge, Esc back.
In the task plan: `a` approve / `x` reject a proposed plan.
In the input: Tab completes `@names`, `/commands` and their arguments; ↑/↓ moves through history.
Mouse: click a card to focus it, double-click to zoom.
