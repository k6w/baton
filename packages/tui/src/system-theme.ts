/** "system" theme: derived from the terminal's own palette (OSC 4/10/11), like OpenCode's. */
import { luminance, paletteTheme, type ResolvedTheme, resolveTheme } from "@batonsh/themes"

export function buildSystemTheme(colors: { palette: (string | null)[]; defaultForeground: string | null; defaultBackground: string | null }): ResolvedTheme {
  const p = (i: number, f: string) => colors.palette[i] ?? f
  const bg = colors.defaultBackground ?? p(0, "#000000")
  const fg = colors.defaultForeground ?? p(7, "#d0d0d0")
  const dark = luminance(bg) < 0.5
  const mix = (a: string, b: string, t: number) => {
    const h = (s: string) => [1, 3, 5].map((i) => Number.parseInt(s.slice(i, i + 2), 16))
    const [x, y] = [h(a), h(b)]
    return `#${x
      .map((v, i) =>
        Math.round(v + ((y[i] as number) - v) * t)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")}`
  }
  const file = paletteTheme({
    name: "system",
    appearance: dark ? "dark" : "light",
    bg,
    element: mix(bg, fg, 0.08),
    overlay: mix(bg, fg, 0.12),
    border: mix(bg, fg, 0.3),
    borderActive: fg,
    text: fg,
    muted: mix(fg, bg, 0.4),
    subtle: p(8, mix(fg, bg, 0.6)),
    primary: p(3, "#d7af5f"),
    secondary: p(5, "#af87d7"),
    accent: p(4, "#5f87d7"),
    red: p(1, "#d75f5f"),
    green: p(2, "#5fd75f"),
    yellow: p(3, "#d7d75f"),
    blue: p(4, "#5f87d7"),
    magenta: p(5, "#d75fd7"),
    cyan: p(6, "#5fd7d7"),
    orange: p(11, p(3, "#d7875f")),
  })
  return resolveTheme({ name: "system", source: "builtin", file }, dark ? "dark" : "light")
}
