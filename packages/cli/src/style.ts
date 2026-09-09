/** Tiny ANSI helpers for plain CLI output (respects NO_COLOR / non-TTY). */
const on = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR === "1")
const wrap = (open: string, close: string) => (s: string) => (on ? `\x1b[${open}m${s}\x1b[${close}m` : s)

export const c = {
  bold: wrap("1", "22"),
  dim: wrap("2", "22"),
  italic: wrap("3", "23"),
  red: wrap("31", "39"),
  green: wrap("32", "39"),
  yellow: wrap("33", "39"),
  blue: wrap("34", "39"),
  magenta: wrap("35", "39"),
  cyan: wrap("36", "39"),
  hex: (hex: string) => (s: string) => {
    if (!on || !/^#[0-9a-f]{6}$/i.test(hex)) return s
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16))
    return `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m`
  },
}
