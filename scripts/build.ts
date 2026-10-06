/**
 * Build standalone `baton` binaries with `bun build --compile`.
 *   bun scripts/build.ts                 # current platform → dist/baton
 *   bun scripts/build.ts --all           # every supported target → dist/baton-<target>
 *   bun scripts/build.ts --target linux-arm64
 *
 * Cross-compiling needs every platform's native TUI core: `bun install --os='*' --cpu='*'`.
 *
 * macOS binaries are re-signed after the bundle is appended (an invalid signature gets the
 * binary killed): ad-hoc by default, or with a Developer ID + hardened runtime when
 * BATON_CODESIGN_IDENTITY is set (then notarize: see .github/workflows/release.yml).
 */
import { existsSync } from "node:fs"
import solidPlugin from "@opentui/solid/bun-plugin"

/** name → bun target. darwin-x64 uses the baseline build so it also runs under Rosetta (no AVX). */
const TARGETS: Record<string, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64-baseline",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "linux-x64-musl": "bun-linux-x64-musl",
  "windows-x64": "bun-windows-x64",
}
const argv = process.argv.slice(2)
const pick = argv.includes("--target") ? argv[argv.indexOf("--target") + 1] : undefined
const host = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`
const names = argv.includes("--all") ? Object.keys(TARGETS) : pick ? pick.split(",") : [host]

let failed = 0
for (const name of names) {
  const target = TARGETS[name]
  if (!target) throw new Error(`unknown target ${name} (${Object.keys(TARGETS).join(", ")})`)
  const single = !argv.includes("--all") && !pick
  const outfile = single ? "dist/baton" : `dist/baton-${name}`
  const res = await Bun.build({
    entrypoints: ["./packages/cli/src/main.ts"],
    target: "bun",
    plugins: [solidPlugin],
    minify: true,
    sourcemap: "linked",
    define: { "process.env.BATON_BUILD": JSON.stringify(new Date().toISOString()), "process.env.BATON_TARGET": JSON.stringify(name) },
    // the binary must not pick up bunfig.toml / .env from whatever project it runs in
    compile: { target: target as Bun.Build.Target, outfile, autoloadBunfig: false, autoloadDotenv: false },
  }).catch((e: unknown) => ({ success: false as const, logs: [e] }))
  if (!res.success) {
    for (const l of res.logs) console.error(l)
    console.error(`✗ ${name}${/Could not resolve: "@opentui\/core-/.test(String(res.logs)) ? " — run: bun install --os='*' --cpu='*'" : ""}`)
    failed++
    continue
  }
  if (name.startsWith("darwin")) sign(outfile)
  console.log(`built ${outfile}`)
}
if (failed) process.exit(1)

function sign(file: string) {
  if (process.platform !== "darwin" || !Bun.which("codesign")) {
    console.warn(`  ${file}: not signed (codesign needs macOS) — sign it on a Mac before shipping`)
    return
  }
  const id = process.env.BATON_CODESIGN_IDENTITY
  const args = id
    ? ["--force", "--sign", id, "--options", "runtime", "--timestamp", "--entitlements", "packaging/macos/entitlements.plist", file]
    : ["--force", "--sign", "-", file]
  const p = Bun.spawnSync(["codesign", ...args], { stderr: "pipe" })
  if (p.exitCode !== 0) throw new Error(`codesign ${file}: ${p.stderr.toString()}`)
  if (!existsSync(file)) throw new Error(`${file} vanished`)
  console.log(`  signed ${id ? `(${id})` : "(ad-hoc)"}`)
}
