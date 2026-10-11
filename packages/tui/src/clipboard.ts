/**
 * Copy text: native clipboard tool when we're local (pbcopy / wl-copy / xclip), otherwise
 * OSC 52 through the terminal (works over SSH; tmux needs `set -g set-clipboard on`).
 */
import type { CliRenderer } from "@opentui/core"

export function copyText(renderer: CliRenderer | undefined, text: string): string {
  const remote = !!(process.env.SSH_TTY || process.env.SSH_CONNECTION)
  if (!remote) {
    const tools: string[][] =
      process.platform === "darwin"
        ? [["pbcopy"]]
        : process.platform === "win32"
          ? [["clip"]]
          : [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]
    for (const cmd of tools) {
      if (!Bun.which(cmd[0] as string)) continue
      try {
        const r = Bun.spawnSync(cmd, { windowsHide: true, stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore" })
        if (r.exitCode === 0) return cmd[0] as string
      } catch {}
    }
  }
  try {
    if (renderer?.copyToClipboardOSC52(text)) return "OSC 52"
  } catch {}
  return "nothing (no clipboard available)"
}
