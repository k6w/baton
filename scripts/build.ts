/**
 * Build standalone `baton` binaries with `bun build --compile`.
 *   bun scripts/build.ts                 # current platform → dist/baton
 *   bun scripts/build.ts --all           # every supported target → dist/baton-<target>
 */
import solidPlugin from "@opentui/solid/bun-plugin"

const TARGETS = ["bun-darwin-arm64", "bun-darwin-x64", "bun-linux-x64", "bun-linux-arm64", "bun-linux-x64-musl", "bun-windows-x64"] as const
const all = process.argv.includes("--all")
const host = `bun-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}` as (typeof TARGETS)[number]
const targets = all ? [...TARGETS] : [host]

for (const target of targets) {
  const outfile = all ? `dist/baton-${target.replace("bun-", "")}` : "dist/baton"
  const res = await Bun.build({
    entrypoints: ["./packages/cli/src/main.ts"],
    target: "bun",
    plugins: [solidPlugin],
    minify: true,
    sourcemap: "linked",
    define: { "process.env.BATON_BUILD": JSON.stringify(new Date().toISOString()) },
    // the binary must not pick up bunfig.toml / .env from whatever project it runs in
    compile: { target, outfile, autoloadBunfig: false, autoloadDotenv: false },
  })
  if (!res.success) {
    for (const l of res.logs) console.error(l)
    process.exit(1)
  }
  console.log(`built ${outfile}`)
}
