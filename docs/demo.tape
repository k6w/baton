# Records docs/demo.gif with VHS (https://github.com/charmbracelet/vhs): vhs docs/demo.tape
# Needs `baton` on PATH (bun run build && export PATH="$PWD/dist:$PATH"). Simulated agents: no tokens.
Output dist/demo.gif
Set Shell "bash"
Set FontSize 15
Set Width 1400
Set Height 820
Set Padding 12
Set Theme "Catppuccin Mocha"
Env COLORTERM "truecolor"

Hide
Type "cd $(mktemp -d) && clear"
Enter
Show
Type `baton demo "add rate limiting to the login endpoint, with tests" --speed 2`
Sleep 400ms
Enter
Sleep 14s
# the inbox of everything that needs you
Ctrl+A
Sleep 2.5s
Escape
Sleep 1s
# the autonomy dial
Shift+Tab
Sleep 1.5s
Shift+Tab
Sleep 1.5s
# a different look
Type "/style neon"
Enter
Sleep 5s
Ctrl+C
Sleep 500ms
