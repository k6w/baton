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
| `app.quit` (agents keep running) | `ctrl+c` ×2 | global |
| `app.shutdown` (stop daemon + agents) | `ctrl+q` | global |
| `approvals.open` / `approvals.allow` | `ctrl+a` / `ctrl+y` | global |
| `theme.pick` | `ctrl+t` | global |
| `changes.open` (worker branches, diff, merge) | `ctrl+d` | global |
| `tasks.open` (task plan) | `ctrl+g` | global |
| `pane.diff` | `d` | grid |
| `layout.cycle` | `ctrl+l` | global |
| `focus.next` / `focus.prev` | `tab` / `shift+tab` | global |
| `focus.input` | `i`, `/`, `@` | grid |
| `grid.left/right/up/down` | arrows, `hjkl` | grid |
| `grid.pageDown` / `grid.pageUp` | `pagedown` / `pageup` | global |
| `pane.zoom` | `z`, `enter` | grid |
| `pane.message` | `m` (prefills `@name `) | grid |
| `pane.interrupt` / `pane.kill` | `x` / `shift+x` | grid |
| `zoom.close` | `escape`, `q`, `z` | zoom |
| `orch.interrupt` | `escape` (clears the input first) | input |
| `toggle.bus` / `toggle.thoughts` | `ctrl+b` / `ctrl+o` | global |
| `toggle.icons`, `toggle.border`, `toggle.look`, `toggle.density`, `toggle.animations` | (unbound; in the palette) | global |

In the approvals inbox: `a`/Enter allow once · `A` always allow · `d` deny · `D` always deny.
In Changes: Enter/`v` diff · `m` merge · `s` sync · `r` review. In the diff view: `m` merge, Esc back.
In the task plan: `a` approve / `x` reject a proposed plan.
In the input: Tab completes `@names`, `/commands` and their arguments; ↑/↓ moves through history.
Mouse: click a card to focus it, double-click to zoom.
